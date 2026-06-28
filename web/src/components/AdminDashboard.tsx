import { useEffect, useState } from "react";
import {
  formatTokens,
  getTier,
  DEFAULT_MAINTENANCE_MESSAGE,
  type AdminSessionInfo,
  type AdminUserInfo,
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
 * Admin ops dashboard (View "admin"): connected sessions (plan + usage, with live
 * controls) PLUS a "manage any user by email" lookup so offline users can be edited
 * too. Change tier, set/max-out usage, set a custom token limit, cancel agents, and
 * toggle maintenance. All actions are re-checked server-side (rejected for non-admins).
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

        {/* Manage ANY user (online or offline) by email */}
        <ManageUserPanel />

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

/** Look up any user by email and edit their plan/usage/limit (works offline). */
function ManageUserPanel() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [user, setUser] = useState<AdminUserInfo | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function lookup() {
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setErr(null);
    setNotFound(false);
    try {
      const u = await daemon.adminLookupUser(addr);
      setUser(u);
      setNotFound(!u);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card glass">
      <h3>Manage any user</h3>
      <p className="muted small">
        Look up a user by email (even if they’re offline) to change their tier, usage, or token
        limit. Requires the Firebase service account to be configured.
      </p>
      <div className="admin-maint-row">
        <input
          className="admin-input"
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
        />
        <button className="btn-neon sm" onClick={lookup} disabled={busy || !email.trim()}>
          {busy ? "Looking…" : "Look up"}
        </button>
      </div>
      {err && <div className="auth-error">⚠️ {err}</div>}
      {notFound && <p className="muted small">No user found with that email.</p>}
      {user && (
        <div className="admin-card" style={{ marginTop: 10 }}>
          <div className="admin-card-head">
            <span className="admin-email">{user.email ?? user.userId}</span>
            <span className={`tier-badge tier-${getTier(user.tier as Tier).key}`}>
              {getTier(user.tier as Tier).name}
            </span>
            <span className="muted small">{user.online ? "● online" : "○ offline"}</span>
          </div>
          <div className="admin-usage">
            <span className="muted small">
              {formatTokens(user.tokensUsed)} / {formatTokens(user.tokensLimit)} tokens this month
              {user.limitOverride != null ? " (custom limit)" : ""}
            </span>
          </div>
          <TierUsageControls
            userId={user.userId}
            tier={user.tier}
            tokensLimit={user.tokensLimit}
            limitOverride={user.limitOverride}
            onAfter={lookup}
          />
        </div>
      )}
    </section>
  );
}

/** One connected session: plan + usage at a glance, with admin controls. */
function SessionCard({ s }: { s: AdminSessionInfo }) {
  const pct = s.tokensLimit > 0 ? Math.min(100, Math.round((s.tokensUsed / s.tokensLimit) * 100)) : 0;
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
          {s.limitOverride != null ? " · custom limit" : ""}
        </span>
      </div>

      <TierUsageControls
        userId={s.userId}
        tier={s.tier}
        tokensLimit={s.tokensLimit}
        limitOverride={s.limitOverride}
        agentRunning={s.agentRunning}
        sessionId={s.sessionId}
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
  agentRunning,
  sessionId,
  onAfter,
}: {
  userId: string | null;
  tier: number;
  tokensLimit: number;
  limitOverride: number | null;
  agentRunning?: boolean;
  sessionId?: string;
  onAfter?: () => void;
}) {
  const [usageInput, setUsageInput] = useState("");
  const [limitInput, setLimitInput] = useState("");
  const disabled = !userId;
  const after = () => setTimeout(() => onAfter?.(), 300); // refresh an offline lookup

  function num(v: string): number | null {
    const n = Number(v.replace(/[, _]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function setTier(t: Tier) {
    if (userId) (daemon.adminSetTier(userId, t), after());
  }
  function setUsage() {
    const n = num(usageInput);
    if (userId && n != null) (daemon.adminSetUsage(userId, n), setUsageInput(""), after());
  }
  function setLimit() {
    const n = num(limitInput);
    if (userId && n != null) (daemon.adminSetLimit(userId, n), setLimitInput(""), after());
  }

  return (
    <div className="admin-controls">
      <div className="admin-ctl">
        <span className="muted small">Plan:</span>
        {TIERS.map((t) => (
          <button
            key={t}
            className={`btn-ghost xs ${tier === t ? "active" : ""}`}
            disabled={disabled || tier === t}
            onClick={() => setTier(t)}
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
          disabled={disabled}
          onChange={(e) => setUsageInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setUsage()}
        />
        <button className="btn-ghost xs" disabled={disabled || !usageInput.trim()} onClick={setUsage}>
          Set
        </button>
        <button
          className="btn-danger xs"
          disabled={disabled}
          title="Set usage to the limit (hit their limit / paywall them)"
          onClick={() => userId && (daemon.adminSetUsage(userId, tokensLimit), after())}
        >
          Max out
        </button>
        <button
          className="btn-ghost xs"
          disabled={disabled}
          title="Reset usage to 0"
          onClick={() => userId && (daemon.adminSetUsage(userId, 0), after())}
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
          disabled={disabled}
          onChange={(e) => setLimitInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setLimit()}
        />
        <button className="btn-ghost xs" disabled={disabled || !limitInput.trim()} onClick={setLimit}>
          Set
        </button>
        <button
          className="btn-ghost xs"
          disabled={disabled || limitOverride == null}
          title="Clear the custom limit (back to the plan default)"
          onClick={() => userId && (daemon.adminSetLimit(userId, null), after())}
        >
          Use plan default
        </button>
      </div>
      {sessionId && (
        <div className="admin-ctl">
          <button
            className="btn-ghost xs"
            disabled={!agentRunning}
            onClick={() => daemon.adminCancelAgent(sessionId)}
          >
            Cancel agent
          </button>
        </div>
      )}
    </div>
  );
}
