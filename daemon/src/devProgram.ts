import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { DevKeyInfo, DevStatus } from "@ide/shared";
import { currentPeriod } from "./usage.js";

/**
 * Developer-program store — waitlist state, card-on-file, and pay-per-use API
 * keys. Mirrors UsageStore's persistence shape: the in-memory map is the live
 * source of truth, lazily hydrated per user and debounce-flushed to Firestore
 * (collection `neondeck_dev`, one doc per user). Without Firestore it falls
 * back to a JSON file at `<metaDir>/dev.json` (local dev; wiped on diskless).
 *
 * SECURITY: only the sha256 of an API key is ever stored. The plaintext exists
 * once — inside the dev_key_created reply — and is never logged. Key lookup
 * for the public API goes through a separate index collection
 * `neondeck_dev_keys/{sha256hex} -> {userId, keyId, revoked}` so auth is one
 * doc get, written SYNCHRONOUSLY at create/revoke (auth correctness can't ride
 * the debounce).
 */

const DEV_COLLECTION = "neondeck_dev";
const DEV_KEYS_COLLECTION = "neondeck_dev_keys";

/** Ceiling on active (un-revoked) keys per developer. */
export const MAX_ACTIVE_KEYS = 5;

/** Re-write lastUsedAt at most this often (it's cosmetic; don't spam writes). */
const LAST_USED_THROTTLE_MS = 5 * 60_000;

interface DevKeyRecord extends DevKeyInfo {
  /** sha256 hex of the full plaintext key. */
  hash: string;
}

export interface DevRecord {
  status: "waitlist" | "accepted";
  email: string;
  registeredAt: number;
  acceptedAt?: number;
  /** Set only after the acceptance email got a 2xx from Resend. */
  emailSent?: boolean;
  cardOnFile: boolean;
  stripeCustomerId?: string;
  stripeApiSubId?: string;
  billInIde: boolean;
  keys: DevKeyRecord[];
  /** Cumulative metered-API usage. All-time totals + a current-month bucket
   *  (reset when `usagePeriod` rolls over) so the dev panel can show spend. */
  usageInput?: number;
  usageOutput?: number;
  usagePeriod?: string; // "YYYY-MM" the month buckets below belong to
  usageMonthInput?: number;
  usageMonthOutput?: number;
  updatedAt: number;
}

interface KeyIndexEntry {
  userId: string;
  keyId: string;
  revoked: boolean;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export class DevStore {
  private file: string | null = null;
  private users = new Map<string, DevRecord>();
  /** sha256hex -> index entry; warm cache in front of the Firestore index. */
  private keyIndex = new Map<string, KeyIndexEntry>();
  private fs: Firestore | null;
  private loaded = new Set<string>();
  private pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUsedWrites = new Map<string, number>(); // keyId -> last write ms

  constructor(metaDir: string, opts: { firestore?: Firestore | null } = {}) {
    this.fs = opts.firestore ?? null;
    if (!this.fs) {
      fs.mkdirSync(metaDir, { recursive: true });
      this.file = path.join(metaDir, "dev.json");
      this.load();
    }
  }

  /** Hydrate a user's record from Firestore once (no-op in file mode). */
  async ensureLoaded(userId: string): Promise<void> {
    if (!this.fs || this.loaded.has(userId)) return;
    this.loaded.add(userId); // mark first so concurrent calls don't double-fetch
    try {
      const snap = await this.fs.collection(DEV_COLLECTION).doc(userId).get();
      if (snap.exists) {
        const rec = snap.data() as DevRecord;
        this.users.set(userId, rec);
        for (const k of rec.keys ?? []) {
          this.keyIndex.set(k.hash, { userId, keyId: k.id, revoked: k.revoked });
        }
      }
    } catch (err) {
      this.loaded.delete(userId); // retry on the next connect
      console.warn(`[dev] Firestore load failed for ${userId}:`, (err as Error).message);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        users?: Record<string, DevRecord>;
      };
      for (const [userId, rec] of Object.entries(parsed.users ?? {})) {
        this.users.set(userId, rec);
        for (const k of rec.keys ?? []) {
          this.keyIndex.set(k.hash, { userId, keyId: k.id, revoked: k.revoked });
        }
      }
    } catch {
      /* fresh store */
    }
  }

  private save(userId: string): void {
    const rec = this.users.get(userId);
    if (rec) rec.updatedAt = Date.now();
    if (this.fs) {
      this.pending.add(userId);
      this.scheduleFlush();
      return;
    }
    if (!this.file) return;
    try {
      const users: Record<string, DevRecord> = {};
      for (const [id, r] of this.users) users[id] = r;
      fs.writeFileSync(this.file, JSON.stringify({ users }, null, 2), "utf8");
    } catch (err) {
      console.warn("[dev] could not persist store:", (err as Error).message);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 2000);
    this.flushTimer.unref?.();
  }

