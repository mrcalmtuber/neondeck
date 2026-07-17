import { useState } from "react";
import type { BillingInterval, Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { IntervalToggle, PlanCards } from "./PlanCards";
import { CheckoutOverlay } from "./CheckoutOverlay";

/**
 * Feature 1 — "Token Limit Reached" paywall. Rendered as a blocking overlay when
 * the daemon reports the monthly pool is exhausted (the agent pipeline is paused
 * server-side). Offers a manual upgrade; dismiss to keep browsing read-only.
 *
 * When real billing is configured it opens Stripe Checkout; otherwise it falls
 * back to the same local simulation the Deploy modal uses, so an unconfigured
 * billing state never dead-ends the user at an inert paywall.
 */
export function Paywall() {
  const paywall = useStore((s) => s.paywall);
  const setPaywall = useStore((s) => s.setPaywall);
  const tier = useStore((s) => s.tier());
  const billingEnabled = useStore((s) => s.billingEnabled);
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const setUsage = useStore((s) => s.setUsage);
  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const [checkoutSession, setCheckoutSession] = useState<{
    tier: Tier;
    interval: BillingInterval;
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (!paywall) return null;
  const { message } = paywall;

  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    // No Stripe configured → simulate a successful upgrade locally and clear the
    // paywall, mirroring the Deploy-to-Web flow.
    if (!billingEnabled) {
      setTimeout(() => {
        simulateUpgrade(t);
        setBusyTier(null);
        setPaywall(null);
      }, 1700);
      return;
    }
    try {
      const start = await daemon.checkout(t, billingInterval);
      if (start.clientSecret && start.publishableKey) {
        setCheckoutSession({
          tier: t,
          interval: billingInterval,
          clientSecret: start.clientSecret,
          publishableKey: start.publishableKey,
        });
        setBusyTier(null);
      } else if (start.url) {
        window.location.href = start.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyTier(null);
    }
  }

  // Move to a LOWER tier (incl. Free) from the paywall.
  async function downgrade(t: Tier) {
    if (t === 0 && !window.confirm("Switch to the Free plan? You'll lose paid features.")) return;
    setBusyTier(t);
    setError(null);
    if (daemon.connected) {
      try {
        setUsage(await daemon.changeTier(t));
        setBusyTier(null);
        setPaywall(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyTier(null);
      }
      return;
    }
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
      setPaywall(null);
    }, 700);
  }

  return (
    <div className="modal-backdrop paywall-backdrop">
      <div className="modal paywall glass" onClick={(e) => e.stopPropagation()}>
        <div className="paywall-icon">🔒</div>
        <h2>Token Limit Reached</h2>
        <p className="paywall-msg">{message}</p>

        <div className="paywall-meter">
          <div className="paywall-meter-label">
            You've used this month's included agent usage · usage fluctuates
          </div>
        </div>

        {error && <div className="auth-error">⚠️ {error}</div>}

        <IntervalToggle value={billingInterval} onChange={setBillingInterval} />

        <PlanCards
          currentTier={tier}
          billingEnabled={billingEnabled}
          busyTier={busyTier}
          interval={billingInterval}
          onChoose={choose}
          onDowngrade={downgrade}
          simulated={!billingEnabled}
        />

        {checkoutSession && (
          <CheckoutOverlay
            tier={checkoutSession.tier}
            interval={checkoutSession.interval}
            clientSecret={checkoutSession.clientSecret}
            publishableKey={checkoutSession.publishableKey}
            onClose={() => setCheckoutSession(null)}
          />
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => setPaywall(null)} disabled={busyTier !== null}>
            Dismiss for now
          </button>
        </div>

        {busyTier !== null && !billingEnabled && (
          <div className="upgrade-loader">
            <div className="upgrade-loader-card glass">
              <span className="spinner big" />
              <div className="upgrade-loader-text">Processing Secure Upgrade Request via Stripe…</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
