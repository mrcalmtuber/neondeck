import { useEffect, useRef } from "react";
import { useStore } from "./lib/store";
import { Dashboard } from "./components/Dashboard";
import { Hub } from "./components/Hub";
import { Layout } from "./components/Layout";
import { Settings } from "./components/Settings";
import { AuthGateway } from "./components/AuthGateway";
import { Paywall } from "./components/Paywall";
import { SubscriptionModal } from "./components/SubscriptionModal";
import { AdminDashboard } from "./components/AdminDashboard";
import { MaintenanceOverlay } from "./components/MaintenanceOverlay";
import { daemon } from "./lib/daemonClient";
import { attachToRun } from "./lib/agent";
import { saveChat } from "./lib/chatHistory";
import { getStoredGithubToken } from "./lib/githubAuth";
import { currentSession, onAuthChange } from "./lib/firebaseClient";
import { ensureUserDoc } from "./lib/projectsService";
import { BRAND_MARK } from "./lib/brand";

/**
 * Top-level routing (Firebase auth gate in front of everything):
 *   auth not yet checked      → splash
 *   not authenticated         → Login / Registration gateway (no bypass)
 *   authed, mounting          → splash while the workspace is provisioned
 *   authed + view "dashboard" → Replit-style home portal (default landing)
 *   authed + view "hub"       → legacy daemon project hub (fallback route)
 *   authed + view "ide"       → single-view workspace
 * The Paywall overlays the workspace whenever the token pool is exhausted.
 */