  /** Flush pending per-user changes to Firestore. Safe to call on shutdown. */
  async flush(): Promise<void> {
    if (!this.fs || this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending.clear();
    await Promise.all(
      ids.map(async (userId) => {
        const rec = this.users.get(userId);
        if (!rec) return;
        try {
          await this.fs!.collection(DEV_COLLECTION).doc(userId).set(rec, { merge: true });
        } catch (err) {
          this.pending.add(userId); // retry on the next flush
          console.warn(`[dev] Firestore write failed for ${userId}:`, (err as Error).message);
        }
      }),
    );
  }

  /** The client-facing view (never includes key hashes). Absent record → "none". */
  statusFor(userId: string): DevStatus {
    const rec = this.users.get(userId);
    if (!rec) return { status: "none", cardOnFile: false, billInIde: false, keyCount: 0 };
    const keys: DevKeyInfo[] = (rec.keys ?? []).map(({ hash: _hash, ...info }) => info);
    // The month bucket is only meaningful if it belongs to the current month.
    const thisMonth = rec.usagePeriod === currentPeriod();
    return {
      status: rec.status,
      cardOnFile: rec.cardOnFile,
      billInIde: rec.billInIde,
      keyCount: keys.filter((k) => !k.revoked).length,
      registeredAt: rec.registeredAt,
      keys,
      usageInputTokens: rec.usageInput ?? 0,
      usageOutputTokens: rec.usageOutput ?? 0,
      usageMonthInputTokens: thisMonth ? (rec.usageMonthInput ?? 0) : 0,
      usageMonthOutputTokens: thisMonth ? (rec.usageMonthOutput ?? 0) : 0,
    };
  }

  /**
   * Accumulate metered-API token usage for a developer (called after every
   * billed run — the public API path and the in-IDE "bill to my key" path). Keeps
   * an all-time total plus a current-calendar-month bucket that auto-resets when
   * the month rolls over. Cost is derived from these client-side via apiCostUsd.
   */
  recordUsage(userId: string, input: number, output: number): void {
    const rec = this.users.get(userId);
    if (!rec) return;
    const inTok = Math.max(0, Math.round(input || 0));
    const outTok = Math.max(0, Math.round(output || 0));
    if (inTok + outTok === 0) return;
    rec.usageInput = (rec.usageInput ?? 0) + inTok;
    rec.usageOutput = (rec.usageOutput ?? 0) + outTok;
    const period = currentPeriod();
    if (rec.usagePeriod !== period) {
      rec.usagePeriod = period;
      rec.usageMonthInput = 0;
      rec.usageMonthOutput = 0;
    }
    rec.usageMonthInput = (rec.usageMonthInput ?? 0) + inTok;
    rec.usageMonthOutput = (rec.usageMonthOutput ?? 0) + outTok;
    this.save(userId);
  }

  /** Join the waitlist. Idempotent — re-registering never resets the clock. */
  register(userId: string, email: string): DevStatus {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        status: "waitlist",
        email,
        registeredAt: Date.now(),
        cardOnFile: false,
        billInIde: false,
        keys: [],
        updatedAt: Date.now(),
      });
      this.save(userId);
    }
    return this.statusFor(userId);
  }

  /**
   * Users whose waitlist wait is up (registeredAt <= cutoff). Read-only — the
   * caller accepts + emails them one at a time so a failure mid-batch retries.
   * Firestore mode queries ONLY on status (single-field auto-index; the time
   * filter happens in memory so no composite index is ever needed).
   */
  async dueForAcceptance(cutoffMs: number): Promise<Array<{ userId: string; email: string }>> {
    const due: Array<{ userId: string; email: string }> = [];
    if (this.fs) {
      try {
        const snap = await this.fs
          .collection(DEV_COLLECTION)
          .where("status", "==", "waitlist")
          .limit(200)
          .get();
        for (const doc of snap.docs) {
          const rec = doc.data() as DevRecord;
          // Hydrate into memory so markAccepted works on the live copy.
          if (!this.users.has(doc.id)) {
            this.users.set(doc.id, rec);
            this.loaded.add(doc.id);
          }
          const live = this.users.get(doc.id)!;
          if (live.status === "waitlist" && live.registeredAt <= cutoffMs) {
            due.push({ userId: doc.id, email: live.email });
          }
        }
      } catch (err) {
        console.warn("[dev] waitlist query failed:", (err as Error).message);
      }
      return due;
    }
    for (const [userId, rec] of this.users) {
      if (rec.status === "waitlist" && rec.registeredAt <= cutoffMs) {
        due.push({ userId, email: rec.email });
      }
    }
    return due;
  }

  markAccepted(userId: string): void {
    const rec = this.users.get(userId);
    if (!rec || rec.status === "accepted") return;
    rec.status = "accepted";
    rec.acceptedAt = Date.now();
    this.save(userId);
  }

  markEmailSent(userId: string): void {
    const rec = this.users.get(userId);
    if (!rec) return;
    rec.emailSent = true;
    this.save(userId);
  }

  emailAlreadySent(userId: string): boolean {
    return this.users.get(userId)?.emailSent === true;
  }

  /** Card checkout completed (webhook or mock) — metered billing is live. */
  setCard(userId: string, ids: { customerId?: string; subscriptionId?: string }): void {
    const rec = this.users.get(userId);
    if (!rec) return;
    rec.cardOnFile = true;
    if (ids.customerId) rec.stripeCustomerId = ids.customerId;
    if (ids.subscriptionId) rec.stripeApiSubId = ids.subscriptionId;
    this.save(userId);
  }

  /** API subscription gone (cancelled/failed) — also drop the in-IDE toggle so
   *  nothing tries to bill a dead subscription. */
  clearCard(userId: string): void {
    const rec = this.users.get(userId);
    if (!rec) return;
    rec.cardOnFile = false;
    rec.billInIde = false;
    this.save(userId);
  }

  setBillInIde(userId: string, on: boolean): void {
    const rec = this.users.get(userId);
    if (!rec) return;
    rec.billInIde = on;
    this.save(userId);
  }

  /** True when the in-IDE agent should bill to the metered API subscription. */
  billInIdeActive(userId: string): boolean {
    const rec = this.users.get(userId);
    return rec?.status === "accepted" && rec.cardOnFile && rec.billInIde;
  }

  customerIdFor(userId: string): string | null {
    return this.users.get(userId)?.stripeCustomerId ?? null;
  }

  /**
   * Mint a key. Plaintext `ndk_<32 url-safe chars>` (192 bits) is returned ONCE;
   * only its sha256 is kept. The lookup-index doc is written SYNCHRONOUSLY —
   * if that write fails the key is not issued (auth must never trail state).
   */
  async createKey(userId: string, label?: string): Promise<{ plaintext: string; key: DevKeyInfo }> {
    const rec = this.users.get(userId);
    if (!rec) throw new Error("Not registered as a developer.");
    const active = rec.keys.filter((k) => !k.revoked).length;
    if (active >= MAX_ACTIVE_KEYS) {
      throw new Error(`Key limit reached (${MAX_ACTIVE_KEYS} active). Revoke one first.`);
    }
    const plaintext = `ndk_${crypto.randomBytes(24).toString("base64url")}`;
    const hash = sha256Hex(plaintext);
    const key: DevKeyRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      hash,
      prefix: plaintext.slice(0, 12),
      ...(label ? { label } : {}),
      createdAt: Date.now(),
      revoked: false,
    };
    if (this.fs) {
      await this.fs
        .collection(DEV_KEYS_COLLECTION)
        .doc(hash)
        .set({ userId, keyId: key.id, revoked: false } satisfies KeyIndexEntry);
    }
    rec.keys.push(key);
    this.keyIndex.set(hash, { userId, keyId: key.id, revoked: false });
    this.save(userId);
    const { hash: _hash, ...info } = key;
    return { plaintext, key: info };
  }

  /** Revoke a key — flips the user record AND the auth index (awaited). */
  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const rec = this.users.get(userId);
    const key = rec?.keys.find((k) => k.id === keyId);
    if (!rec || !key || key.revoked) return false;
    if (this.fs) {
      try {
        await this.fs.collection(DEV_KEYS_COLLECTION).doc(key.hash).set(
          { userId, keyId, revoked: true } satisfies KeyIndexEntry,
        );
      } catch (err) {
        console.warn("[dev] key index revoke failed:", (err as Error).message);
        return false; // don't report revoked while the index still accepts it
      }
    }
    key.revoked = true;
    this.keyIndex.set(key.hash, { userId, keyId, revoked: true });
    this.save(userId);
    return true;
  }

  /**
   * Resolve a presented API key to its owner. sha256 the plaintext, look the
   * hash up (memory cache, then the Firestore index), then confirm against the
   * user's record with a timing-safe compare. Revoked/unknown → null.
   */
  async resolveKey(plaintext: string): Promise<{ userId: string; keyId: string } | null> {
    if (!plaintext.startsWith("ndk_") || plaintext.length < 20) return null;
    const hash = sha256Hex(plaintext);
    let entry = this.keyIndex.get(hash) ?? null;
    if (!entry && this.fs) {
      try {
        const snap = await this.fs.collection(DEV_KEYS_COLLECTION).doc(hash).get();
        if (snap.exists) {
          entry = snap.data() as KeyIndexEntry;
          this.keyIndex.set(hash, entry);
        }
      } catch (err) {
        console.warn("[dev] key lookup failed:", (err as Error).message);
        return null;
      }
    }
    if (!entry || entry.revoked) return null;
    await this.ensureLoaded(entry.userId);
    const key = this.users.get(entry.userId)?.keys.find((k) => k.id === entry!.keyId);
    if (!key || key.revoked) return null;
    const a = Buffer.from(key.hash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { userId: entry.userId, keyId: entry.keyId };
  }

  /** Stamp lastUsedAt, throttled — cosmetic metadata, not worth a write per call. */
  touchLastUsed(userId: string, keyId: string): void {
    const now = Date.now();
    if (now - (this.lastUsedWrites.get(keyId) ?? 0) < LAST_USED_THROTTLE_MS) return;
    const key = this.users.get(userId)?.keys.find((k) => k.id === keyId);
    if (!key) return;
    this.lastUsedWrites.set(keyId, now);
    key.lastUsedAt = now;
    this.save(userId);
  }
}
