import Stripe from "stripe";
import { tierForPriceId, type BillingInterval, type Tier, type UsageSnapshot } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";
import type { DevStore } from "./devProgram.js";

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
export function priceForTier(
  config: DaemonConfig,
  tier: Tier,
  interval: BillingInterval = "month",
): string {
  const id =
    interval === "year"
      ? tier === 1
        ? config.stripePriceProYearly
        : tier === 2
          ? config.stripePriceMaxYearly
          : ""
      : tier === 1
        ? config.stripePricePro
        : tier === 2
          ? config.stripePriceMax
          : "";
  if (!id) {
    const env = `STRIPE_PRICE_${tier === 1 ? "PRO" : "MAX"}${interval === "year" ? "_YEARLY" : ""}`;
    throw new Error(`No Stripe price configured for tier ${tier} (${interval}ly). Set ${env}.`);
  }
  return id;
}

function resolveEnv(config: DaemonConfig): (name: string) => string | undefined {
  return (name) => {
    switch (name) {
      case "STRIPE_PRICE_PRO":
        return config.stripePricePro;
      case "STRIPE_PRICE_MAX":
        return config.stripePriceMax;
      case "STRIPE_PRICE_PRO_YEARLY":
        return config.stripePriceProYearly;
      case "STRIPE_PRICE_MAX_YEARLY":
        return config.stripePriceMaxYearly;
      default:
        return undefined;
    }
  };
}

/**
 * Result of starting a plan checkout. Exactly one field is set:
 * `url` (mock grant — the client just navigates) or `clientSecret` (real Stripe,
 * EMBEDDED checkout — the web app mounts Stripe's payment form in-page next to
 * a native Kryct order summary; Stripe branding only appears as the payment
 * form's own "Powered by Stripe" footer).
 */
export interface CheckoutStart {
  url?: string;
  clientSecret?: string;
}

/** Create a subscription Checkout session (embedded UI; monthly or yearly). */
export async function createCheckoutSession(
  config: DaemonConfig,
  store: UsageStore,
  opts: { userId: string; email: string | null; tier: Tier; interval?: BillingInterval },
): Promise<CheckoutStart> {
  if (opts.tier === 0) throw new Error("The Free plan needs no checkout.");
  const interval: BillingInterval = opts.interval === "year" ? "year" : "month";

  // Mock Stripe: no live keys → grant the tier in the ledger right away and
  // bounce the browser back to the success URL so the upgrade always lands.
  if (!realStripeConfigured(config)) {
    store.setTier(opts.userId, opts.tier);
    return { url: `${config.appOrigin}/?checkout=success` };
  }

  const session = await stripe(config).checkout.sessions.create({
    mode: "subscription",
    ui_mode: "embedded",
    line_items: [{ price: priceForTier(config, opts.tier, interval), quantity: 1 }],
    return_url: `${config.appOrigin}/?checkout=success`,
    client_reference_id: opts.userId,
    customer_email: opts.email ?? undefined,
    metadata: { userId: opts.userId, tier: String(opts.tier) },
    subscription_data: { metadata: { userId: opts.userId, tier: String(opts.tier) } },
  });
  if (!session.client_secret) throw new Error("Stripe did not return a checkout session.");
  return { clientSecret: session.client_secret };
}

// ---------------------------------------------------------------------------
// Developer program — metered pay-per-use API billing
// ---------------------------------------------------------------------------

/** Billing Meter event names — must match the meters created in the Stripe
 *  dashboard (Billing → Meters, aggregation Sum of payload key `value`,
 *  customer mapping `stripe_customer_id`). Priced at $6 / $10 per 1M tokens
 *  via the STRIPE_PRICE_API_INPUT / _OUTPUT metered prices. */
export const METER_EVENT_INPUT = "neondeck_api_input_tokens";
export const METER_EVENT_OUTPUT = "neondeck_api_output_tokens";

/**
 * One hosted Checkout that both collects the developer's card AND activates the
 * metered API subscription (two usage-based prices, one subscription — metered
 * prices take no `quantity`). `metadata.purpose = "dev_api"` is what keeps the
 * tier webhook from ever mistaking this for a plan purchase.
 */
export async function createApiCheckoutSession(
  config: DaemonConfig,
  devStore: DevStore,
  opts: { userId: string; email: string | null },
): Promise<string> {
  // Mock Stripe: mark the card on file right away (mirrors the tier mock) so the
  // whole developer flow is testable with zero Stripe config.
  if (!realStripeConfigured(config)) {
    devStore.setCard(opts.userId, {});
    return `${config.appOrigin}/?dev_checkout=success`;
  }
  if (!config.stripePriceApiInput || !config.stripePriceApiOutput) {
    throw new Error(
      "API billing prices are not configured. Set STRIPE_PRICE_API_INPUT and STRIPE_PRICE_API_OUTPUT.",
    );
  }
  const session = await stripe(config).checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: config.stripePriceApiInput }, { price: config.stripePriceApiOutput }],
    success_url: `${config.appOrigin}/?dev_checkout=success`,
    cancel_url: `${config.appOrigin}/?dev_checkout=cancel`,
    client_reference_id: opts.userId,
    customer_email: opts.email ?? undefined,
    metadata: { purpose: "dev_api", userId: opts.userId },
    subscription_data: { metadata: { purpose: "dev_api", userId: opts.userId } },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return session.url;
}

