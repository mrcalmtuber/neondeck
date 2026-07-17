import { useState } from "react";
import type { BillingInterval, Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { IntervalToggle, PlanCards } from "./PlanCards";
import { CheckoutOverlay } from "./CheckoutOverlay";

/** Pricing / upgrade modal opened from the account bar. */
export function PlansModal({ onClose }: { onClose: () => void }) {
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

  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    // No Stripe configured → simulate the upgrade locally instead of dead-ending.
    if (!billingEnabled) {
      setTimeout(() => {
        simulateUpgrade(t);
        setBusyTier(null);
        onClose();
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
        window.location.href = start.url; // mock grant round-trip
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyTier(null);
    }
  }

  // Move to a LOWER tier (incl. Free).
  async function downgrade(t: Tier) {
    if (t === 0 && !window.confirm("Switch to the Free plan? You'll lose paid features.")) return;
    setBusyTier(t);
    setError(null);
    if (daemon.connected) {
      try {
        setUsage(await daemon.changeTier(t));
        setBusyTier(null);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyTier(null);
      }
      return;
    }
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
      onClose();
    }, 700);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal plans-modal glass" onClick={(e) => e.stopPropagation()}>
        <h2>Plans &amp; pricing</h2>
        <p className="muted">Upgrade unlocks more monthly Sparks and real daemon execution.</p>
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
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
