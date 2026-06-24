import Stripe from "stripe";
import { tierForPriceId, type Tier, type UsageSnapshot } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";

/**
 * Stripe billing — with a global mock-Stripe fallback.
 *
 * `billingEnabled` is hard-overridden to TRUE so an unconfigured billing state
 * never blocks the workspace or greys out the upgrade UI. When real Stripe keys
 * ARE present (STRIPE_SECRET_KEY) the daemon drives genuine Checkout; when they
 * are absent a mock Stripe instance is used instead — checkout immediately
 * grants the tier in the local ledger and returns a success URL, so the upgrade
 * round-trip always completes (purely simulated, no charge, no network).
 */

let _stripe: Stripe | null = null;

/** Global override: billing is always treated as configured. */
export function billingEnabled(_config: DaemonConfig): boolean {
  return true;
}

/** Whether REAL Stripe keys are present (vs. the mock fallback). */
export function realStripeConfigured(config: DaemonConfig): boolean {
  return Boolean(config.stripeSecretKey);
}

function stripe(config: DaemonConfig): Stripe {
  if (!_stripe) _stripe = new Stripe(config.stripeSecretKey);
  return _stripe;
}

/** Resolve a tier's configured Stripe price id (test-mode) from env-backed config. */
export function priceForTier(config: DaemonConfig, tier: Tier): string {
  const id = tier === 1 ? config.stripePricePro : tier === 2 ? config.stripePriceMax : "";
  if (!id) throw new Error(`No Stripe price configured for tier ${tier}. Set STRIPE_PRICE_${tier === 1 ? "PRO" : "MAX"}.`);
  return id;
}

function resolveEnv(config: DaemonConfig): (name: string) => string | undefined {
  return (name) =>
    name === "STRIPE_PRICE_PRO"
      ? config.stripePricePro
      : name === "STRIPE_PRICE_MAX"
        ? config.stripePriceMax
        : undefined;
}

/** Create a subscription Checkout session and return its hosted URL. */
export async function createCheckoutSession(
  config: DaemonConfig,
  store: UsageStore,
  opts: { userId: string; email: string | null; tier: Tier },
): Promise<string> {
  if (opts.tier === 0) throw new Error("The Free plan needs no checkout.");

  // Mock Stripe: no live keys → grant the tier in the ledger right away and
  // bounce the browser back to the success URL so the upgrade always lands.
  if (!realStripeConfigured(config)) {
    store.setTier(opts.userId, opts.tier);
    return `${config.appOrigin}/?checkout=success`;
  }

  const session = await stripe(config).checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceForTier(config, opts.tier), quantity: 1 }],
    success_url: `${config.appOrigin}/?checkout=success`,
    cancel_url: `${config.appOrigin}/?checkout=cancel`,
    client_reference_id: opts.userId,
    customer_email: opts.email ?? undefined,
    metadata: { userId: opts.userId, tier: String(opts.tier) },
    subscription_data: { metadata: { userId: opts.userId, tier: String(opts.tier) } },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return session.url;
}

/**
 * Reconcile a user's tier from Stripe (the source of truth) — survives a wiped
 * ledger (Render free has no persistent disk) and a webhook that landed under a
 * different key. Finds the Stripe customer by account email, reads their active
 * subscription, and writes the tier into the ledger. Returns the tier it found,
 * or null when there's nothing to apply (no live Stripe, no email, or no active
 * subscription). Safe to call on every connect — it only ever upgrades from the
 * stored tier, never downgrades a user who's mid-session.
 */
export async function reconcileTierFromStripe(
  config: DaemonConfig,
  store: UsageStore,
  opts: { userId: string; email: string | null },
): Promise<Tier | null> {
  if (!realStripeConfigured(config)) return null;
  if (!opts.email) return null; // need an email to locate the Stripe customer
  const s = stripe(config);

  let best: Tier | null = null;
  let bestCustomer: string | undefined;
  let bestSub: string | undefined;

  // A customer is keyed by email; there can be more than one. Check each for a
  // live subscription and keep the highest tier found.
  const customers = await s.customers.list({ email: opts.email, limit: 10 });
  for (const c of customers.data) {
    const subs = await s.subscriptions.list({ customer: c.id, status: "all", limit: 20 });
    for (const sub of subs.data) {
      if (sub.status !== "active" && sub.status !== "trialing") continue;
      // Prefer the tier we stamped into the subscription's metadata at checkout
      // (independent of the STRIPE_PRICE_* env); fall back to a price-id lookup.
      const metaTier = Number(sub.metadata?.tier);
      const tier =
        metaTier === 1 || metaTier === 2
          ? (metaTier as Tier)
          : tierForPriceId(sub.items.data[0]?.price?.id ?? "", resolveEnv(config));
      if (tier && (best === null || tier > best)) {
        best = tier;
        bestCustomer = c.id;
        bestSub = sub.id;
      }
    }
  }

  if (best !== null && best > store.tierFor(opts.userId)) {
    store.setTier(opts.userId, best, { customerId: bestCustomer, subscriptionId: bestSub });
  }
  return best;
}

