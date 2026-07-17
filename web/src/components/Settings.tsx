import { useState, useEffect } from "react";
import {
  getTier,
  EFFORT_LEVELS,
  EFFORT_LABELS,
  effortForTier,
  clampEffortForTier,
  effortAllowedForTier,
  tokenMultiplierForEffort,
  type BillingInterval,
  type Tier,
} from "@ide/shared";
import { useStore, type SettingsSection } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { connectGitHub, getStoredGithubToken, clearGithubToken, githubAvailable } from "../lib/githubAuth";
import { signOut, deleteAccount } from "../lib/firebaseClient";
import { saveConsent } from "../lib/daemonClient";
import { IntervalToggle, PlanCards } from "./PlanCards";
import { CheckoutOverlay } from "./CheckoutOverlay";
import { DevProgramSection } from "./DevProgramSection";
import { BRAND_LABEL, APP_VERSION } from "../lib/brand";

/**
 * Account & preferences page — a Replit-style layout: a left column of section
 * tabs + a content pane. Reached from the bottom-left account menu (which can
 * deep-link to a specific section via `settingsSection`) or the account chip.
 */
export function Settings() {
  const usage = useStore((s) => s.usage);
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const authMode = useStore((s) => s.authMode);
  const transport = useStore((s) => s.transport);
  const conn = useStore((s) => s.conn);
  const runtimeMode = useStore((s) => s.runtimeMode);
  const tier = useStore((s) => s.tier());
  const setView = useStore((s) => s.setView);
  const setUsage = useStore((s) => s.setUsage);
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const agentEffort = useStore((s) => s.agentEffort);
  const setAgentEffort = useStore((s) => s.setAgentEffort);
  const isAdmin = useStore((s) => s.isAdmin);
  const marketingOptIn = useStore((s) => s.marketingOptIn);
  const setMarketingOptIn = useStore((s) => s.setMarketingOptIn);
  const editorPrefs = useStore((s) => s.editorPrefs);
  const setEditorPrefs = useStore((s) => s.setEditorPrefs);
  const [marketingBusy, setMarketingBusy] = useState(false);

  // Which section is showing. Seed from any deep-link the account menu set, then
  // clear that one-shot flag so a later plain "open Settings" lands on Account.
  const [section, setSection] = useState<SettingsSection>(
    () => useStore.getState().settingsSection ?? "account",
  );
  useEffect(() => {
    if (useStore.getState().settingsSection) useStore.getState().setSettingsSection(null);
  }, []);

  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const [checkoutSession, setCheckoutSession] = useState<{
    tier: Tier;
    interval: BillingInterval;
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  // Danger zone: delete account.
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // GitHub connection (project sync). Only surfaced when the daemon has OAuth set.
  const [ghAvailable, setGhAvailable] = useState(false);
  const [ghConnected, setGhConnected] = useState<boolean>(() => !!getStoredGithubToken());
  const [ghBusy, setGhBusy] = useState(false);
  useEffect(() => {
    githubAvailable().then(setGhAvailable);
  }, []);
  function reconnectForGithub() {
    daemon.disconnect();
    useStore.getState().requestConnect();
  }
  async function connectGh() {
    setGhBusy(true);
    const token = await connectGitHub();
    setGhBusy(false);
    if (token) {
      daemon.setGithubToken(token);
      setGhConnected(true);
      reconnectForGithub();
    }
  }
  function disconnectGh() {
    clearGithubToken();
    daemon.setGithubToken(null);
    setGhConnected(false);
    reconnectForGithub();
  }

  const cfg = getTier(tier);
  const daemonReady = transport === "daemon" && daemon.connected;
  const email = session?.email ?? "developer@kryct.io";
  const initial = (email[0] ?? "•").toUpperCase();
  const effectiveEffort = clampEffortForTier(tier, agentEffort ?? effortForTier(tier));
  const connected = transport === "daemon" && conn === "connected";
  const runtimeLabel =
    runtimeMode === "DOCKER" ? "Docker" : runtimeMode === "LOCAL_NODE" ? "Node" : "Browser";

  // Upgrade / downgrade — same paths the dashboard uses (real checkout/changeTier
  // when on the daemon, local simulation otherwise) so billing never dead-ends.
  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    if (daemonReady) {
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

  async function toggleMarketing(next: boolean) {
    setMarketingOptIn(next); // optimistic
    setMarketingBusy(true);
    try {
      await saveConsent(next, session?.token ?? null);
    } finally {
      setMarketingBusy(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setSession(null);
    setView("dashboard");
  }

  function reconnectDaemon() {
    daemon.disconnect();
    useStore.getState().requestConnect();
  }

  function replayTour() {
    const s = useStore.getState();
    s.setTourOpen(true);
    setView(s.activeProject ? "ide" : "dashboard");
  }

  async function handleDeleteAccount() {
    if (
      !window.confirm(
        "Permanently delete your account? This can't be undone — you'll be signed out and the email is freed to register again.",
      )
    )
      return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteAccount();
      setSession(null);
      setView("dashboard");
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      setDeleteErr(
        code === "auth/requires-recent-login"
          ? "For your security, please sign out and sign back in, then delete again."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setDeleting(false);
    }
  }

  // Left-nav sections; some only show for real accounts / when available.
  const NAV: { id: SettingsSection; icon: string; label: string; show: boolean }[] = [
    { id: "account", icon: "👤", label: "Account", show: true },
    { id: "plan", icon: "⚡", label: "Plan & billing", show: true },
    { id: "editor", icon: "🖊️", label: "Editor", show: true },
    { id: "agent", icon: "✦", label: "Agent", show: true },
    { id: "connections", icon: "🐙", label: "Connections", show: ghAvailable },
    { id: "developer", icon: "🧑‍💻", label: "Developer", show: true },
    { id: "email", icon: "✉️", label: "Email", show: authMode !== "dev" },
    { id: "admin", icon: "🛡", label: "Admin", show: isAdmin },
    { id: "about", icon: "ℹ️", label: "About", show: true },
    { id: "danger", icon: "⚠️", label: "Danger zone", show: authMode !== "dev" },
  ];
  const visible = NAV.filter((n) => n.show);
  // If a deep-linked / stale section isn't visible, fall back to Account.
  const active = visible.some((n) => n.id === section) ? section : "account";

  return (
    <div className="settings">
      <header className="settings-topbar">
        <button className="btn-ghost" onClick={() => setView("dashboard")}>
          ← Back<span className="settings-back-rest"> to Dashboard</span>
        </button>
        <span className="brand">{BRAND_LABEL}</span>
        <span className="topbar-spacer" />
        <h2 className="settings-title">Settings</h2>
      </header>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          {visible.map((n) => (
            <button
              key={n.id}
              className={`settings-nav-item ${active === n.id ? "active" : ""}${n.id === "danger" ? " danger" : ""}`}
              onClick={() => setSection(n.id)}
            >
              <span className="settings-nav-icon">{n.icon}</span>
              <span className="settings-nav-label">{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          {active === "account" && (
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
                  <span className="muted small">
                    Your plan includes {cfg.tokenLabel} of agent usage each month · usage fluctuates
                  </span>
                </div>
              )}
            </section>
          )}

          {active === "plan" && (
            <section className="settings-card glass wide">
              <h3>Plan &amp; billing</h3>
              {error && <div className="auth-error">⚠️ {error}</div>}
              <IntervalToggle value={billingInterval} onChange={setBillingInterval} />
              <PlanCards
                currentTier={tier}
                billingEnabled
                busyTier={busyTier}
                interval={billingInterval}
                onChoose={choose}
                onDowngrade={downgrade}
                simulated={!daemonReady}
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
            </section>
          )}

          {active === "editor" && (
            <section className="settings-card glass">
              <h3>Editor</h3>
              <div className="settings-pref">
                <span className="muted small">Font size</span>
                <div className="settings-stepper">
                  <button
                    onClick={() => setEditorPrefs({ fontSize: Math.max(11, editorPrefs.fontSize - 1) })}
                    aria-label="Decrease font size"
                  >
                    −
                  </button>
                  <span>{editorPrefs.fontSize}px</span>
                  <button
                    onClick={() => setEditorPrefs({ fontSize: Math.min(18, editorPrefs.fontSize + 1) })}
                    aria-label="Increase font size"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="settings-pref">
                <span className="muted small">Tab size</span>
                <div className="settings-seg">
                  {[2, 4, 8].map((n) => (
                    <button
                      key={n}
                      className={editorPrefs.tabSize === n ? "on" : ""}
                      onClick={() => setEditorPrefs({ tabSize: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-pref">
                <span className="muted small">Word wrap</span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={editorPrefs.wordWrap}
                    onChange={(e) => setEditorPrefs({ wordWrap: e.target.checked })}
                  />
                  <span>{editorPrefs.wordWrap ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-pref">
                <span className="muted small">Line numbers</span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={editorPrefs.lineNumbers}
                    onChange={(e) => setEditorPrefs({ lineNumbers: e.target.checked })}
                  />
                  <span>{editorPrefs.lineNumbers ? "Shown" : "Hidden"}</span>
                </label>
              </div>
              <p className="muted small">
                Changes apply to open files instantly and are saved on this device.
              </p>
            </section>
          )}

          {active === "agent" && (
            <section className="settings-card glass">
              <h3>Agent defaults</h3>
              <div className="settings-pref">
                <span className="muted small">Reasoning effort</span>
                <div className="settings-seg">
                  {EFFORT_LEVELS.map((level) => {
                    const locked = !effortAllowedForTier(tier, level);
                    return (
                      <button
                        key={level}
                        className={`${effectiveEffort === level ? "on" : ""}${locked ? " locked" : ""}`}
                        disabled={locked}
                        title={locked ? "High reasoning is a Max-plan feature" : undefined}
                        onClick={() => setAgentEffort(level)}
                      >
                        {EFFORT_LABELS[level]}
                        {locked ? " 🔒" : ""}
                      </button>
                    );
                  })}
                </div>
                {tokenMultiplierForEffort(tier, effectiveEffort) > 1 && (
                  <span className="muted small effort-2x-warn">
                    ⚠ Medium effort burns your Sparks 2× as fast on Free.
                  </span>
                )}
              </div>
            </section>
          )}

          {active === "connections" && ghAvailable && (
            <section className="settings-card glass">
              <h3>Connections</h3>
              <div className="settings-pref">
                <span className="muted small">
                  {ghConnected
                    ? "GitHub connected — your projects stay handy across devices."
                    : "Connect GitHub to keep your projects handy across devices."}
                </span>
                {ghConnected ? (
                  <button className="btn-ghost sm" onClick={disconnectGh} disabled={ghBusy}>
                    Disconnect
                  </button>
                ) : (
                  <button className="btn-neon sm" onClick={connectGh} disabled={ghBusy}>
                    {ghBusy ? "Connecting…" : "🐙 Connect GitHub"}
                  </button>
                )}
              </div>
            </section>
          )}

          {active === "developer" && <DevProgramSection />}

          {active === "email" && authMode !== "dev" && (
            <section className="settings-card glass">
              <h3>Email</h3>
              <div className="settings-pref">
                <span className="muted small">
                  Product updates, tips, and exclusive deals sent to {email}.
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={marketingOptIn}
                    disabled={marketingBusy}
                    onChange={(e) => toggleMarketing(e.target.checked)}
                  />
                  <span>{marketingOptIn ? "Subscribed" : "Unsubscribed"}</span>
                </label>
              </div>
              <p className="muted small">
                Turning this off greatly reduces email; account and security notices are always sent.
              </p>
            </section>
          )}

          {active === "admin" && isAdmin && (
            <section className="settings-card glass">
              <h3>🛡 Admin</h3>
              <p className="muted small">
                View active sessions, cancel a stuck agent, and toggle maintenance mode.
              </p>
              <button className="btn-neon sm" onClick={() => setView("admin")}>
                Open admin dashboard
              </button>
            </section>
          )}

          {active === "about" && (
            <section className="settings-card glass">
              <h3>About &amp; status</h3>
              <p className="muted small">
                {BRAND_LABEL} · v{APP_VERSION}
              </p>
              <p className="muted small">
                {connected
                  ? `Connected — real execution + the agent are live (${runtimeLabel}).`
                  : "Not connected — reconnect to enable execution and the agent."}
              </p>
              {!connected && (
                <button className="btn-ghost sm" onClick={reconnectDaemon}>
                  ⚡ Reconnect daemon
                </button>
              )}
              <p className="muted small" style={{ marginTop: 12 }}>
                New here? Replay the quick walkthrough that shows how to build, run, and share a project.
              </p>
              <button className="btn-ghost sm" onClick={replayTour}>
                ▶ Replay the walkthrough
              </button>
              <div className="settings-about-links">
                <a href="/terms" target="_blank" rel="noreferrer">
                  Terms
                </a>
                <a href="/privacy" target="_blank" rel="noreferrer">
                  Privacy
                </a>
                <a href="/acceptable-use" target="_blank" rel="noreferrer">
                  Acceptable Use
                </a>
              </div>
            </section>
          )}

          {active === "danger" && authMode !== "dev" && (
            <section className="settings-card glass danger-zone">
              <h3>Danger zone</h3>
              <p className="muted small">
                Permanently delete your account. This can’t be undone — you’ll be signed out and the
                email is freed to register again.
              </p>
              {deleteErr && <div className="auth-error">⚠️ {deleteErr}</div>}
              <button className="btn-danger sm" onClick={handleDeleteAccount} disabled={deleting}>
                {deleting ? "Deleting…" : "🗑 Delete my account"}
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
