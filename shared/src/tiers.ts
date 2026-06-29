/**
 * Subscription tier configuration — the SINGLE source of truth shared by the
 * browser (pricing UI / paywall) and the daemon (gating + Stripe). Changing a
 * number here changes it everywhere; nothing about pricing is duplicated.
 *
 * The Stripe *price IDs* are NOT hardcoded here — they live in the daemon's env
 * (STRIPE_PRICE_PRO / STRIPE_PRICE_MAX) and are referenced by name below, so the
 * public bundle never embeds account-specific identifiers.
 */
import type { RuntimeMode } from "./protocol.js";

export type Tier = 0 | 1 | 2;
export type TierKey = "free" | "pro" | "max";

/**
 * Reasoning "effort" the agent applies — a user-selectable level (with tier-based
 * defaults + gating):
 *   low    — bypass/minimize internal reasoning; fast, direct answers.
 *   medium — engage internal reasoning for complex logic/coding/problem-solving.
 *   high   — maximum step-by-step thinking + verification before answering.
 *
 * Tiers differ ONLY by price, monthly token allowance, and the ability to
 * publish/share apps publicly. Every plan (Free included) gets the same real
 * server-side execution and the full agent at every effort level.
 */
export type AgentEffort = "low" | "medium" | "high";

/** Dropdown order + display labels for the agent's effort selector. */
export const EFFORT_LEVELS: AgentEffort[] = ["low", "medium", "high"];
export const EFFORT_LABELS: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Hidden daily token allowance for the Free plan (surfaced only as generic
 * "usage-based pricing" when hit — never shown as a number). Separate from the
 * monthly pool (TierConfig.tokenLimit).
 */
export const FREE_DAILY_TOKEN_CAP = 1_000_000;

/**
 * "Sparks" — the user-facing usage unit. 1 Spark = 100k tokens. Everything shown to
 * users (allowances, the meter, the paywall) is in Sparks; tokens stay internal.
 */
export const SPARK_TOKENS = 100_000;
export function tokensToSparks(tokens: number): number {
  return tokens / SPARK_TOKENS;
}
/** Compact Spark label, e.g. 1_500_000 -> "15", 250_000 -> "2.5". */
export function formatSparks(tokens: number): string {
  const s = tokens / SPARK_TOKENS;
  return s >= 100 ? String(Math.round(s)) : String(Math.round(s * 10) / 10);
}

/**
 * Fraction of the (hidden, dynamic) allowance at which the UI stops showing the
 * exact remaining count and instead nudges the user toward a lower effort level.
 * Kept vague on purpose — we never reveal the real limit ("usage fluctuates").
 */
export const NEAR_LIMIT_PCT = 0.8;
/** True when usage is close to — but not yet at — the limit (the nudge window). */
export function isNearLimit(used: number, limit: number): boolean {
  return limit > 0 && used / limit >= NEAR_LIMIT_PCT && used < limit;
}

/**
 * Per-tier project SLOT cap — the number of projects a user may keep at once
 * (Free 5 / Pro 10 / Max 15). Hitting the cap blocks new creation until one is
 * deleted (delete to make room) or the user upgrades. Not a lifetime counter.
 */
export const PROJECT_LIMITS: Record<Tier, number> = { 0: 5, 1: 10, 2: 15 };
export function maxProjectsForTier(tier: Tier): number {
  return PROJECT_LIMITS[tier] ?? PROJECT_LIMITS[0];
}

/**
 * Dynamic monthly allowance (INTERNAL — never revealed; the UI only ever says
 * "usage fluctuates"). Each plan has a generous `soft` allowance that quietly
 * tightens to `hard` when a user burns more than `burst` tokens in a single day
 * ("using it like crazy"). Steady users keep the higher limit. Scales by tier.
 */
interface DynamicLimit {
  soft: number;
  hard: number;
  burst: number;
}
const DYNAMIC_LIMITS: Record<Tier, DynamicLimit> = {
  0: { soft: 1_500_000, hard: 1_000_000, burst: 300_000 }, // Free: 15 / 10 Sparks, burst 3/day
  1: { soft: 10_000_000, hard: 7_000_000, burst: 2_000_000 }, // Pro: 100 / 70 Sparks, burst 20/day
  2: { soft: 30_000_000, hard: 22_000_000, burst: 6_000_000 }, // Max: 300 / 220 Sparks, burst 60/day
};
/** The effective monthly token limit for a tier given today's burn (the dynamic
 *  shift). Tighter when the user is hammering it; generous otherwise. */
export function dynamicTokenLimit(tier: Tier, tokensUsedToday: number): number {
  const d = DYNAMIC_LIMITS[tier] ?? DYNAMIC_LIMITS[0];
  return tokensUsedToday >= d.burst ? d.hard : d.soft;
}

export interface TierConfig {
  id: Tier;
  key: TierKey;
  name: string;
  /** Monthly price in whole US dollars. */
  priceUsd: number;
  priceLabel: string;
  /** Monthly agent-token allowance. */
  tokenLimit: number;
  tokenLabel: string;
  /** The plan's DEFAULT agent effort (free=low, pro=medium, max=medium). The user
   *  can change it in the agent dropdown; High is gated to Max. */
  effort: AgentEffort;
  effortLabel: string;
  effortBlurb: string;
  /** Execution paths this tier unlocks (same for every plan — all run real code). */
  allowedRuntimes: RuntimeMode[];
  /** Name of the env var holding this tier's Stripe price id (null = free). */
  stripePriceEnv: string | null;
  /** May this tier publish/share apps publicly (share links, deploy)? Paid only. */
  canPublish: boolean;
  tagline: string;
  perks: string[];
}

