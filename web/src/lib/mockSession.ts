import { TIERS, type Tier, type UsageSnapshot } from "@ide/shared";

/**
 * Browser-transport metering helpers.
 *
 * When the local daemon isn't running, NeonDeck still mounts the dashboard and
 * an in-browser workspace for the signed-in Firebase user. There's no daemon
 * ledger in that mode, so the token meter is seeded from these helpers and
 * upgrades are simulated locally (real auth still gates entry).
 */

/** Current calendar period, e.g. "2026-06". */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Build a usage snapshot for a tier (defaults to FREE, 0 tokens used). */
export function mockUsage(tier: Tier = 0, tokensUsed = 0): UsageSnapshot {
  return {
    tier,
    tokensUsed,
    tokensLimit: TIERS[tier].tokenLimit,
    period: currentPeriod(),
    limitReached: false,
  };
}