/**
 * Report one agent run's aggregate token usage to the Billing Meters — at most
 * TWO events per run (input + output), never per model call. `identifier`
 * (the run/prompt id, suffixed :in/:out) makes retries idempotent: Stripe
 * dedupes meter events by identifier for 24h. Never throws — a metering hiccup
 * must not break a run (under-billing is the failure mode, in the user's favor).
 */
export async function reportApiUsage(
  config: DaemonConfig,
  customerId: string | null,
  usage: { input: number; output: number },
  identifier: string,
): Promise<void> {
  if (!realStripeConfigured(config) || !customerId) return;
  const events: Array<{ name: string; value: number; suffix: string }> = [
    { name: METER_EVENT_INPUT, value: Math.round(usage.input), suffix: ":in" },
    { name: METER_EVENT_OUTPUT, value: Math.round(usage.output), suffix: ":out" },
  ];
  for (const e of events) {
    if (e.value <= 0) continue;
    try {
      await stripe(config).billing.meterEvents.create({
        event_name: e.name,
        payload: { stripe_customer_id: customerId, value: String(e.value) },
        identifier: `${identifier}${e.suffix}`,
      });
    } catch (err) {
      console.warn(`[billing] meter event failed (${e.name}):`, (err as Error).message);
    }
  }
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
  const customerFound = customers.data.length > 0;
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

  // Compare against the BASE tier (not the effective one) so an active gratuity gift
  // doesn't block recording a real Stripe entitlement on the base.
  const base = store.baseTier(opts.userId);
  if (best !== null && best > base) {
    // Active subscription found — record/upgrade the base entitlement.
    store.setTier(opts.userId, best, { customerId: bestCustomer, subscriptionId: bestSub });
  } else if (best === null && customerFound && base > 0) {
    // The user IS a Stripe customer for this email but has NO active/trialing
    // subscription, yet the ledger still shows a paid base tier — a cancellation
    // whose webhook was missed (e.g. diskless restart). Downgrade the base to Free
    // (M6). Any active gratuity gift is stored separately and still overlays via
    // tierFor, and admin comps are gifts (not base-tier sets), so this only reverses
    // genuinely-lapsed paid subscriptions — it never revokes a comp or an admin grant.
    store.setTier(opts.userId, 0);
  }
  // NOTE: when NO customer exists for this email we deliberately do nothing — the
  // account could be paying under a different email, and we must not false-downgrade.
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

  // Drive a live Stripe subscription ONLY when the current tier is actually backed
  // by one. A tier granted outside Stripe — an admin set, a gratuity gift, a
  // comped/legacy ledger tier — has no subscription id; those used to hit "No
  // active subscription found to change" and dead-end (this is exactly what an
  // admin who gifted themselves Max sees when switching plans). In every other
  // case we just adjust the ledger, like mock mode.
  const subId = realStripeConfigured(config) ? store.getSubscriptionId(opts.userId) : null;
  if (subId) {
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
  }

  // Apply to the ledger, and clear any gratuity gift so the downgrade actually
  // takes effect — tierFor overlays an active gift ON TOP of the base tier, so
  // without this a gifted-Max admin's setTier(Pro) would still resolve to Max.
  store.clearGift(opts.userId);
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
  devStore: DevStore,
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
      // Developer-API card checkout — MUST branch before any tier logic: this
      // session has no `tier` metadata, so falling through would read tier 0 and
      // downgrade a paying user to Free.
      if (s.metadata?.purpose === "dev_api") {
        if (userId) {
          await devStore.ensureLoaded(userId);
          devStore.setCard(userId, {
            customerId: typeof s.customer === "string" ? s.customer : undefined,
            subscriptionId: typeof s.subscription === "string" ? s.subscription : undefined,
          });
        }
        break;
      }
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
      const active = sub.status === "active" || sub.status === "trialing";
      // Developer-API metered subscription — card state only, never tiers.
      if (sub.metadata?.purpose === "dev_api") {
        const devUserId = sub.metadata?.userId ?? "";
        if (devUserId) {
          await devStore.ensureLoaded(devUserId);
          if (active) devStore.setCard(devUserId, { customerId, subscriptionId: sub.id });
          else devStore.clearCard(devUserId);
        }
        break;
      }
      const priceId = sub.items.data[0]?.price?.id ?? "";
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
      if (sub.metadata?.purpose === "dev_api") {
        const devUserId = sub.metadata?.userId ?? "";
        if (devUserId) {
          await devStore.ensureLoaded(devUserId);
          devStore.clearCard(devUserId);
        }
        break;
      }
      const userId = store.userByCustomer(customerId) ?? sub.metadata?.userId ?? "";
      if (userId) store.setTier(userId, 0, { customerId });
      break;
    }
    default:
      break; // ignore unrelated events
  }

  return { received: true, type: event.type };
}
