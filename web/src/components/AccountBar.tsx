import { getTier, isNearLimit } from "@ide/shared";
import { useStore } from "../lib/store";
import { signOut } from "../lib/firebaseClient";

/**
 * Compact account widget. Shows the current tier, the plan's monthly Sparks
 * ALLOWANCE (never live usage — no counts, no meter; the paywall/nudge handle
 * limits), an Upgrade button, and — for real Firebase sessions only — Sign out.
 * Used in the Hub header and the IDE topbar.
 *
 * In zero-config local mode there is no real account to leave, so Sign out is
 * hidden and the profile is purely informational.
 */
/**
 * @param onProfile Override for the profile-chip click. In the IDE this opens the
 * bottom-left settings menu (settings was "moved" there); elsewhere (Hub /
 * Dashboard, which have no bottom bar) it falls back to opening the settings page.
 */
export function AccountBar({ onProfile }: { onProfile?: () => void } = {}) {
  const usage = useStore((s) => s.usage);
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const authMode = useStore((s) => s.authMode);
  const tier = useStore((s) => s.tier());
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const setView = useStore((s) => s.setView);
  const openProfile = onProfile ?? (() => setView("settings"));

  const cfg = getTier(tier);
  // Near or over the limit → show a vague warning state (never numbers) and
  // let the AgentPanel nudge effort.
  const over = !!usage && usage.tokensLimit > 0 && usage.tokensUsed >= usage.tokensLimit;
  const near = !!usage && isNearLimit(usage.tokensUsed, usage.tokensLimit);
  const vague = near || over;

  const email = session?.email ?? "developer@kryct.io";
  const initial = (email[0] ?? "•").toUpperCase();

  async function handleSignOut() {
    await signOut();
    setSession(null); // App tears down the daemon connection on session loss
  }

  return (
    <div className="account-bar">
      <span className={`tier-badge tier-${cfg.key}`}>{authMode === "dev" ? "Dev" : cfg.name}</span>

      <div
        className={`usage-meter${vague ? " warn" : ""}`}
        title={`Your plan includes ${cfg.tokenLabel} each month — usage fluctuates`}
      >
        <span className="usage-meter-label">
          {vague ? (over ? "Limit reached" : "Running low") : `${cfg.tokenLabel} ✦`}
        </span>
      </div>

      {tier < 2 && (
        <button className="btn-upgrade" onClick={() => setSubscriptionModalOpen(true)}>
          ⚡ Upgrade
        </button>
      )}

      {/* Profile button — opens the account menu (bottom-left in the IDE). */}
      <button
        className="profile-btn"
        onClick={openProfile}
        title={`${email} · account & settings`}
      >
        <span className="profile-avatar">{initial}</span>
        <span className="profile-email">{email}</span>
      </button>

      {authMode !== "dev" && (
        <button className="btn-ghost sm" onClick={handleSignOut} title="Sign out">
          Sign out
        </button>
      )}
    </div>
  );
}