export function App() {
  const conn = useStore((s) => s.conn);
  const transport = useStore((s) => s.transport);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const authReady = useStore((s) => s.authReady);
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const setAuthReady = useStore((s) => s.setAuthReady);
  const setUsage = useStore((s) => s.setUsage);
  const setPaywall = useStore((s) => s.setPaywall);
  const setConn = useStore((s) => s.setConn);
  const connectNonce = useStore((s) => s.connectNonce);
  const connError = useStore((s) => s.connError);
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);

  // Apply the saved theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Resolve the initial Firebase session, then track sign-in / sign-out / token
  // refreshes. There is no bypass — when there is no session we always show the
  // AuthGateway.
  useEffect(() => {
    let mounted = true;
    (async () => {
      let s = null;
      try {
        s = await currentSession();
      } catch {
        /* never let auth init crash the shell */
      }
      if (!mounted) return;
      if (s) setSession(s);
      setAuthReady(true);
    })();
    const off = onAuthChange((s) => setSession(s));
    return () => {
      mounted = false;
      off();
    };
  }, [setSession, setAuthReady]);

  // Keep the daemon client's handshake credentials in sync with the session.
  useEffect(() => {
    daemon.setAuth(session?.token ?? null, session?.userId ?? null);
    daemon.setGithubToken(getStoredGithubToken()); // browser-held GitHub token for sync
  }, [session]);

  // Once authenticated, connect to the local daemon (the only transport — real
  // isolated workspaces + the agent) and land on the dashboard. If the daemon
  // isn't reachable we show the Retry screen below; there is no browser fallback.
  //
  // IMPORTANT: this effect is keyed on `connectNonce` + the session identity,
  // NOT on `conn`. Earlier it depended on `conn`, so the `setConn("connecting")`
  // below re-fired the effect and its own cleanup flipped a `cancelled` flag
  // before the (fast) handshake resolved — silently discarding the `hello_ok`
  // and leaving `conn` stuck on "connecting" forever. `inFlightRef` guards
  // against re-entry (incl. React.StrictMode's dev double-invoke), and a
  // session-id recheck (not a cleanup flag) drops only genuinely stale results.
  const inFlightRef = useRef(false);
  useEffect(() => {
    if (!authReady || !session) return;
    if (inFlightRef.current) return;
    if (useStore.getState().conn === "connected") return;
    inFlightRef.current = true;
    const uid = session.userId; // result is stale only if the session changes
    // Preserve a "reconnecting" label across the attempt (set by daemon.onDrop)
    // so a transient drop reads "Reconnecting…" instead of a fresh "Connecting…".
    setConn(useStore.getState().conn === "reconnecting" ? "reconnecting" : "connecting");
    ensureUserDoc(session); // best-effort users/{uid} upsert
    (async () => {
      try {
        const info = await daemon.connect();
        if (useStore.getState().session?.userId !== uid) return;
        const s = useStore.getState();
        s.setTransport("daemon");
        s.setHello(info);
        s.setConn("connected");
        // The daemon's open workspace is per-connection. If a project was open
        // before a reconnect, re-open it on the new session so file/agent ops
        // don't hit "Open a project from the Hub first." On a fresh load this is
        // null (no project yet), so we land on the dashboard as before.
        if (info.activeRun && !s.activeProject) {
          // Full reload while an agent was running: the daemon held the run alive
          // and reattached this socket. Restore the live UI (project + chat + stream)
          // since our in-memory state was wiped by the reload.
          const { project, promptId } = info.activeRun;
          s.setActiveProject(project);
          s.loadChatForProject(project); // restore chat-so-far from localStorage
          s.setView("ide");
          s.setAgentRunning(true, "Reconnected — resuming your run…");
          attachToRun(promptId); // re-subscribe the live stream to this run
          daemon
            .openProject(project)
            .then(({ root }) => useStore.getState().setTree(root))
            .catch((e) => console.warn("[daemon] re-open after reattach failed:", e));
        } else if (s.activeProject) {
          s.setPreview(null, null); // fresh session — any prior preview server is gone
          daemon
            .openProject(s.activeProject)
            .then(({ root }) => useStore.getState().setTree(root))
            .catch((e) => console.warn("[daemon] re-open project failed:", e));
          // In-tab reconnect where a run is still live: ensure the stream is attached
          // (idempotent — a no-op if the in-memory listener already survived the drop).
          if (info.activeRun) attachToRun(info.activeRun.promptId);
        } else {
          s.setView("dashboard");
        }
      } catch (err) {
        if (useStore.getState().session?.userId !== uid) return;
        // Daemon is REQUIRED — no browser fallback. Record why and show a Retry
        // screen; the user reconnects with requestConnect() when the daemon is up.
        console.warn("[daemon] connect failed:", err);
        const s = useStore.getState();
        s.setConnError(err instanceof Error ? err.message : String(err));
        s.setConn("disconnected");
      } finally {
        inFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, session?.userId, connectNonce, setConn]);

  // Sign-out: drop the daemon connection and return to a clean state.
  useEffect(() => {
    if (authReady && !session && conn === "connected") {
      daemon.disconnect();
      setConn("disconnected");
      useStore.getState().setView("dashboard");
    }
  }, [session, authReady, conn, setConn]);

  // Auto-reconnect on an unexpected socket drop (precaution for flaky / mobile
  // networks + the daemon's heartbeat terminate). Bumping the connect nonce reuses
  // the connect effect above, which also re-opens the active project.
  useEffect(() => {
    daemon.onDrop = () => {
      if (!useStore.getState().session) return; // signed out → stay down
      useStore.getState().setConn("reconnecting");
      useStore.getState().requestConnect();
    };
    return () => {
      daemon.onDrop = null;
    };
  }, []);

  // Live token meter + paywall + admin/maintenance/notice pushed from the daemon.
  useEffect(() => {
    if (conn !== "connected" || transport !== "daemon") return;
    return daemon.onMessage((m) => {
      if (m.type === "usage_update") setUsage(m.usage);
      else if (m.type === "paywall") {
        setUsage(m.usage);
        setPaywall({ usage: m.usage, message: m.message });
      } else if (m.type === "admin_state") {
        useStore.getState().setAdminSessions(m.sessions);
        useStore.getState().setMaintenance(m.maintenance);
      } else if (m.type === "maintenance_changed") {
        useStore.getState().setMaintenance(m.maintenance);
      } else if (m.type === "notice") {
        useStore.getState().setNotice({ level: m.level, text: m.text });
      }
    });
  }, [conn, transport, setUsage, setPaywall]);

  // Auto-dismiss a transient notice toast.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  // Persist the agent chat per project (debounced) so a reload / project switch
  // restores it. Debounce is essential: appendToLast fires per streamed token,
  // so we must not write to localStorage on every delta.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useStore.subscribe((state, prev) => {
      if (state.messages === prev.messages) return;
      const project = state.activeProject;
      if (!project) return;
      const { userId, messages } = state;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveChat(userId, project, messages), 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, []);

  // Returning from Stripe Checkout: refresh tier/usage and clean the URL.
  useEffect(() => {
    if (conn !== "connected") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout")) {
      daemon.me().then((r) => r && setUsage(r.usage));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [conn, setUsage]);

  if (!authReady) {
    return (
      <div className="splash">
        <div className="splash-mark">{BRAND_MARK}</div>
        <div className="muted">Loading NeonDeck…</div>
      </div>
    );
  }
  if (!session) return <AuthGateway />;
  if (conn !== "connected") {
    return (
      <div className="splash">
        <div className="splash-mark">{BRAND_MARK}</div>
        {connError ? (
          <>
            <div className="muted">⚠ Couldn't reach the workspace daemon.</div>
            <div className="muted small">{connError}</div>
            <button className="btn-primary" onClick={() => useStore.getState().requestConnect()}>
              ⚡ Retry connection
            </button>
          </>
        ) : (
          <div className="muted">
            {conn === "reconnecting" ? "Reconnecting…" : "Connecting to your workspace…"}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {view === "dashboard" ? (
        <Dashboard />
      ) : view === "settings" ? (
        <Settings />
      ) : view === "admin" ? (
        <AdminDashboard />
      ) : view === "hub" ? (
        <Hub />
      ) : (
        <Layout />
      )}
      <Paywall />
      <SubscriptionModal />
      {/* MAINTENANCE (temporary — remove later) */}
      <MaintenanceOverlay />
      {notice && (
        <div
          className={`notice-toast ${notice.level}`}
          role="status"
          onClick={() => setNotice(null)}
        >
          <span>{notice.text}</span>
          <button className="notice-x" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </>
  );
}
