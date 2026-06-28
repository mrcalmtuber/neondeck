import { formatSparks, getTier } from "@ide/shared";
import { useStore } from "../lib/store";
import { signOut } from "../lib/firebaseClient";

/**
 * Compact account + usage widget. Shows the current tier, a live monthly token
 * meter, an Upgrade button (opens the subscription modal), and — for real
 * Firebase sessions only — Sign out. Used in the Hub header and the IDE topbar.
 *
 * In zero-config local mode there is no real account to leave, so Sign out is
 * hidden and the profile is purely informational.
 */
export function AccountBar() {
  const usage = useStore((s) => s.usage);
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const authMode = useStore((s) => s.authMode);
  const tier = useStore((s) => s.tier());
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const setView = useStore((s) => s.setView);

  const cfg = getTier(tier);
  const pct =
    usage && usage.tokensLimit > 0
      ? Math.min(100, Math.round((usage.tokensUsed / usage.tokensLimit) * 100))
      : 0;

  const email = session?.email ?? "developer@neondeck.io";
  const initial = (email[0] ?? "•").toUpperCase();

  async function handleSignOut() {
    await signOut();
    setSession(null); // App tears down the daemon connection on session loss
  }

  return (
    <div className="account-bar">
      <span className={`tier-badge tier-${cfg.key}`}>{authMode === "dev" ? "Dev" : cfg.name}</span>

      {usage && (
        <div className="usage-meter" title={`${formatSparks(usage.tokensUsed)} / ${formatSparks(usage.tokensLimit)} Sparks — usage fluctuates`}>
          <div className="usage-meter-bar">
            <span className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} />
          </div>
          <span className="usage-meter-label">
            {formatSparks(usage.tokensUsed)}/{formatSparks(usage.tokensLimit)} ✦
          </span>
        </div>
      )}

      {tier < 2 && (
        <button className="btn-upgrade" onClick={() => setSubscriptionModalOpen(true)}>
          ⚡ Upgrade
        </button>
      )}

      {/* Profile button — opens the account Settings page. */}
      <button
        className="profile-btn"
        onClick={() => setView("settings")}
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
