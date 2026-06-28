import { useState } from "react";
import { formatSparks, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { PlanCards } from "./PlanCards";

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

  if (!paywall) return null;
  const { usage, message } = paywall;
  const pct = usage.tokensLimit > 0 ? Math.min(100, Math.round((usage.tokensUsed / usage.tokensLimit) * 100)) : 100;

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
      const url = await daemon.checkout(t);
      window.location.href = url;
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
          <div className="paywall-meter-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="paywall-meter-label">
            {formatSparks(usage.tokensUsed)} / {formatSparks(usage.tokensLimit)} Sparks used this month · usage fluctuates
          </div>
        </div>

        {error && <div className="auth-error">⚠️ {error}</div>}

        <PlanCards
          currentTier={tier}
          billingEnabled={billingEnabled}
          busyTier={busyTier}
          onChoose={choose}
          onDowngrade={downgrade}
          simulated={!billingEnabled}
        />

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