/**
 * Downgrade a user to a LOWER tier (incl. Free). Rejects upgrades — those go
 * through Checkout so they're paid for. With mock Stripe it just adjusts the
 * ledger; with live Stripe it updates/cancels the subscription (the webhook also
 * reconciles the ledger, but we set it optimistically for an instant UI update).
 */
export async function changeTier(
  config: DaemonConfig,
  store: UsageStore,
  opts: { userId: string; tier: Tier; devTier?: Tier },
): Promise<UsageSnapshot> {
  // Measure the downgrade against the user's EFFECTIVE current tier — for a
  // dev/loopback user with no ledger entry that's the dev default (e.g. Max), so
  // a first downgrade from Max→Pro/Free is allowed and then persists.
  const current = store.tierFor(opts.userId, opts.devTier !== undefined ? { devTier: opts.devTier } : {});
  if (opts.tier >= current) {
    throw new Error("changeTier only downgrades; use checkout to upgrade.");
  }

  // Mock Stripe (no live keys): adjust the ledger directly.
  if (!realStripeConfigured(config)) {
    store.setTier(opts.userId, opts.tier);
    return store.snapshot(opts.userId, opts.tier);
  }

  // Live Stripe: drive the subscription.
  const subId = store.getSubscriptionId(opts.userId);
  if (!subId) throw new Error("No active subscription found to change.");
  if (opts.tier === 0) {
    await stripe(config).subscriptions.cancel(subId);
  } else {
    const sub = await stripe(config).subscriptions.retrieve(subId);
    const itemId = sub.items.data[0]?.id;
    if (!itemId) throw new Error("Subscription has no line item to update.");
    await stripe(config).subscriptions.update(subId, {
      items: [{ id: itemId, price: priceForTier(config, opts.tier) }],
      proration_behavior: "create_prorations",
    });
  }
  store.setTier(opts.userId, opts.tier);
  return store.snapshot(opts.userId, opts.tier);
}

/**
 * Verify + apply a Stripe webhook event. Updates the user's tier in the ledger.
 * Throws on signature failure so the route can return 400.
 */
export async function handleWebhook(
  config: DaemonConfig,
  store: UsageStore,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<{ received: boolean; type: string }> {
  if (!realStripeConfigured(config)) throw new Error("Live Stripe is not configured (mock mode).");
  if (!config.stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  if (!signature) throw new Error("Missing Stripe-Signature header.");

  const event = stripe(config).webhooks.constructEvent(
    rawBody,
    signature,
    config.stripeWebhookSecret,
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.client_reference_id || (s.metadata?.userId ?? "");
      const tier = Number(s.metadata?.tier ?? "0") as Tier;
      if (userId) {
        store.setTier(userId, tier, {
          customerId: typeof s.customer === "string" ? s.customer : undefined,
          subscriptionId: typeof s.subscription === "string" ? s.subscription : undefined,
        });
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const priceId = sub.items.data[0]?.price?.id ?? "";
      const active = sub.status === "active" || sub.status === "trialing";
      const tier = active ? tierForPriceId(priceId, resolveEnv(config)) : 0;
      const userId = store.userByCustomer(customerId) ?? sub.metadata?.userId ?? "";
      if (userId && tier !== null) {
        store.setTier(userId, tier as Tier, { customerId, subscriptionId: sub.id });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const userId = store.userByCustomer(customerId) ?? sub.metadata?.userId ?? "";
      if (userId) store.setTier(userId, 0, { customerId });
      break;
    }
    default:
      break; // ignore unrelated events
  }

  return { received: true, type: event.type };
}
