import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getTier, FREE_DAILY_TOKEN_CAP, type Tier, type UsageSnapshot } from "@ide/shared";

/**
 * A per-call metering handle handed to the agent / inline-AI so they can charge
 * tokens and learn when the monthly pool is spent. Built by the server.
 */
export interface Meter {
  tier: Tier;
  /** Already over the pool (monthly OR the hidden daily cap)? Callers should not
   *  start new model work. */
  isOver(): boolean;
  /** The paywall copy to show when over — generic "usage-based pricing" for the
   *  daily throttle (no numbers), or the monthly message. */
  paywallMessage(): string;
  /** Charge consumed tokens; returns (and broadcasts) the fresh snapshot. */
  record(tokens: number): UsageSnapshot;
}

/**
 * Per-user subscription tier + monthly token metering (Feature 1).
 *
 * DURABLE STORE: when a Firestore handle is supplied (production — a service
 * account is configured), each user's slice is lazily loaded from Firestore on
 * connect and writes are debounced back to it, so the monthly token limiter
 * SURVIVES Render's diskless redeploys. Without Firestore (local dev) it falls
 * back to a JSON ledger at `<projectsRoot>/.ide-meta/ledger.json`. Stripe (or the
 * mock fallback) updates `accounts[userId].tier`; agent calls increment
 * `usage[userId][period]`. The in-memory `data` is always the live source of
 * truth for the running process; the backing store is its durable mirror.
 */

interface Account {
  tier: Tier;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

interface Ledger {
  accounts: Record<string, Account>;
  usage: Record<string, Record<string, number>>; // userId -> period (YYYY-MM) -> tokens
  usageDaily: Record<string, Record<string, number>>; // userId -> day (YYYY-MM-DD) -> tokens
}

export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** UTC calendar day, e.g. "2026-06-22" — the bucket for the hidden Free daily cap. */
export function currentDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Firestore collection holding one usage doc per user. */
const USAGE_COLLECTION = "neondeck_usage";

/** Keep a bucket map bounded: retain only the N most recent keys (sorted desc). */
function pruneRecent(map: Record<string, number>, keep: number): Record<string, number> {
  const keys = Object.keys(map).sort().reverse().slice(0, keep);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = map[k];
  return out;
}

export class UsageStore {
  private file: string | null = null;
  private data: Ledger = { accounts: {}, usage: {}, usageDaily: {} };
  private fs: Firestore | null;
  private loaded = new Set<string>(); // userIds hydrated from Firestore
  private pending = new Set<string>(); // userIds with un-flushed changes
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(metaDir: string, opts: { firestore?: Firestore | null } = {}) {
    this.fs = opts.firestore ?? null;
    if (!this.fs) {
      // Local-dev fallback: a JSON ledger on disk (wiped on a diskless host —
      // which is exactly why production supplies Firestore instead).
      fs.mkdirSync(metaDir, { recursive: true });
      this.file = path.join(metaDir, "ledger.json");
      this.load();
    }
  }

  /** Pull a user's durable usage into memory once (Firestore mode). Call before
   *  the first read for a user (e.g. on hello) so we don't serve a stale 0. */
  async ensureLoaded(userId: string): Promise<void> {
    if (!this.fs || this.loaded.has(userId)) return;
    this.loaded.add(userId); // mark first so concurrent calls don't double-fetch
    try {
      const snap = await this.fs.collection(USAGE_COLLECTION).doc(userId).get();
      if (snap.exists) {
        const d = snap.data() ?? {};
        if (d.account) this.data.accounts[userId] = d.account;
        this.data.usage[userId] = d.monthly ?? {};
        this.data.usageDaily[userId] = d.daily ?? {};
      }
    } catch (err) {
      this.loaded.delete(userId); // allow a retry on the next connect
      console.warn(`[usage] Firestore load failed for ${userId}:`, (err as Error).message);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        accounts: parsed.accounts ?? {},
        usage: parsed.usage ?? {},
        usageDaily: parsed.usageDaily ?? {},
      };
    } catch {
      /* fresh ledger */
    }
  }

