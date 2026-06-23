import { useState } from "react";
import { getTier, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { PlanCards } from "./PlanCards";

/**
 * Local subscription paywall (Feature 4) — also the "Deploy to Web" gate.
 *
 * Billing is fully simulated: choosing Pro or Max runs a glassmorphic
 * "Processing… via Stripe" loader, then flips the local mock session to the new
 * tier and unlocks its token capacity. No Stripe keys, no network, no blockade.
 */
export function SubscriptionModal() {
  const open = useStore((s) => s.subscriptionModalOpen);
  const setOpen = useStore((s) => s.setSubscriptionModalOpen);
  const tier = useStore((s) => s.tier());
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [success, setSuccess] = useState<Tier | null>(null);

  if (!open) return null;

  function startUpgrade(t: Tier) {
    setBusyTier(t);
    setSuccess(null);
    // Simulated secure checkout round-trip — no keys, no network.
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
        <h2>Deploy to the NeonDeck Cloud</h2>
        <p className="cloud-hosting-note">
          🔒 Cloud Hosting requires a Pro or Max Membership. Upgrade now to get permanent live URLs
          running on our secure cloud instances!
        </p>

        <PlanCards currentTier={tier} billingEnabled busyTier={busyTier} onChoose={startUpgrade} />

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
