import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import {
  getTier,
  dynamicTokenLimit,
  FREE_DAILY_TOKEN_CAP,
  FREE_PUBLISH_TRIAL_MS,
  type Tier,
  type UsageSnapshot,
} from "@ide/shared";

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
  /** Charge consumed tokens; returns (and broadcasts) the fresh snapshot.
   *  `split` breaks the total into prompt vs completion tokens — Sparks meters
   *  ignore it, but API-billed meters need it (input and output are priced
   *  differently on the metered Stripe subscription). */
  record(tokens: number, split?: { input: number; output: number }): UsageSnapshot;
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
  /** Admin-set custom monthly token limit; overrides the tier default when set. */
  limitOverride?: number | null;
  /** Admin suspension: when true the user is locked out with `suspendMessage`. */
  suspended?: boolean;
  suspendMessage?: string;
  /** False for an unappealable ban (severe policy violation). Undefined = appealable. */
  suspendAppealable?: boolean;
  /** Count of formal content-policy warnings issued (graduated enforcement). */
  modStrikes?: number;
  /** Temporary gratuity upgrade: grants `giftTier` until `giftUntil` (ms epoch),
   *  then auto-reverts to the base `tier` (or higher if the base later rose). */
  giftTier?: number;
  giftUntil?: number;
  /** Free plan: when the user FIRST published (share link / git publish) — the
   *  30-day free publish window counts from here. Unset = never published. */
  firstPublishAt?: number;
  // ---- Marketing / lifecycle email ----
  /** The user's email (captured on login so the scheduler can reach them). */
  email?: string | null;
  /** Marketing consent from the sign-up checkbox (default treated as opted-in). */
  marketingOptIn?: boolean;
  /** When the user accepted the ToS + Privacy Policy at sign-up (ms epoch). */
  tosAcceptedAt?: number;
  /** Last time this account connected (ms epoch) — segments active vs lapsed. */
  lastLoginAt?: number;
  /** Hard opt-out via an email unsubscribe link — stops ALL marketing mail. */
  emailUnsubscribed?: boolean;
  /** ISO week key of the current marketing-send bucket, e.g. "2026-W28". */
  emailWeek?: string;
  /** Emails already sent in `emailWeek`. */
  emailWeekCount?: number;
  /** Last marketing email sent (ms epoch) — spaces sends across the week. */
  lastEmailAt?: number;
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

  /**
   * Resolve the EFFECTIVE tier. A live gratuity gift (giftTier until giftUntil)
   * temporarily raises the tier above the base; when it lapses we clear it and fall
   * back to the base `tier` (their started/real tier — or higher if the base rose
   * meanwhile, e.g. they bought a plan). Dev mode forces the configured dev tier.
   */
  tierFor(userId: string, opts: { devTier?: Tier } = {}): Tier {
    const acct = this.data.accounts[userId];
    // Lazily expire a lapsed gift.
    if (acct?.giftUntil != null && Date.now() >= acct.giftUntil) {
      acct.giftTier = undefined;
      acct.giftUntil = undefined;
      this.save(userId);
    }
    const base = acct?.tier ?? opts.devTier ?? 0;
    const giftActive = acct?.giftTier != null && acct.giftUntil != null && Date.now() < acct.giftUntil;
    return (giftActive ? Math.max(acct!.giftTier!, base) : base) as Tier;
  }

  setTier(userId: string, tier: Tier, stripe?: { customerId?: string; subscriptionId?: string }): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.tier = tier; // the BASE tier (real entitlement); a gift overlays it via tierFor
    if (stripe?.customerId) acct.stripeCustomerId = stripe.customerId;
    if (stripe?.subscriptionId) acct.stripeSubscriptionId = stripe.subscriptionId;
    this.save(userId);
  }

  /** The BASE tier (real entitlement), ignoring any active gratuity gift. */
  baseTier(userId: string, opts: { devTier?: Tier } = {}): Tier {
    return (this.data.accounts[userId]?.tier ?? opts.devTier ?? 0) as Tier;
  }

  /** Grant a temporary gratuity upgrade to `tier` until `untilMs`, then auto-revert. */
  grantGift(userId: string, tier: Tier, untilMs: number): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.giftTier = tier;
    acct.giftUntil = untilMs;
    this.save(userId);
  }

  /** Remove any active gratuity gift (e.g. on a direct admin tier set / downgrade). */
  clearGift(userId: string): void {
    const acct = this.data.accounts[userId];
    if (!acct) return;
    acct.giftTier = undefined;
    acct.giftUntil = undefined;
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

  /** The custom limit override for a user, or null when using the tier default. */
  limitOverride(userId: string): number | null {
    return this.data.accounts[userId]?.limitOverride ?? null;
  }

  /** Admin: set (n) or clear (null) a user's custom monthly token limit. */
  setLimitOverride(userId: string, limit: number | null): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.limitOverride = limit == null ? null : Math.max(0, Math.floor(limit));
    this.save(userId);
  }

  /** Whether a user is currently suspended (locked out). */
  isSuspended(userId: string): boolean {
    return this.data.accounts[userId]?.suspended === true;
  }

  /** The custom suspension message shown to a locked-out user. */
  suspendMessageFor(userId: string): string {
    return this.data.accounts[userId]?.suspendMessage ?? "";
  }

  /** Whether a suspended user may appeal (false = severe unappealable ban). */
  suspendAppealableFor(userId: string): boolean {
    return this.data.accounts[userId]?.suspendAppealable !== false;
  }

  /** Admin/system: suspend / un-suspend a user with an optional custom message.
   *  `appealable` defaults true; pass false for a severe unappealable ban. */
  setSuspended(userId: string, on: boolean, message: string, appealable = true): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.suspended = on;
    acct.suspendMessage = on ? message : "";
    acct.suspendAppealable = on ? appealable : true;
    this.save(userId);
  }

  /** Content-policy warnings issued to this user so far. */
  modStrikes(userId: string): number {
    return this.data.accounts[userId]?.modStrikes ?? 0;
  }

  /** Record a content-policy warning; returns the new strike total. */
  addModStrike(userId: string): number {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.modStrikes = (acct.modStrikes ?? 0) + 1;
    this.save(userId);
    return acct.modStrikes;
  }

  /** Effective monthly limit: the admin override if set, else the DYNAMIC limit
   *  (generous when used steadily, tighter under heavy daily bursts). */
  effectiveLimit(userId: string, tier: Tier): number {
    const override = this.data.accounts[userId]?.limitOverride;
    if (override != null) return override;
    return dynamicTokenLimit(tier, this.tokensUsedToday(userId));
  }

  /** Every user active since `sinceMs` (by the doc's `updatedAt`), for the admin
   *  "all users" list. Reads Firestore directly so offline users are included;
   *  falls back to the in-memory ledger when Firestore isn't configured (dev). */
  async listRecentUsers(
    sinceMs: number,
  ): Promise<
    Array<{
      userId: string;
      tier: Tier;
      tokensUsed: number;
      tokensLimit: number;
      limitOverride: number | null;
      suspended: boolean;
      suspendMessage: string;
    }>
  > {
    const period = currentPeriod();
    const day = currentDay();
    const build = (
      userId: string,
      account: Account | undefined,
      monthly: Record<string, number> | undefined,
      daily: Record<string, number> | undefined,
    ) => {
      const tier = (account?.tier ?? 0) as Tier;
      const limitOverride = account?.limitOverride ?? null;
      const tokensUsed = monthly?.[period] ?? 0;
      const tokensLimit =
        limitOverride == null ? dynamicTokenLimit(tier, daily?.[day] ?? 0) : limitOverride;
      return {
        userId,
        tier,
        tokensUsed,
        tokensLimit,
        limitOverride,
        suspended: account?.suspended === true,
        suspendMessage: account?.suspendMessage ?? "",
      };
    };
    if (this.fs) {
      try {
        const snap = await this.fs
          .collection(USAGE_COLLECTION)
          .where("updatedAt", ">=", sinceMs)
          .orderBy("updatedAt", "desc")
          .limit(500)
          .get();
        return snap.docs.map((d) => {
          const data = d.data() as {
            account?: Account;
            monthly?: Record<string, number>;
            daily?: Record<string, number>;
          };
          return build(d.id, data.account, data.monthly, data.daily);
        });
      } catch (err) {
        console.warn("[usage] listRecentUsers failed:", (err as Error).message);
        return [];
      }
    }
    return Object.keys(this.data.accounts).map((userId) =>
      build(userId, this.data.accounts[userId], this.data.usage[userId], this.data.usageDaily[userId]),
    );
  }

  /** Tokens charged to a user today (UTC) — backs the hidden Free daily cap. */
  tokensUsedToday(userId: string, day = currentDay()): number {
    return this.data.usageDaily[userId]?.[day] ?? 0;
  }

  /** Free plan only: has the user hit the hidden daily allowance? */
  isDailyThrottled(userId: string, tier: Tier): boolean {
    return tier === 0 && this.tokensUsedToday(userId) >= FREE_DAILY_TOKEN_CAP;
  }

  /** When the user's Free publish window started, or null if never published. */
  firstPublishAt(userId: string): number | null {
    return this.data.accounts[userId]?.firstPublishAt ?? null;
  }

  /** Start the Free 30-day publish window (idempotent — first publish only).
   *  Call on publish SUCCESS, not on the gate, so failed attempts (no preview
   *  running, GitHub not connected) don't burn the window. */
  markFirstPublish(userId: string): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    if (!acct.firstPublishAt) {
      acct.firstPublishAt = Date.now();
      this.save(userId);
    }
  }

  snapshot(userId: string, tier: Tier): UsageSnapshot {
    const period = currentPeriod();
    const tokensUsed = this.tokensUsed(userId, period);
    const tokensLimit = this.effectiveLimit(userId, tier);
    const snap: UsageSnapshot = {
      tier,
      tokensUsed,
      tokensLimit,
      period,
      limitReached: tokensUsed >= tokensLimit,
    };
    if (tier === 0) {
      const first = this.firstPublishAt(userId);
      snap.freePublishEndsAt = first == null ? null : first + FREE_PUBLISH_TRIAL_MS;
    }
    return snap;
  }

  isOverLimit(userId: string, tier: Tier): boolean {
    return this.tokensUsed(userId) >= this.effectiveLimit(userId, tier);
  }

  // ---- Marketing / lifecycle email ---------------------------------------

  /** Record a login: stamp email + lastLoginAt (segments active vs lapsed). */
  recordLogin(userId: string, email: string | null): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    if (email) acct.email = email;
    acct.lastLoginAt = Date.now();
    this.save(userId);
  }

  /** Persist the sign-up / Settings consent choice (marketing opt-in). Opting
   *  back IN also clears a prior hard email unsubscribe (a deliberate re-subscribe). */
  setMarketingConsent(userId: string, optIn: boolean): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.marketingOptIn = optIn;
    if (optIn) acct.emailUnsubscribed = false;
    if (!acct.tosAcceptedAt) acct.tosAcceptedAt = Date.now();
    this.save(userId);
  }

  /** Whether the user currently receives marketing mail (soft opt-in AND not
   *  hard-unsubscribed) — the state the Settings toggle reflects. */
  marketingOptIn(userId: string): boolean {
    const acct = this.data.accounts[userId];
    return acct?.marketingOptIn !== false && acct?.emailUnsubscribed !== true;
  }

  /** The email captured at login for this user, if any (for transactional
   *  notices like the snapshot-lifecycle warnings — NOT marketing-gated). */
  emailFor(userId: string): string | null {
    return this.data.accounts[userId]?.email ?? null;
  }

  /** Hard unsubscribe (from an email link) — stops all marketing mail. */
  setEmailUnsubscribed(userId: string): void {
    const acct = this.data.accounts[userId];
    if (!acct) return;
    acct.emailUnsubscribed = true;
    this.save(userId);
  }

  /** Note a marketing email just went out (bumps the weekly bucket). */
  noteMarketingSent(userId: string, week: string): void {
    const acct = (this.data.accounts[userId] ??= { tier: 0 });
    acct.emailWeekCount = (acct.emailWeek === week ? acct.emailWeekCount ?? 0 : 0) + 1;
    acct.emailWeek = week;
    acct.lastEmailAt = Date.now();
    this.save(userId);
  }

  /** All emailable accounts (in-memory ledger + Firestore) for the scheduler,
   *  each carrying its userId. Excludes hard-unsubscribed and email-less rows. */
  async marketingCandidates(): Promise<Array<Account & { userId: string }>> {
    const keep = (a: Account | undefined): a is Account =>
      Boolean(a?.email) && a?.emailUnsubscribed !== true;
    if (this.fs) {
      try {
        const snap = await this.fs.collection(USAGE_COLLECTION).limit(2000).get();
        const out: Array<Account & { userId: string }> = [];
        for (const d of snap.docs) {
          const a = (d.data().account ?? { tier: 0 }) as Account;
          if (keep(a)) out.push({ ...a, userId: d.id });
        }
        return out;
      } catch (err) {
        console.warn("[marketing] candidate query failed:", (err as Error).message);
        return [];
      }
    }
    return Object.entries(this.data.accounts)
      .filter(([, a]) => keep(a))
      .map(([userId, a]) => ({ ...a, userId }));
  }
}
