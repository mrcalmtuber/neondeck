import Stripe from "stripe";
import { tierForPriceId, type Tier } from "./shared/protocol.js";
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
function priceForTier(config: DaemonConfig, tier: Tier): string {
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