/**
 * Per-response token ceiling by effort — pairs the reasoning effort with a larger
 * per-answer thinking/verification budget at higher tiers. Generous ceilings, so
 * normal output is never truncated; the MONTHLY pool is enforced separately by the
 * usage meter (TierConfig.tokenLimit).
 */
export const MAX_RESPONSE_TOKENS: Record<AgentEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
};

// Every plan shares the same execution + agent capability. The ONLY differences:
// price, monthly token allowance, and public publish/share (paid only).
const FULL_RUNTIMES: RuntimeMode[] = ["DOCKER", "LOCAL_NODE", "BROWSER"];
const FULL_AGENT = {
  effort: "medium" as AgentEffort,
  effortLabel: "Full AI Agent",
  effortBlurb: "Low, medium & high reasoning effort — all included on every plan.",
  allowedRuntimes: FULL_RUNTIMES,
};

export const TIERS: Record<Tier, TierConfig> = {
  0: {
    id: 0,
    key: "free",
    name: "Free",
    priceUsd: 0,
    priceLabel: "$0",
    tokenLimit: 1_500_000, // soft allowance (dynamic) — 15 Sparks
    tokenLabel: "15 Sparks",
    ...FULL_AGENT,
    stripePriceEnv: null,
    canPublish: false,
    tagline: "Build and run real apps, free.",
    perks: [
      "Full cloud dev sandboxes — run real apps",
      "Complete AI agent — every effort level",
      "Up to 15 Sparks / month (usage fluctuates)",
      "All editor, package & database panels",
    ],
  },
  1: {
    id: 1,
    key: "pro",
    name: "Pro",
    priceUsd: 10,
    priceLabel: "$10",
    tokenLimit: 10_000_000, // soft allowance (dynamic) — 100 Sparks
    tokenLabel: "100 Sparks",
    ...FULL_AGENT,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    canPublish: true,
    tagline: "Publish & share your apps live.",
    perks: [
      "Everything in Free",
      "Up to 100 Sparks / month (usage fluctuates)",
      "Publish & share public live URLs",
      "Permanent live preview links",
    ],
  },
  2: {
    id: 2,
    key: "max",
    name: "Max",
    priceUsd: 20,
    priceLabel: "$20",
    tokenLimit: 30_000_000, // soft allowance (dynamic) — 300 Sparks
    tokenLabel: "300 Sparks",
    ...FULL_AGENT,
    stripePriceEnv: "STRIPE_PRICE_MAX",
    canPublish: true,
    tagline: "Peak usage for power users.",
    perks: [
      "Everything in Pro",
      "Up to 300 Sparks / month — highest limits (usage fluctuates)",
      "Publish & share public live URLs",
      "Priority resources",
    ],
  },
};

export const TIER_LIST: TierConfig[] = [TIERS[0], TIERS[1], TIERS[2]];

export function getTier(id: Tier): TierConfig {
  return TIERS[id] ?? TIERS[0];
}

/** The tier's DEFAULT agent effort (free=low, pro=medium, max=medium). */
export function effortForTier(id: Tier): AgentEffort {
  return getTier(id).effort;
}

/** May this tier select the given effort? High reasoning is a Max-tier perk; Low
 *  and Medium are available on every plan. */
export function effortAllowedForTier(tier: Tier, effort: AgentEffort): boolean {
  return effort === "high" ? tier === 2 : true;
}

/** Clamp a requested effort to what the tier may use (High→Medium for Free/Pro). */
export function clampEffortForTier(tier: Tier, effort: AgentEffort): AgentEffort {
  return effortAllowedForTier(tier, effort) ? effort : "medium";
}

/**
 * Token-burn multiplier: Free on Medium effort burns 2× as fast (both the monthly
 * pool and the hidden daily cap) — a soft nudge toward upgrading. Everything else
 * is normal (1×); Pro/Max are never penalized.
 */
export function tokenMultiplierForEffort(tier: Tier, effort: AgentEffort): number {
  return tier === 0 && effort === "medium" ? 2 : 1;
}

/** May this tier publish/share apps publicly (share links, deploy)? Paid only. */
export function canPublish(tier: Tier): boolean {
  return getTier(tier).canPublish;
}

/** Does this tier unlock the given runtime/execution path? */
export function canUseRuntime(tier: Tier, mode: RuntimeMode): boolean {
  return getTier(tier).allowedRuntimes.includes(mode);
}

/** True when a tier may drive the daemon's real execution (Docker / native). */
export function canUseDaemonExecution(tier: Tier): boolean {
  const r = getTier(tier).allowedRuntimes;
  return r.includes("DOCKER") || r.includes("LOCAL_NODE");
}

/** Map a Stripe price id (resolved from env) back to the tier it grants. */
export function tierForPriceId(
  priceId: string,
  resolveEnv: (name: string) => string | undefined,
): Tier | null {
  for (const t of TIER_LIST) {
    if (t.stripePriceEnv && resolveEnv(t.stripePriceEnv) === priceId) return t.id;
  }
  return null;
}

/** Compact human label, e.g. 12_300_000 -> "12.3M", 500_000 -> "500K". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
