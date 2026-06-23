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
 *   high   — maximum step-by-step thinking + verification before answering (Max only).
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
export const FREE_DAILY_TOKEN_CAP = 100_000;

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
  /** Execution paths this tier unlocks (the runtime cascade levels). */
  allowedRuntimes: RuntimeMode[];
  /** Name of the env var holding this tier's Stripe price id (null = free). */
  stripePriceEnv: string | null;
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

export const TIERS: Record<Tier, TierConfig> = {
  0: {
    id: 0,
    key: "free",
    name: "Free",
    priceUsd: 0,
    priceLabel: "$0",
    tokenLimit: 500_000, // 500K
    tokenLabel: "500K",
    effort: "low",
    effortLabel: "Low Effort",
    effortBlurb:
      "Fast, direct answers. Medium effort is available too — but it burns your tokens 2× faster.",
    // Free runs strictly client-side: Level 3 in-browser WebContainers only.
    allowedRuntimes: ["BROWSER"],
    stripePriceEnv: null,
    tagline: "Tinker in your browser, free forever.",
    perks: [
      "Low-effort agent — fast, direct answers",
      "500K agent tokens / month",
      "Level 3 — in-browser virtual WebContainers",
      "All editor, package & database panels",
    ],
  },
  1: {
    id: 1,
    key: "pro",
    name: "Pro",
    priceUsd: 10,
    priceLabel: "$10",
    tokenLimit: 10_000_000, // 10M
    tokenLabel: "10M",
    effort: "medium",
    effortLabel: "Medium Effort",
    effortBlurb:
      "Balanced internal reasoning for complex logic and coding — included, no token penalty.",
    // Pro unlocks the background daemon: Level 1 Docker + Level 2 native host.
    allowedRuntimes: ["DOCKER", "LOCAL_NODE", "BROWSER"],
    stripePriceEnv: "STRIPE_PRICE_PRO",
    tagline: "Real local execution, 20× the tokens.",
    perks: [
      "Medium-effort agent — balanced reasoning, included",
      "10M agent tokens / month",
      "Docker & Local Daemon Access",
      "Native local-host execution",
      "Live preview proxy & public share tunnels",
    ],
  },
  2: {
    id: 2,
    key: "max",
    name: "Max",
    priceUsd: 20,
    priceLabel: "$20",
    tokenLimit: 30_000_000, // 30M
    tokenLabel: "30M",
    effort: "medium",
    effortLabel: "High Effort",
    effortBlurb:
      "The only plan that unlocks High effort — maximum step-by-step thinking and verification before answering.",
    allowedRuntimes: ["DOCKER", "LOCAL_NODE", "BROWSER"],
    stripePriceEnv: "STRIPE_PRICE_MAX",
    tagline: "Peak resources and every premium module.",
    perks: [
      "High-effort agent — step-by-step thinking + verification (exclusive)",
      "30M agent tokens / month",
      "Peak Resource Allocation",
      "Everything in Pro",
      "All premium modules unlocked",
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

/** May this tier select the given effort? High is exclusive to Max (tier 2). */
export function effortAllowedForTier(tier: Tier, effort: AgentEffort): boolean {
  return effort === "high" ? tier === 2 : true;
}

/** Clamp a requested effort to what the tier may use (High→Medium for Free/Pro). */
export function clampEffortForTier(tier: Tier, effort: AgentEffort): AgentEffort {
  return effortAllowedForTier(tier, effort) ? effort : "medium";
}

/**
 * Token-burn multiplier: Free on Medium effort burns 2× as fast (both the monthly
 * pool and the hidden daily cap). Everything else is normal (1×) — Pro/Max are
 * never penalized.
 */
export function tokenMultiplierForEffort(tier: Tier, effort: AgentEffort): number {
  return tier === 0 && effort === "medium" ? 2 : 1;
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
