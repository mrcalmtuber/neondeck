import { useState } from "react";
import { getTier, type BillingInterval, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { IntervalToggle, PlanCards } from "./PlanCards";
import { CheckoutOverlay } from "./CheckoutOverlay";

/**
 * Subscription / upgrade modal — opened from the top-right Upgrade button, the
 * "Deploy to Web" gate, and the public-sharing nudge.
 *
 * Choosing a plan goes through REAL Stripe Checkout whenever the daemon is
 * connected (the daemon itself decides live-vs-mock: live keys → hosted Stripe
 * checkout; no keys → an instant simulated grant). Only when the daemon isn't
 * connected do we fall back to a purely local simulation so it never dead-ends.
 */
export function SubscriptionModal() {
  const open = useStore((s) => s.subscriptionModalOpen);
  const setOpen = useStore((s) => s.setSubscriptionModalOpen);
  const tier = useStore((s) => s.tier());
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [success, setSuccess] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const [checkoutSession, setCheckoutSession] = useState<{
    tier: Tier;
    interval: BillingInterval;
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (!open) return null;

  async function startUpgrade(t: Tier) {
    setBusyTier(t);
    setSuccess(null);
    setError(null);
    // Real Stripe when connected to the daemon: embedded checkout in-page
    // (clientSecret). The mock fallback returns a URL we simply follow.
    if (daemon.connected) {
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
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyTier(null);
        return;
      }
    }
    // No daemon → local simulation so the upgrade never dead-ends.
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
      setSuccess(t);
    }, 1700);
  }

  function close() {
    if (busyTier !== null) return; // never cancel mid-"payment"
    setSuccess(null);
    setOpen(false);
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal subscription-modal glass" onClick={(e) => e.stopPropagation()}>
        <div className="paywall-icon">🚀</div>
        <h2>Deploy to the Kryct Cloud</h2>
        <p className="cloud-hosting-note">
          🔒 Cloud Hosting requires a Pro or Max Membership. Upgrade now to get permanent live URLs
          running on our secure cloud instances!
        </p>

        {error && <div className="auth-error">⚠️ {error}</div>}

        <IntervalToggle value={billingInterval} onChange={setBillingInterval} />

        <PlanCards
          currentTier={tier}
          billingEnabled
          busyTier={busyTier}
          interval={billingInterval}
          onChoose={startUpgrade}
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

        {success !== null && (
          <div className="upgrade-success">
            ✓ You're on <strong>{getTier(success).name}</strong>! Cloud hosting unlocked — your token
            capacity is now {getTier(success).tokenLabel}.
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={close} disabled={busyTier !== null}>
            {success !== null ? "Done" : "Maybe later"}
          </button>
        </div>

        {busyTier !== null && (
          <div className="upgrade-loader">
            <div className="upgrade-loader-card glass">
              <span className="spinner big" />
              <div className="upgrade-loader-text">Processing Secure Upgrade Request via Stripe…</div>
              <small className="muted">Activating {getTier(busyTier).name} membership</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
