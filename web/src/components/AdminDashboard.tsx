import { useEffect, useState } from "react";
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

/**
 * Admin ops dashboard (View "admin"): a live view of every connected session with
 * the ability to cancel a user's agent, plus the maintenance toggle. All actions
 * go over the WebSocket and are re-checked server-side (the daemon rejects them
 * from non-admins) — this UI is convenience, not the security boundary.
 */
export function AdminDashboard() {
  const isAdmin = useStore((s) => s.isAdmin);
  const sessions = useStore((s) => s.adminSessions);
  const maintenance = useStore((s) => s.maintenance);
  const setView = useStore((s) => s.setView);
  const [msg, setMsg] = useState(maintenance.message);

  // Subscribe to the live ops feed on mount (re-subscribing is harmless).
  useEffect(() => {
    daemon.adminSubscribe();
  }, []);
  // Track the shared message if another admin edits it.
  useEffect(() => {
    setMsg(maintenance.message);
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
            refuses to run. You (admin) keep full access. Resets if the server restarts.
          </p>
          <div className="admin-maint-row">
            <input
              className="admin-input"
              placeholder="Optional message shown to users (e.g. 'Back in 10 min')"
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
            <div className="admin-table">
              <div className="admin-row admin-head">
                <span>User</span>
                <span>Project</span>
                <span>Agent</span>
                <span>Procs</span>
                <span>Connected</span>
                <span />
              </div>
              {sessions.map((s) => (
                <div className="admin-row" key={s.sessionId}>
                  <span className="admin-email">
                    {s.email ?? (s.authMode === "dev" ? "local-dev" : "—")}
                  </span>
                  <span>{s.project ?? <span className="muted">—</span>}</span>
                  <span>
                    {s.agentRunning ? (
                      <span className="admin-running">▶ step {s.agentStep ?? "?"}</span>
                    ) : (
                      <span className="muted">idle</span>
                    )}
                  </span>
                  <span>{s.procCount}</span>
                  <span className="muted">{ago(s.connectedAtMs)}</span>
                  <span>
                    <button
                      className="btn-ghost sm"
                      disabled={!s.agentRunning}
                      onClick={() => daemon.adminCancelAgent(s.sessionId)}
                    >
                      Cancel agent
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
