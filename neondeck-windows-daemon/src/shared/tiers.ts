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
  /** Execution paths this tier unlocks (the runtime cascade levels). */
  allowedRuntimes: RuntimeMode[];
  /** Name of the env var holding this tier's Stripe price id (null = free). */
  stripePriceEnv: string | null;
  tagline: string;
  perks: string[];
}

export const TIERS: Record<Tier, TierConfig> = {
  0: {
    id: 0,
    key: "free",
    name: "Free",
    priceUsd: 0,
    priceLabel: "$0",
    tokenLimit: 500_000, // 500K
    tokenLabel: "500K",
    // Free runs strictly client-side: Level 3 in-browser WebContainers only.
    allowedRuntimes: ["BROWSER"],
    stripePriceEnv: null,
    tagline: "Tinker in your browser, free forever.",
    perks: [
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
    // Pro unlocks the background daemon: Level 1 Docker + Level 2 native host.
    allowedRuntimes: ["DOCKER", "LOCAL_NODE", "BROWSER"],
    stripePriceEnv: "STRIPE_PRICE_PRO",
    tagline: "Real local execution, 20× the tokens.",
    perks: [
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
    allowedRuntimes: ["DOCKER", "LOCAL_NODE", "BROWSER"],
    stripePriceEnv: "STRIPE_PRICE_MAX",
    tagline: "Peak resources and every premium module.",
    perks: [
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
