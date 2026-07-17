import {
  DAEMON_URL,
  DAEMON_PORT,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type FileNode,
  type RuntimeMode,
  type Blueprint,
  type ProjectInfo,
  type GitCommit,
  type ProcessInfo,
  type AgentMode,
  type AgentEffort,
  type DbColumn,
  type DbRow,
  type DbTableMeta,
  type TunnelStatusMessage,
  type UsageSnapshot,
  type Tier,
  type MaintenanceState,
  type SearchMatch,
  type AdminUserInfo,
  type DevStatus,
} from "@ide/shared";

/**
 * WebSocket endpoint the browser dials, resolved in priority order:
 *   1. VITE_DAEMON_URL — explicit build-time override (e.g. "wss://node.kryct.io").
 *   2. localhost / 127.0.0.1 — the local dev node (ws://127.0.0.1:5050).
 *   3. HTTPS page — SAME ORIGIN (wss://<host>, no port). This is the PaaS / reverse-
 *      proxy case: the daemon serves the web, API, WS, and previews on one origin,
 *      so a single static build "just works" behind any HTTPS URL with no rebuild.
 *   4. plain-HTTP non-localhost — the daemon's own port on that host
 *      (ws://<host>:5050), for a direct LAN deploy with no reverse proxy.
 * The REST + preview base is derived from the result (ws→http, wss→https).
 */
function resolveDaemonWs(): string {
  const override = import.meta.env.VITE_DAEMON_URL;
  if (override) return override;
  if (typeof window !== "undefined") {
    const { hostname, host, protocol } = window.location;
    if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
      if (protocol === "https:") return `wss://${host}`; // same origin (incl. its port)
      return `ws://${hostname}:${DAEMON_PORT}`; // direct LAN, no proxy
    }
  }
  return DAEMON_URL;
}

