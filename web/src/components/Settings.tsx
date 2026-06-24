import { useState } from "react";
import {
  formatTokens,
  getTier,
  EFFORT_LEVELS,
  EFFORT_LABELS,
  effortForTier,
  clampEffortForTier,
  type Tier,
} from "@ide/shared";
import { useStore, THEMES, type Theme } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { signOut } from "../lib/firebaseClient";
import { PlanCards } from "./PlanCards";
import { BRAND_LABEL } from "../lib/brand";

const THEME_LABELS: Record<Theme, string> = {
  midnight: "Cyber Neon",
  coffee: "Soft Pastel Coffee",
  dracula: "Dracula Dark",
  contrast: "High Contrast",
};

/**
 * Account & preferences page (reached from the top-right account chip). Consolidates
 * profile, plan/billing, appearance, agent defaults, and the daemon connection.
 */
export function Settings() {
  const usage = useStore((s) => s.usage);
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const authMode = useStore((s) => s.authMode);
  const transport = useStore((s) => s.transport);
  const conn = useStore((s) => s.conn);
  const tier = useStore((s) => s.tier());
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setView = useStore((s) => s.setView);
  const setUsage = useStore((s) => s.setUsage);
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const agentMode = useStore((s) => s.agentMode);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const agentEffort = useStore((s) => s.agentEffort);
  const setAgentEffort = useStore((s) => s.setAgentEffort);

  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cfg = getTier(tier);
  const daemonReady = transport === "daemon" && daemon.connected;
  const email = session?.email ?? "developer@neondeck.io";
  const initial = (email[0] ?? "•").toUpperCase();
  const pct =
    usage && usage.tokensLimit > 0
      ? Math.min(100, Math.round((usage.tokensUsed / usage.tokensLimit) * 100))
      : 0;
  const effectiveEffort = clampEffortForTier(tier, agentEffort ?? effortForTier(tier));

  // Upgrade / downgrade — same paths the dashboard uses (real checkout/changeTier
  // when on the daemon, local simulation otherwise) so billing never dead-ends.
  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    if (daemonReady) {
      try {
        const url = await daemon.checkout(t);
        window.location.href = url;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyTier(null);
      }
      return;
    }
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
    }, 1000);
  }

  async function downgrade(t: Tier) {
    if (t === 0 && !window.confirm("Switch to the Free plan? You'll lose paid features.")) return;
    setBusyTier(t);
    setError(null);
    if (daemonReady) {
      try {
        setUsage(await daemon.changeTier(t));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyTier(null);
      }
      return;
    }
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
    }, 600);
  }

  async function handleSignOut() {
    await signOut();
    setSession(null);
    setView("dashboard");
  }

  return (
    <div className="settings">
      <header className="settings-topbar">
        <button className="btn-ghost" onClick={() => setView("dashboard")}>
          ← Back to Dashboard
        </button>
        <span className="brand">{BRAND_LABEL}</span>
        <span className="topbar-spacer" />
        <h2 className="settings-title">Settings</h2>
      </header>

      <div className="settings-body">
        {/* Account */}
        <section className="settings-card glass">
          <h3>Account</h3>
          <div className="settings-account">
            <span className="profile-avatar lg">{initial}</span>
            <div>
              <div className="settings-email">{email}</div>
              <div className="muted small">
                <span className={`tier-badge tier-${cfg.key}`}>
                  {authMode === "dev" ? "Dev" : cfg.name}
                </span>
                {authMode === "dev" ? " · local dev session" : " · signed in"}
              </div>
            </div>
            {authMode !== "dev" && (
              <button className="btn-ghost sm" onClick={handleSignOut} style={{ marginLeft: "auto" }}>
                Sign out
              </button>
            )}
          </div>
          {usage && (
            <div className="dash-usage" style={{ marginTop: 12 }}>
              <div className="usage-meter-bar wide">
                <span className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} />
              </div>
              <span className="muted small">
                {formatTokens(usage.tokensUsed)} / {formatTokens(usage.tokensLimit)} agent tokens this month
              </span>
            </div>
          )}
        </section>

        {/* Plan & billing */}
        <section className="settings-card glass">
          <h3>Plan &amp; billing</h3>
          {error && <div className="auth-error">⚠️ {error}</div>}
          <PlanCards
            currentTier={tier}
            billingEnabled
            busyTier={busyTier}
            onChoose={choose}
            onDowngrade={downgrade}
            simulated={!daemonReady}
          />
        </section>

        {/* Appearance */}
        <section className="settings-card glass">
          <h3>Appearance</h3>
          <div className="settings-theme-row">
            {THEMES.map((t) => (
              <button
                key={t}
                className={`settings-theme ${theme === t ? "active" : ""}`}
                onClick={() => setTheme(t)}
              >
                {THEME_LABELS[t]}
                {theme === t && <span className="effort-check"> ✓</span>}
              </button>
            ))}
          </div>
        </section>

        {/* Agent defaults */}
        <section className="settings-card glass">
          <h3>Agent defaults</h3>
          <div className="settings-pref">
            <span className="muted small">Autonomy</span>
            <div className="settings-seg">
              <button
                className={agentMode === "copilot" ? "on" : ""}
                onClick={() => setAgentMode("copilot")}
              >
                Copilot 🔒
              </button>
              <button
                className={agentMode === "autopilot" ? "on" : ""}
                onClick={() => setAgentMode("autopilot")}
              >
                Autopilot 🚀
              </button>
            </div>
          </div>
          <div className="settings-pref">
            <span className="muted small">Reasoning effort</span>
            <div className="settings-seg">
              {EFFORT_LEVELS.map((level) => (
                <button
                  key={level}
                  className={effectiveEffort === level ? "on" : ""}
                  onClick={() => setAgentEffort(level)}
                >
                  {EFFORT_LABELS[level]}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Connection */}
        <section className="settings-card glass">
          <h3>Connection</h3>
          <p className="muted small">
            {transport === "daemon" && conn === "connected"
              ? "Connected — real execution + the agent are live."
              : "Not connected — reconnect to enable execution and the agent."}
          </p>
          {!(transport === "daemon" && conn === "connected") && (
            <button
              className="btn-ghost sm"
              onClick={() => {
                daemon.disconnect();
                useStore.getState().requestConnect();
              }}
            >
              ⚡ Reconnect daemon
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
