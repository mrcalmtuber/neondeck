import fs from "node:fs";
import path from "node:path";
import { getTier, type Tier, type UsageSnapshot } from "./shared/protocol.js";

/**
 * A per-call metering handle handed to the agent / inline-AI so they can charge
 * tokens and learn when the monthly pool is spent. Built by the server.
 */
export interface Meter {
  tier: Tier;
  /** Already over the pool? Callers should not start new model work. */
  isOver(): boolean;
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
  usage: Record<string, Record<string, number>>; // userId -> period -> tokens
}

export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class UsageStore {
  private file: string;
  private data: Ledger = { accounts: {}, usage: {} };

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
    if (opts.devTier !== undefined) return opts.devTier;
    return this.data.accounts[userId]?.tier ?? 0;
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

  tokensUsed(userId: string, period = currentPeriod()): number {
    return this.data.usage[userId]?.[period] ?? 0;
  }

  /** Add tokens to the current period and persist. Returns the new total. */
  addTokens(userId: string, n: number, period = currentPeriod()): number {
    if (n <= 0) return this.tokensUsed(userId, period);
    const forUser = (this.data.usage[userId] ??= {});
    forUser[period] = (forUser[period] ?? 0) + n;
    this.save();
    return forUser[period];
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