export const DAEMON_WS = resolveDaemonWs();
/** HTTP(S) base for the daemon — REST calls AND preview iframe URLs are built off it. */
export const DAEMON_HTTP = DAEMON_WS.replace(/^ws(s?):\/\//, "http$1://");

/** Step 2 of the email unsubscribe: the in-app confirmation popup calls this to
 *  actually stop all marketing mail. The signed token authorizes it (no login). */
export async function confirmUnsubscribe(uid: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/email/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ u: uid, t: token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Persist the sign-up / Settings consent choice (marketing opt-in). Best-effort
 *  — a failure here must never block getting into the product. */
export async function saveConsent(marketingOptIn: boolean, token: string | null): Promise<void> {
  try {
    await fetch(`${DAEMON_HTTP}/api/account/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ marketingOptIn }),
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Ask the daemon to send a BRANDED email-verification email via Resend. Returns
 * `{ok:true}` when it sent; `{ok:false,fallback:true}` (or a thrown/aborted
 * network call) → the caller falls back to Firebase's own client-side sender.
 */
export async function requestEmailVerification(
  token: string | null,
): Promise<{ ok: boolean; fallback?: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/auth/verify-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ token }),
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error("Too many requests — try again in a few minutes.");
    if (!res.ok) return { ok: false, fallback: true };
    return (await res.json()) as { ok: boolean; fallback?: boolean };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Send a suspension appeal to the support inbox. `{ok:false,fallback:true}`
 * (or a network failure) → the caller shows the plain mailto: link instead.
 * Throws with a readable message on 4xx (too short / rate limited).
 */
export async function submitSuspensionAppeal(
  message: string,
  token: string | null,
): Promise<{ ok: boolean; fallback?: boolean }> {
  const res = await fetch(`${DAEMON_HTTP}/api/support/appeal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not send your appeal — try the email link below.");
  }
  return (await res.json()) as { ok: boolean; fallback?: boolean };
}

/**
 * Ask the daemon to send a branded password-reset email (pre-auth, plain
 * fetch — no WS session exists yet). `{ok:false,fallback:true}` or a thrown
 * error → the caller falls back to Firebase's default sender.
 */
export async function requestPasswordReset(
  email: string,
): Promise<{ ok: boolean; fallback?: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/auth/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error("Too many reset requests — try again in a few minutes.");
    if (!res.ok) return { ok: false, fallback: true };
    return (await res.json()) as { ok: boolean; fallback?: boolean };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Download a project's snapshot backup as a .zip (the only remaining action —
 * besides Restore — on an archived project). Authenticated, plain fetch.
 */
export async function downloadProjectZip(name: string, token: string | null): Promise<Blob> {
  const res = await fetch(`${DAEMON_HTTP}/api/project-zip?name=${encodeURIComponent(name)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.blob();
}

type Listener = (msg: ServerMessage) => void;

let _id = 0;
const nextId = () => `req-${++_id}-${Date.now().toString(36)}`;

export interface HelloInfo {
  agentReady: boolean;
  model: string;
  runtimeMode: RuntimeMode;
  dockerAvailable: boolean;
  proxyPort: number;
  projectsRootName: string;
  userId: string;
  authMode: "firebase" | "dev";
  usage: UsageSnapshot;
  billingEnabled: boolean;
  isAdmin: boolean;
  maintenance: MaintenanceState;
  suspended: boolean;
  suspendMessage: string;
  suspendAppealable: boolean;
  marketingOptIn: boolean;
  /** Separate origin previews are served from (cross-origin isolation), or "" for
   *  same-origin previews (client then drops the iframe's allow-same-origin). */
  previewOrigin: string;
  /** Present when this connection reattached to a still-running agent (e.g. after a
   *  full reload) — the client uses it to restore the live run's UI. */
  activeRun?: { promptId: string; project: string } | null;
  /** Developer-program state, or null when the program is disabled / dev auth. */
  dev: DevStatus | null;
}

/**
 * Browser-side client for the local daemon WebSocket bridge.
 *
 * The agent now runs inside the daemon: the browser only sends prompt text and
 * listens for streamed `agent_*` events. The agent API key never reaches the
 * browser.
 */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private token: string | null = null;
  private uid: string | null = null;
  /** GitHub OAuth token (browser-held) sent on the handshake for project sync. */
  private githubToken: string | null = null;
  /** Project open on the CURRENT socket. The daemon tracks the active workspace
   *  per-connection, so this resets on disconnect and must be re-opened after a
   *  reconnect (otherwise file/agent ops hit "Open a project from the Hub first"). */
  openedProject: string | null = null;
  info: HelloInfo = {
    agentReady: false,
    model: "",
    runtimeMode: "LOCAL_NODE",
    dockerAvailable: false,
    proxyPort: 9000,
    projectsRootName: "",
    userId: "",
    authMode: "dev",
    usage: { tier: 0, tokensUsed: 0, tokensLimit: 0, period: "", limitReached: false },
    billingEnabled: false,
    isAdmin: false,
    maintenance: { on: false, message: "" },
    suspended: false,
    suspendMessage: "",
    suspendAppealable: true,
    marketingOptIn: true,
    previewOrigin: "",
    dev: null,
  };

  // ---- auto-reconnect (precaution for flaky/mobile networks) ----
  /** Set true by an explicit disconnect() so a deliberate close isn't reconnected. */
  private intentional = false;
  /** True once the handshake completed, so we only reconnect a DROP, not a failed
   *  initial connect. */
  private handshakeOk = false;
  /** App-registered hook fired when an established socket drops unexpectedly. */
  onDrop: (() => void) | null = null;

  /** Set the Firebase ID token + userId sent on the next handshake. */
  setAuth(token: string | null, userId: string | null): void {
    this.token = token;
    this.uid = userId;
  }

  /** Set the GitHub OAuth token sent on the next handshake (project sync). */
  setGithubToken(token: string | null): void {
    this.githubToken = token;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Open the socket and complete the `hello` handshake. The returned promise is
   * guaranteed to settle exactly once — on `hello_ok`, on a socket error/close,
   * or on an overall timeout — so a stalled handshake can never leave the caller
   * (App.tsx) stuck forever on the "Provisioning…" splash. A rejection lets the
   * caller show the "couldn't reach the daemon · Retry" screen.
   */
  async connect(timeoutMs = 6000): Promise<HelloInfo> {
    // A (re)connect attempt is, by definition, not an intentional close.
    this.intentional = false;
    this.handshakeOk = false;
    // Re-entry guard: never leave an orphaned socket from a prior attempt (e.g. a
    // re-fired effect or StrictMode double-invoke). A stale socket can otherwise
    // shadow the live one and the handshake silently stalls. Close it WITHOUT
    // marking intent (so it doesn't suppress a later legitimate reconnect).
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close();
      } catch {
        /* already closing */
      }
    }
    this.openedProject = null;

    // Fast reachability pre-flight: turns "daemon down / wrong port / blocked"
    // into an instant, specific error instead of a multi-second socket stall.
    // (/api/health is CORS-enabled for the daemon's allowed origins.)
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${DAEMON_HTTP}/api/health`, { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Daemon not reachable at ${DAEMON_WS} (${reason}).`);
    }

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const dbg = (...a: unknown[]) =>
        console.debug("[daemon]", ...a, `+${Date.now() - t0}ms`);
      const ws = new WebSocket(DAEMON_WS);
      this.ws = ws;
      dbg("dialing", DAEMON_WS);

      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      timer = setTimeout(
        () =>
          finish(() => {
            try {
              ws.close();
            } catch {
              /* already closing */
            }
            reject(new Error("Daemon handshake timed out."));
          }),
        timeoutMs,
      );

      ws.onmessage = (ev) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        for (const l of this.listeners) l(msg);
      };
      ws.onerror = () => {
        dbg("ws error");
        finish(() => reject(new Error("Could not reach your workspace.")));
      };
      ws.onclose = (ev) => {
        dbg("ws close", ev.code, ev.reason);
        this.ws = null;
        // No-op once the handshake has resolved; only matters if the socket dies
        // before `hello_ok`, in which case we reject so the caller can fall back.
        finish(() => reject(new Error("Daemon connection closed before handshake.")));
        // Post-handshake DROP (mobile/flaky net, server heartbeat terminate) that
        // we didn't ask for → let the app auto-reconnect + restore the workspace.
        if (this.handshakeOk && !this.intentional) {
          this.handshakeOk = false;
          this.onDrop?.();
        }
      };
      ws.onopen = async () => {
        dbg("ws open — sending hello");
        try {
          const hello = await this.request({
            type: "hello",
            id: nextId(),
            protocolVersion: PROTOCOL_VERSION,
            token: this.token ?? undefined,
            userId: this.uid ?? undefined,
            githubToken: this.githubToken ?? undefined,
          });
          if (hello.type === "hello_ok") {
            this.info = {
              agentReady: hello.agentReady,
              model: hello.model,
              runtimeMode: hello.runtimeMode,
              dockerAvailable: hello.dockerAvailable,
              proxyPort: hello.proxyPort,
              projectsRootName: hello.projectsRootName,
              userId: hello.userId,
              authMode: hello.authMode,
              usage: hello.usage,
              billingEnabled: hello.billingEnabled,
              isAdmin: hello.isAdmin,
              maintenance: hello.maintenance,
              suspended: hello.suspended,
              suspendMessage: hello.suspendMessage,
              suspendAppealable: hello.suspendAppealable !== false,
              marketingOptIn: hello.marketingOptIn !== false,
              previewOrigin: hello.previewOrigin ?? "",
              activeRun: hello.activeRun ?? null,
              dev: hello.dev ?? null,
            };
            this.handshakeOk = true;
            dbg("hello_ok — connected");
            finish(() => resolve(this.info));
          } else {
            dbg("handshake rejected");
            finish(() => reject(new Error("Handshake rejected by daemon.")));
          }
        } catch (err) {
          finish(() => reject(err));
        }
      };
    });
  }

  disconnect(): void {
    this.intentional = true; // a deliberate close — don't auto-reconnect
    this.handshakeOk = false;
    this.ws?.close();
    this.ws = null;
    this.openedProject = null;
  }

  /** Subscribe to every inbound message (terminal, workspace, agent, preview). */
  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Daemon not connected.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Fire a message and resolve with the first matching non-stream reply. Rejects
   * if no reply arrives within `timeoutMs` so a lost/never-sent reply can't hang
   * the caller forever (and the message listener is always removed — no leak).
   */
  private request(msg: ClientMessage, timeoutMs = 8000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      // Single settle path: stop the timer, detach the listener, run once.
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        fn();
      };
      const off = this.onMessage((m) => {
        if (m.id !== msg.id) return;
        if (m.type === "error") settle(() => reject(new Error(m.message)));
        else if (m.type !== "terminal_output") settle(() => resolve(m));
      });
      timer = setTimeout(
        () => settle(() => reject(new Error("The daemon did not reply in time."))),
        timeoutMs,
      );
      try {
        this.send(msg);
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  // -------- File workspace --------

  async listTree(): Promise<FileNode> {
    const res = await this.request({ type: "list_tree", id: nextId() });
    if (res.type !== "tree") throw new Error("Unexpected tree response");
    return res.root;
  }

  async readFile(filePath: string): Promise<string> {
    const res = await this.request({ type: "read_file", id: nextId(), filePath });
    if (res.type !== "file_content") throw new Error("Unexpected read response");
    return res.content;
  }

  /** Project-wide text search across the open workspace. */
  async searchFiles(
    query: string,
    opts: { caseSensitive?: boolean } = {},
  ): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    const res = await this.request({
      type: "search_files",
      id: nextId(),
      query,
      caseSensitive: opts.caseSensitive,
    });
    if (res.type !== "search_results") throw new Error("Unexpected search response");
    return { matches: res.matches, truncated: res.truncated };
  }

  /** MANUAL_UPDATE — editor save / write file contents. */
  async manualUpdate(filePath: string, content: string): Promise<void> {
    const res = await this.request({ type: "manual_update", id: nextId(), filePath, content });
    if (res.type !== "manual_ok") throw new Error("Write failed");
  }

  /** MANUAL_CREATE — new empty file or folder. */
  async manualCreate(filePath: string, kind: "file" | "dir"): Promise<void> {
    const res = await this.request({ type: "manual_create", id: nextId(), filePath, kind });
    if (res.type !== "manual_ok") throw new Error("Create failed");
  }

  /** MANUAL_DELETE — remove a file or folder. */
  async manualDelete(filePath: string): Promise<void> {
    const res = await this.request({ type: "manual_delete", id: nextId(), filePath });
    if (res.type !== "manual_ok") throw new Error("Delete failed");
  }

  /** Header toolbar: force a runtime mode (or "auto"). */
  async setRuntime(mode: RuntimeMode | "auto"): Promise<{ runtimeMode: RuntimeMode; dockerAvailable: boolean }> {
    const res = await this.request({ type: "set_runtime", id: nextId(), mode });
    if (res.type !== "runtime_changed") throw new Error("Runtime switch failed");
    return { runtimeMode: res.runtimeMode, dockerAvailable: res.dockerAvailable };
  }

  async startContainer(
    image: string,
    startCommand: string,
    appPort: number,
  ): Promise<{ proxyUrl: string; slot: string }> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "container_started") {
          off();
          // Build the absolute preview URL. Prefer a configured SEPARATE preview
          // origin (cross-origin isolation of untrusted app code); otherwise fall
          // back to our own daemon base so it works same-origin behind a PaaS/tunnel
          // and in local dev. The server's m.proxyUrl is a relative path.
          const base = (this.info.previewOrigin || DAEMON_HTTP).replace(/\/$/, "");
          resolve({ proxyUrl: `${base}/previews/${m.slot}/`, slot: m.slot });
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      this.send({ type: "start_container", id, image, startCommand, appPort });
    });
  }

  // -------- Agent (server-side loop) --------

  /** Send a prompt to the daemon-hosted agent. Returns the correlation id. */
  agentPrompt(prompt: string, mode: AgentMode, effort?: AgentEffort): string {
    const id = nextId();
    this.send({ type: "agent_prompt", id, prompt, mode, effort });
    return id;
  }

  /** Copilot mode: approve or reject a parked tool call for the active prompt. */
  approveTool(promptId: string, approve: boolean): void {
    this.send({ type: "approve_tool", id: promptId, approve });
  }

  /** Flip the daemon's interrupt: break the loop + kill running children. */
  stopAgent(): void {
    this.send({ type: "stop_agent", id: nextId() });
  }

  // -------- Admin ops (daemon rejects these from non-admins) --------
  /** Start receiving live admin_state pushes for the ops dashboard. */
  adminSubscribe(): void {
    this.send({ type: "admin_subscribe", id: nextId() });
  }
  /** Cancel the agent run on another user's session. */
  adminCancelAgent(sessionId: string): void {
    this.send({ type: "admin_cancel_agent", id: nextId(), sessionId });
  }
  /** MAINTENANCE (temporary — remove later): flip the lockout for non-admins. */
  adminSetMaintenance(on: boolean, message: string): void {
    this.send({ type: "admin_set_maintenance", id: nextId(), on, message });
  }
  /** Change ANY user's subscription tier (0=Free,1=Pro,2=Max), by uid. */
  adminSetTier(userId: string, tier: number): void {
    this.send({ type: "admin_set_tier", id: nextId(), userId, tier });
  }
  /** Set ANY user's monthly token usage to an absolute value (e.g. max out), by uid. */
  adminSetUsage(userId: string, tokensUsed: number): void {
    this.send({ type: "admin_set_usage", id: nextId(), userId, tokensUsed });
  }
  /** Set (number) or clear (null) ANY user's custom monthly token limit, by uid. */
  adminSetLimit(userId: string, limit: number | null): void {
    this.send({ type: "admin_set_limit", id: nextId(), userId, limit });
  }
  /** Look up ANY user by email (online or not) to view/edit their plan + usage. */
  async adminLookupUser(email: string): Promise<AdminUserInfo | null> {
    const res = await this.request({ type: "admin_lookup_user", id: nextId(), email });
    if (res.type !== "admin_user") throw new Error("Unexpected lookup response");
    return res.user;
  }
  /** Every user active in the last `sinceMs` window (default 4 days, server-side). */
  async adminListUsers(sinceMs?: number): Promise<AdminUserInfo[]> {
    const res = await this.request({ type: "admin_list_users", id: nextId(), sinceMs });
    if (res.type !== "admin_users") throw new Error("Unexpected list response");
    return res.users;
  }
  /** Suspend / un-suspend ANY user (locks them out with a custom message). */
  adminSetSuspended(userId: string, suspended: boolean, message: string): void {
    this.send({ type: "admin_set_suspended", id: nextId(), userId, suspended, message });
  }

  // -------- Hub / projects --------

  async listProjects(): Promise<ProjectInfo[]> {
    const res = await this.request({ type: "list_projects", id: nextId() });
    if (res.type !== "projects") throw new Error("Unexpected projects response");
    return res.projects;
  }

  async createProject(name: string, blueprint: Blueprint): Promise<ProjectInfo> {
    const res = await this.request({ type: "create_project", id: nextId(), name, blueprint });
    if (res.type !== "project_created") throw new Error("Create project failed");
    return res.project;
  }

  async openProject(name: string): Promise<{ workspaceName: string; root: FileNode }> {
    const res = await this.request({ type: "open_project", id: nextId(), name });
    if (res.type !== "project_opened") throw new Error("Open project failed");
    this.openedProject = name; // this socket now has a workspace for file/agent ops
    return { workspaceName: res.workspaceName, root: res.root };
  }

  async deleteProject(name: string): Promise<void> {
    const res = await this.request({ type: "delete_project", id: nextId(), name });
    if (res.type !== "project_deleted") throw new Error("Delete project failed");
    if (this.openedProject === name) this.openedProject = null;
  }

  /** Un-archive a snapshot project / clear its inactivity warning (the next
   *  normal open performs the actual file restore). */
  async restoreProject(name: string): Promise<void> {
    const res = await this.request({ type: "restore_project", id: nextId(), name });
    if (res.type !== "project_restored") throw new Error("Restore failed");
  }

  // -------- Feature A: inline AI --------

  /** Stream a plain-English explanation. Resolves when ai_done arrives. */
  explainCode(code: string, onDelta: (text: string) => void): Promise<void> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "ai_delta") onDelta(m.text);
        else if (m.type === "ai_done") {
          off();
          resolve();
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      this.send({ type: "ai_explain", id, code });
    });
  }

  /** Request a corrected version of a snippet; resolves with original + fixed. */
  fixCode(filePath: string, code: string): Promise<{ original: string; fixed: string }> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "ai_fix_result") {
          off();
          resolve({ original: m.original, fixed: m.fixed });
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      this.send({ type: "ai_fix", id, filePath, code });
    });
  }

  /**
   * Shell tool: run one command in the open workspace, streaming output as it
   * arrives. Resolves with the exit code (null = killed/timeout). Uses the
   * existing `run_command` protocol (tier-gated server-side like agent commands).
   */
  runCommand(
    command: string,
    onOutput: (data: string, stream: "stdout" | "stderr") => void,
  ): Promise<number | null> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "terminal_output") onOutput(m.data, m.stream);
        else if (m.type === "command_exit") {
          off();
          resolve(m.exitCode);
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      try {
        this.send({ type: "run_command", id, command });
      } catch (err) {
        off();
        reject(err);
      }
    });
  }

  // -------- Feature B: git --------

  async gitLog(): Promise<{ isRepo: boolean; commits: GitCommit[] }> {
    const res = await this.request({ type: "git_log", id: nextId() });
    if (res.type !== "git_history") throw new Error("git log failed");
    return { isRepo: res.isRepo, commits: res.commits };
  }

  gitPublish(message: string, remoteUrl?: string): Promise<{ ok: boolean; message: string }> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "git_result") {
          off();
          resolve({ ok: m.ok, message: m.message });
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      this.send({ type: "git_publish", id, message, remoteUrl });
    });
  }

  // -------- Feature C: processes --------

  async listProcesses(): Promise<ProcessInfo[]> {
    const res = await this.request({ type: "list_processes", id: nextId() });
    if (res.type !== "processes") throw new Error("list processes failed");
    return res.processes;
  }

  killProcess(procId: string): void {
    this.send({ type: "kill_process", id: nextId(), procId });
  }

  // -------- Feature 1: npm package manager --------

  /** Install a package natively in the active workspace. Output streams to the
   *  terminal; resolves with the final ok/message. */
  installPackage(packageName: string, dev = false): Promise<{ ok: boolean; message: string }> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id) return;
        if (m.type === "package_result") {
          off();
          resolve({ ok: m.ok, message: m.message });
        } else if (m.type === "error") {
          off();
          reject(new Error(m.message));
        }
      });
      this.send({ type: "install_package", id, packageName, dev });
    });
  }

  // -------- Feature 2: SQLite explorer --------

  async dbOpen(): Promise<{ dbPath: string; tables: DbTableMeta[] }> {
    const res = await this.request({ type: "db_open", id: nextId() });
    if (res.type !== "db_schema") throw new Error("db_open failed");
    return { dbPath: res.dbPath, tables: res.tables };
  }

  async dbRead(table: string): Promise<{ columns: DbColumn[]; rows: DbRow[] }> {
    const res = await this.request({ type: "db_read", id: nextId(), table });
    if (res.type !== "db_rows") throw new Error("db_read failed");
    return { columns: res.columns, rows: res.rows };
  }

  async dbInsert(table: string, values: Record<string, unknown>) {
    const res = await this.request({ type: "db_insert", id: nextId(), table, values });
    if (res.type !== "db_rows") throw new Error("db_insert failed");
    return { columns: res.columns, rows: res.rows };
  }

  async dbUpdate(table: string, rowid: number, column: string, value: unknown) {
    const res = await this.request({ type: "db_update", id: nextId(), table, rowid, column, value });
    if (res.type !== "db_rows") throw new Error("db_update failed");
    return { columns: res.columns, rows: res.rows };
  }

  async dbDelete(table: string, rowid: number) {
    const res = await this.request({ type: "db_delete", id: nextId(), table, rowid });
    if (res.type !== "db_rows") throw new Error("db_delete failed");
    return { columns: res.columns, rows: res.rows };
  }

  async dbCreateTable(table: string, columns: string[]): Promise<DbTableMeta[]> {
    const res = await this.request({ type: "db_create_table", id: nextId(), table, columns });
    if (res.type !== "db_schema") throw new Error("db_create_table failed");
    return res.tables;
  }

  // -------- Feature 4: public tunnel --------

  /** Start a public tunnel to the running preview. Resolves on the first
   *  terminal state (open/error); ongoing closes arrive via onMessage broadcast. */
  startTunnel(): Promise<TunnelStatusMessage> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.id !== id || m.type !== "tunnel_status") return;
        if (m.state === "open" || m.state === "error" || m.state === "closed") {
          off();
          resolve(m);
        }
      });
      try {
        this.send({ type: "start_tunnel", id });
      } catch (err) {
        off();
        reject(err);
      }
    });
  }

  stopTunnel(): void {
    this.send({ type: "stop_tunnel", id: nextId() });
  }

  // -------- Billing (HTTP API on the same loopback port) --------

  /**
   * Start a plan checkout (monthly or yearly). Real Stripe returns a
   * `clientSecret` + `publishableKey` for the in-page EMBEDDED checkout; the
   * mock fallback returns a `url` the caller simply navigates to.
   */
  async checkout(
    tier: Tier,
    interval: "month" | "year" = "month",
  ): Promise<{ url?: string; clientSecret?: string; publishableKey?: string }> {
    const res = await fetch(`${DAEMON_HTTP}/api/create-checkout-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ tier, interval, token: this.token }),
    });
    const data = (await res.json()) as {
      url?: string;
      clientSecret?: string;
      publishableKey?: string;
      error?: string;
    };
    if (!res.ok || (!data.url && !data.clientSecret))
      throw new Error(data.error || "Checkout is unavailable.");
    return data;
  }

  // ---- Developer program (waitlist -> card -> pay-per-use API keys) ----

  /** Join the developer waitlist. Resolves with the fresh dev status. */
  async devRegister(): Promise<DevStatus> {
    const res = await this.request({ type: "dev_register", id: nextId() });
    if (res.type !== "dev_status") throw new Error("Unexpected dev_register response");
    this.info.dev = res.dev;
    return res.dev;
  }

  /** Create an API key. The plaintext is shown ONCE — it is never sent again. */
  async devCreateKey(label?: string): Promise<{ keyId: string; prefix: string; plaintext: string }> {
    const res = await this.request({ type: "dev_create_key", id: nextId(), label });
    if (res.type !== "dev_key_created") throw new Error("Unexpected dev_create_key response");
    return { keyId: res.keyId, prefix: res.prefix, plaintext: res.plaintext };
  }

  async devRevokeKey(keyId: string): Promise<DevStatus> {
    const res = await this.request({ type: "dev_revoke_key", id: nextId(), keyId });
    if (res.type !== "dev_status") throw new Error("Unexpected dev_revoke_key response");
    this.info.dev = res.dev;
    return res.dev;
  }

  /** Toggle billing the in-IDE agent to the metered API subscription. */
  async devSetBillInIde(on: boolean): Promise<DevStatus> {
    const res = await this.request({ type: "dev_set_bill_in_ide", id: nextId(), on });
    if (res.type !== "dev_status") throw new Error("Unexpected dev_set_bill_in_ide response");
    this.info.dev = res.dev;
    return res.dev;
  }

  /** Hosted checkout that collects the card AND activates metered API billing. */
  async devCardCheckout(): Promise<string> {
    const res = await fetch(`${DAEMON_HTTP}/api/dev/create-card-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ token: this.token }),
    });
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) throw new Error(data.error || "Card setup is unavailable.");
    return data.url;
  }

  /** Downgrade to a lower tier (incl. Free). Returns the fresh usage snapshot. */
  async changeTier(tier: Tier): Promise<UsageSnapshot> {
    const res = await fetch(`${DAEMON_HTTP}/api/billing/change-tier`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ tier, token: this.token }),
    });
    const data = (await res.json()) as { usage?: UsageSnapshot; error?: string };
    if (!res.ok || !data.usage) throw new Error(data.error || "Could not change plan.");
    return data.usage;
  }

  /** Live tier + usage snapshot (used to refresh after returning from checkout). */
  async me(): Promise<{ tier: Tier; usage: UsageSnapshot } | null> {
    if (!this.token) return null;
    const res = await fetch(`${DAEMON_HTTP}/api/me`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { tier: Tier; usage: UsageSnapshot };
  }
}

export const daemon = new DaemonClient();