  /** Persist a user's changes. Firestore: debounced flush. File: write the ledger. */
  private save(userId: string): void {
    if (this.fs) {
      this.pending.add(userId);
      this.scheduleFlush();
      return;
    }
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch (err) {
      console.warn("[usage] could not persist ledger:", (err as Error).message);
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

  /** Flush all pending per-user changes to Firestore. Safe to call on shutdown. */
  async flush(): Promise<void> {
    if (!this.fs || this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending.clear();
    await Promise.all(
      ids.map(async (userId) => {
        try {
          await this.fs!.collection(USAGE_COLLECTION).doc(userId).set(
            {
              account: this.data.accounts[userId] ?? { tier: 0 },
              monthly: pruneRecent(this.data.usage[userId] ?? {}, 3),
              daily: pruneRecent(this.data.usageDaily[userId] ?? {}, 5),
              updatedAt: Date.now(),
            },
            { merge: true },
          );
        } catch (err) {
          this.pending.add(userId); // retry on the next flush
          console.warn(`[usage] Firestore write failed for ${userId}:`, (err as Error).message);
        }
      }),
    );
  }

  /** Resolve the effective tier. Dev mode forces the configured dev tier. */
  tierFor(userId: string, opts: { devTier?: Tier } = {}): Tier {
    // A stored ledger tier always wins; devTier is only the INITIAL fallback for a
    // brand-new account, so dev/loopback plan changes actually persist (and a real
    // user, who never passes devTier, simply reads the ledger or defaults to Free).
    const stored = this.data.accounts[userId]?.tier;
    if (stored !== undefined) return stored;
    return opts.devTier ?? 0;
  }

  setTier(userId: string, tier: Tier, stripe?: { customerId?: string; subscriptionId?: string }): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.tier = tier;
    if (stripe?.customerId) acct.stripeCustomerId = stripe.customerId;
    if (stripe?.subscriptionId) acct.stripeSubscriptionId = stripe.subscriptionId;
    this.save(userId);
  }

  /** Find the userId that owns a Stripe customer id (for webhook updates). */
  userByCustomer(customerId: string): string | null {
    for (const [userId, acct] of Object.entries(this.data.accounts)) {
      if (acct.stripeCustomerId === customerId) return userId;
    }
    return null;
  }

  /** The Stripe subscription id stored for a user (for downgrade/cancel). */
  getSubscriptionId(userId: string): string | null {
    return this.data.accounts[userId]?.stripeSubscriptionId ?? null;
  }

  tokensUsed(userId: string, period = currentPeriod()): number {
    return this.data.usage[userId]?.[period] ?? 0;
  }

  /** Add tokens to the current month AND day buckets, then persist. Returns the
   *  new monthly total. */
  addTokens(userId: string, n: number, period = currentPeriod()): number {
    if (n <= 0) return this.tokensUsed(userId, period);
    const forUser = (this.data.usage[userId] ??= {});
    forUser[period] = (forUser[period] ?? 0) + n;
    const day = currentDay();
    const forUserDaily = (this.data.usageDaily[userId] ??= {});
    forUserDaily[day] = (forUserDaily[day] ?? 0) + n;
    this.save(userId);
    return forUser[period];
  }

  /** Admin override: set a user's CURRENT-month usage to an absolute value (e.g.
   *  from a text input, or to the tier limit to "max out"/hit their limit). */
  setMonthlyTokens(userId: string, n: number, period = currentPeriod()): void {
    const forUser = (this.data.usage[userId] ??= {});
    forUser[period] = Math.max(0, Math.floor(n));
    this.save(userId);
  }

  /** Tokens charged to a user today (UTC) — backs the hidden Free daily cap. */
  tokensUsedToday(userId: string, day = currentDay()): number {
    return this.data.usageDaily[userId]?.[day] ?? 0;
  }

  /** Free plan only: has the user hit the hidden daily allowance? */
  isDailyThrottled(userId: string, tier: Tier): boolean {
    return tier === 0 && this.tokensUsedToday(userId) >= FREE_DAILY_TOKEN_CAP;
  }

  snapshot(userId: string, tier: Tier): UsageSnapshot {
    const period = currentPeriod();
    const tokensUsed = this.tokensUsed(userId, period);
    const tokensLimit = getTier(tier).tokenLimit;
    return {
      tier,
      tokensUsed,
      tokensLimit,
      period,
      limitReached: tokensUsed >= tokensLimit,
    };
  }

  isOverLimit(userId: string, tier: Tier): boolean {
    return this.tokensUsed(userId) >= getTier(tier).tokenLimit;
  }
}
