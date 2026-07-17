import { useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  getTier,
  usd,
  yearlyPerMonthUsd,
  yearlyTotalUsd,
  type BillingInterval,
  type Tier,
} from "@ide/shared";
import { BRAND_LABEL } from "../lib/brand";

interface Props {
  tier: Tier;
  interval: BillingInterval;
  clientSecret: string;
  publishableKey: string;
  onClose: () => void;
}

/**
 * In-page plan checkout: a native Kryct order summary on the left, Stripe's
 * EMBEDDED checkout (the payment form only) on the right. The only Stripe
 * branding visible is the payment form's own "Powered by Stripe" footer —
 * everything else is ours. On success Stripe navigates to ?checkout=success,
 * which App.tsx already handles (usage refresh + URL cleanup).
 */
export function CheckoutOverlay({ tier, interval, clientSecret, publishableKey, onClose }: Props) {
  const cfg = getTier(tier);
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let instance: { destroy: () => void } | null = null;
    (async () => {
      try {
        const stripe = await loadStripe(publishableKey);
        if (!stripe) throw new Error("The payment form failed to load — check your connection.");
        const checkout = await stripe.createEmbeddedCheckoutPage({ clientSecret });
        if (cancelled) {
          checkout.destroy();
          return;
        }
        instance = checkout;
        if (mountRef.current) checkout.mount(mountRef.current);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [clientSecret, publishableKey]);

  const monthly = interval === "month";
  const perMonth = monthly ? cfg.priceUsd : yearlyPerMonthUsd(cfg.priceUsd);
  const dueToday = monthly ? cfg.priceUsd : yearlyTotalUsd(cfg.priceUsd);

  return (
    <div className="checkout-overlay" role="dialog" aria-label={`Upgrade to ${cfg.name}`}>
      <aside className="checkout-summary">
        <div className="wordmark checkout-brand">{BRAND_LABEL}</div>
        <button className="linklike checkout-back" onClick={onClose}>
          ← Back to plans
        </button>
        <h2>Upgrade to {cfg.name}</h2>
        <p className="muted checkout-tagline">{cfg.tagline}</p>

        <div className="checkout-price-row">
          <span className="checkout-price">
            {usd(perMonth)}
            <small>/mo</small>
          </span>
          {!monthly && <span className="checkout-save">16% off</span>}
        </div>
        <p className="muted small checkout-billing-note">
          {monthly
            ? "Billed monthly. Cancel anytime from Billing."
            : "Billed once a year. Cancel anytime from Billing."}
        </p>

        <ul className="checkout-perks">
          {cfg.perks.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>

        <div className="checkout-total">
          <span>Due today</span>
          <span>{usd(dueToday)}</span>
        </div>
      </aside>

      <div className="checkout-pane">
        {loading && !error && (
          <div className="checkout-loading muted">
            <span className="spinner" /> Preparing secure payment…
          </div>
        )}
        {error && (
          <div className="checkout-error">
            <div className="auth-error">⚠️ {error}</div>
            <button className="btn-ghost sm" onClick={onClose}>
              Close
            </button>
          </div>
        )}
        <div ref={mountRef} className="checkout-mount" />
      </div>
    </div>
  );
}
