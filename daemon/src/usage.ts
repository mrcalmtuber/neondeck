import fs from "node:fs";
import path from "node:path";
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
 * Runtime store is a small JSON ledger on disk. In a production SaaS this would
 * live in Firestore alongside the `users` / `projects` collections; locally we
 * keep it in `<projectsRoot>/.ide-meta/ledger.json` so metering survives
 * restarts without standing up a database. Stripe (or the mock fallback) updates
 * `accounts[userId].tier`; agent calls increment `usage[userId][period]`.
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

export class UsageStore {
  private file: string;
  private data: Ledger = { accounts: {}, usage: {}, usageDaily: {} };

  constructor(metaDir: string) {
    fs.mkdirSync(metaDir, { recursive: true });
    this.file = path.join(metaDir, "ledger.json");
    this.load();
  }

  private load(): void {
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

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch (err) {
      console.warn("[usage] could not persist ledger:", (err as Error).message);
    }
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
    this.save();
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
    this.save();
    return forUser[period];
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
