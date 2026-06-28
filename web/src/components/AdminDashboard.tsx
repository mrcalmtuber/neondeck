import { useEffect, useState } from "react";
import {
  formatTokens,
  getTier,
  DEFAULT_MAINTENANCE_MESSAGE,
  type AdminSessionInfo,
  type Tier,
} from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { BRAND_LABEL } from "../lib/brand";

/** Compact "time since" label (updates whenever the session list re-renders). */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TIERS = [0, 1, 2] as const;

/**
 * Admin ops dashboard (View "admin"): a live view of every connected session —
 * their plan + usage — with the ability to change a user's tier, set/max-out their
 * usage, cancel their agent, and toggle maintenance. All actions go over the
 * WebSocket and are re-checked server-side (the daemon rejects them from non-admins).
 */
export function AdminDashboard() {
  const isAdmin = useStore((s) => s.isAdmin);
  const sessions = useStore((s) => s.adminSessions);
  const maintenance = useStore((s) => s.maintenance);
  const setView = useStore((s) => s.setView);
  const [msg, setMsg] = useState(maintenance.message || DEFAULT_MAINTENANCE_MESSAGE);

  // Subscribe to the live ops feed on mount (re-subscribing is harmless).
  useEffect(() => {
    daemon.adminSubscribe();
  }, []);
  // Track the shared message if another admin edits it.
  useEffect(() => {
    setMsg(maintenance.message || DEFAULT_MAINTENANCE_MESSAGE);
  }, [maintenance.message]);

  if (!isAdmin) {
    return (
      <div className="settings">
        <div className="settings-body">
          <section className="settings-card glass">
            <h3>Not authorized</h3>
            <p className="muted small">This area is for admins only.</p>
            <button className="btn-ghost sm" onClick={() => setView("dashboard")}>
              ← Back
            </button>
          </section>
        </div>
      </div>
    );
  }

  const running = sessions.filter((s) => s.agentRunning).length;

  return (
    <div className="settings">
      <header className="settings-topbar">
        <button className="btn-ghost" onClick={() => setView("dashboard")}>
          ← Back to Dashboard
        </button>
        <span className="brand">{BRAND_LABEL}</span>
        <span className="topbar-spacer" />
        <h2 className="settings-title">🛡 Admin</h2>
      </header>

      <div className="settings-body">
        {/* MAINTENANCE (temporary — remove later) */}
        <section className="settings-card glass">
          <h3>Maintenance mode</h3>
          <p className="muted small">
            When ON, every non-admin is locked out with a red full-screen notice and the agent
            refuses to run. You (admin) keep full access. Resets if the server restarts (set
            MAINTENANCE_MODE=on in the environment to survive restarts).
          </p>
          <div className="admin-maint-row">
            <textarea
              className="admin-input"
              rows={2}
              placeholder="Message shown to locked-out users"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
            />
            {maintenance.on ? (
              <button className="btn-ghost sm" onClick={() => daemon.adminSetMaintenance(false, msg)}>
                Turn OFF
              </button>
            ) : (
              <button className="btn-danger sm" onClick={() => daemon.adminSetMaintenance(true, msg)}>
                Turn ON (lock out users)
              </button>
            )}
          </div>
          <div className={`admin-maint-status ${maintenance.on ? "on" : ""}`}>
            {maintenance.on
              ? "● Maintenance is ON — users are locked out"
              : "○ Maintenance is OFF — normal access"}
          </div>
        </section>

        <section className="settings-card glass">
          <h3>
            Active sessions{" "}
            <span className="muted small">
              · {sessions.length} connected · {running} agent{running === 1 ? "" : "s"} running
            </span>
          </h3>
          {sessions.length === 0 ? (
            <p className="muted small">No one is connected right now.</p>
          ) : (
            <div className="admin-cards">
              {sessions.map((s) => (
                <SessionCard key={s.sessionId} s={s} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** One connected session: plan + usage at a glance, with admin controls. */
function SessionCard({ s }: { s: AdminSessionInfo }) {
  const [usageInput, setUsageInput] = useState("");
  const pct = s.tokensLimit > 0 ? Math.min(100, Math.round((s.tokensUsed / s.tokensLimit) * 100)) : 0;

  function setUsage() {
    const n = Number(usageInput.replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n < 0) return;
    daemon.adminSetUsage(s.sessionId, n);
    setUsageInput("");
  }

  return (
    <div className="admin-card">
      <div className="admin-card-head">
        <span className="admin-email">{s.email ?? (s.authMode === "dev" ? "local-dev" : "—")}</span>
        <span className={`tier-badge tier-${getTier(s.tier as Tier).key}`}>
          {getTier(s.tier as Tier).name}
        </span>
        {s.agentRunning ? (
          <span className="admin-running">▶ agent · step {s.agentStep ?? "?"}</span>
        ) : (
          <span className="muted small">idle</span>
        )}
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {s.project ?? "no project"} · {s.procCount} proc{s.procCount === 1 ? "" : "s"} ·{" "}
          {ago(s.connectedAtMs)}
        </span>
      </div>

      <div className="admin-usage">
        <div className="usage-meter-bar wide">
          <span className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {formatTokens(s.tokensUsed)} / {formatTokens(s.tokensLimit)} tokens this month ({pct}%)
        </span>
      </div>

      <div className="admin-controls">
        <div className="admin-ctl">
          <span className="muted small">Plan:</span>
          {TIERS.map((t) => (
            <button
              key={t}
              className={`btn-ghost xs ${s.tier === t ? "active" : ""}`}
              disabled={s.tier === t}
              onClick={() => daemon.adminSetTier(s.sessionId, t)}
            >
              {getTier(t).name}
            </button>
          ))}
        </div>
        <div className="admin-ctl">
          <span className="muted small">Usage:</span>
          <input
            className="admin-input sm"
            inputMode="numeric"
            placeholder="tokens"
            value={usageInput}
            onChange={(e) => setUsageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setUsage()}
          />
          <button className="btn-ghost xs" disabled={!usageInput.trim()} onClick={setUsage}>
            Set
          </button>
          <button
            className="btn-danger xs"
            title="Set usage to the plan limit (hit their limit / paywall them)"
            onClick={() => daemon.adminSetUsage(s.sessionId, s.tokensLimit)}
          >
            Max out
          </button>
          <button
            className="btn-ghost xs"
            title="Reset usage to 0"
            onClick={() => daemon.adminSetUsage(s.sessionId, 0)}
          >
            Reset
          </button>
        </div>
        <div className="admin-ctl">
          <button
            className="btn-ghost xs"
            disabled={!s.agentRunning}
            onClick={() => daemon.adminCancelAgent(s.sessionId)}
          >
            Cancel agent
          </button>
        </div>
      </div>
    </div>
  );
}
