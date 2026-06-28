import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatTokens,
  getTier,
  DEFAULT_MAINTENANCE_MESSAGE,
  type AdminUserInfo,
  type Tier,
} from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { BRAND_LABEL } from "../lib/brand";

/** Compact "time since" label (updates whenever the list re-renders). */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TIERS = [0, 1, 2] as const;
const REFRESH_MS = 60_000; // re-pull the all-users list every minute

/**
 * Admin ops dashboard (View "admin"): every user active in the last 4 days (auto-
 * refreshing each minute) with controls to change tier, set/max-out usage, and set a
 * custom token limit — online or offline. Plus a live "active sessions" strip (agent
 * step + cancel) and the maintenance toggle. All actions are re-checked server-side.
 */
export function AdminDashboard() {
  const isAdmin = useStore((s) => s.isAdmin);
  const sessions = useStore((s) => s.adminSessions);
  const maintenance = useStore((s) => s.maintenance);
  const setView = useStore((s) => s.setView);
  const [msg, setMsg] = useState(maintenance.message || DEFAULT_MAINTENANCE_MESSAGE);

  useEffect(() => {
    daemon.adminSubscribe();
  }, []);
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

        {/* Live agent control (every connected session) */}
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
                <div className="admin-row-live" key={s.sessionId}>
                  <span className="admin-email">
                    {s.email ?? (s.authMode === "dev" ? "local-dev" : "—")}
                  </span>
                  <span className="muted small">{s.project ?? "no project"}</span>
                  {s.agentRunning ? (
                    <span className="admin-running">▶ step {s.agentStep ?? "?"}</span>
                  ) : (
                    <span className="muted small">idle</span>
                  )}
                  <span className="muted small">{ago(s.connectedAtMs)}</span>
                  <button
                    className="btn-ghost xs"
                    disabled={!s.agentRunning}
                    onClick={() => daemon.adminCancelAgent(s.sessionId)}
                  >
                    Cancel agent
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Every user in the last 4 days (auto-refreshing) */}
        <AllUsersPanel />
      </div>
    </div>
  );
}

/** Every user active in the last 4 days, auto-refreshing each minute, each editable. */
function AllUsersPanel() {
  const [users, setUsers] = useState<AdminUserInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await daemon.adminListUsers();
      setUsers(list);
      setUpdatedAt(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <section className="settings-card glass">
      <h3>
        All users{" "}
        <span className="muted small">
          · last 4 days · {users?.length ?? 0} user{users?.length === 1 ? "" : "s"} · auto-refreshes
          every minute
          {updatedAt ? ` · updated ${ago(updatedAt)} ago` : ""}
        </span>
        <button className="btn-ghost xs" style={{ marginLeft: 8 }} onClick={() => void refresh()}>
          ⟳ Refresh
        </button>
      </h3>
      {err && <div className="auth-error">⚠️ {err}</div>}
      {users == null ? (
        <p className="muted small">Loading…</p>
      ) : users.length === 0 ? (
        <p className="muted small">
          No users in the last 4 days. (If this looks wrong, the Firebase service account may not be
          configured, or the daemon hasn’t redeployed yet.)
        </p>
      ) : (
        <div className="admin-cards">
          {users.map((u) => (
            <UserCard key={u.userId} u={u} onAfter={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One user row: plan + usage at a glance, with tier / usage / limit controls. */
function UserCard({ u, onAfter }: { u: AdminUserInfo; onAfter: () => void }) {
  const pct = u.tokensLimit > 0 ? Math.min(100, Math.round((u.tokensUsed / u.tokensLimit) * 100)) : 0;
  return (
    <div className="admin-card">
      <div className="admin-card-head">
        <span className="admin-email">{u.email ?? u.userId}</span>
        <span className={`tier-badge tier-${getTier(u.tier as Tier).key}`}>
          {getTier(u.tier as Tier).name}
        </span>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {u.online ? "● online" : "○ offline"}
        </span>
      </div>
      <div className="admin-usage">
        <div className="usage-meter-bar wide">
          <span className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {formatTokens(u.tokensUsed)} / {formatTokens(u.tokensLimit)} tokens this month ({pct}%)
          {u.limitOverride != null ? " · custom limit" : ""}
        </span>
      </div>
      <TierUsageControls
        userId={u.userId}
        tier={u.tier}
        tokensLimit={u.tokensLimit}
        limitOverride={u.limitOverride}
        onAfter={onAfter}
      />
    </div>
  );
}

/** Shared tier / usage / limit editor, keyed by uid (works for online + offline). */
function TierUsageControls({
  userId,
  tier,
  tokensLimit,
  limitOverride,
  onAfter,
}: {
  userId: string;
  tier: number;
  tokensLimit: number;
  limitOverride: number | null;
  onAfter: () => void;
}) {
  const [usageInput, setUsageInput] = useState("");
  const [limitInput, setLimitInput] = useState("");
  const after = () => setTimeout(onAfter, 350); // let the write land, then refresh

  function num(v: string): number | null {
    const n = Number(v.replace(/[, _]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  return (
    <div className="admin-controls">
      <div className="admin-ctl">
        <span className="muted small">Plan:</span>
        {TIERS.map((t) => (
          <button
            key={t}
            className={`btn-ghost xs ${tier === t ? "active" : ""}`}
            disabled={tier === t}
            onClick={() => {
              daemon.adminSetTier(userId, t);
              after();
            }}
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
        />
        <button
          className="btn-ghost xs"
          disabled={!usageInput.trim()}
          onClick={() => {
            const n = num(usageInput);
            if (n != null) {
              daemon.adminSetUsage(userId, n);
              setUsageInput("");
              after();
            }
          }}
        >
          Set
        </button>
        <button
          className="btn-danger xs"
          title="Set usage to the limit (hit their limit / paywall them)"
          onClick={() => {
            daemon.adminSetUsage(userId, tokensLimit);
            after();
          }}
        >
          Max out
        </button>
        <button
          className="btn-ghost xs"
          title="Reset usage to 0"
          onClick={() => {
            daemon.adminSetUsage(userId, 0);
            after();
          }}
        >
          Reset
        </button>
      </div>
      <div className="admin-ctl">
        <span className="muted small">Limit:</span>
        <input
          className="admin-input sm"
          inputMode="numeric"
          placeholder="custom max tokens"
          value={limitInput}
          onChange={(e) => setLimitInput(e.target.value)}
        />
        <button
          className="btn-ghost xs"
          disabled={!limitInput.trim()}
          onClick={() => {
            const n = num(limitInput);
            if (n != null) {
              daemon.adminSetLimit(userId, n);
              setLimitInput("");
              after();
            }
          }}
        >
          Set
        </button>
        <button
          className="btn-ghost xs"
          disabled={limitOverride == null}
          title="Clear the custom limit (back to the plan default)"
          onClick={() => {
            daemon.adminSetLimit(userId, null);
            after();
          }}
        >
          Use plan default
        </button>
      </div>
    </div>
  );
}
