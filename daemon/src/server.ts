import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type RuntimeMode,
  type ProcessInfo,
} from "@ide/shared";
import { allowedOriginFor, loopbackDevAllowed, type DaemonConfig } from "./config.js";
import { buildTree, readFile, createEntry, writeFileSync, deleteEntry } from "./workspace.js";
import { stopContainer, dockerAvailable } from "./docker.js";
import { exec, detectMode } from "./executor.js";
import { watchWorkspace, type Watcher } from "./watcher.js";
import { createProxyRouter, PREVIEW_PREFIX, type ProxyRouter } from "./proxy.js";
import { makeWebHandler } from "./webStatic.js";
import { runAgent, newAgentState, type AgentState } from "./agent.js";
import { listProjects, createProject, resolveProject, projectInfo, projectExists } from "./projects.js";
import { gitLog, gitPublish } from "./git.js";
import { explain, fix } from "./ai.js";
import { ProcRegistry, sampleRam } from "./procs.js";
import { resolveStartCommand, waitForPort, DEFAULT_RUN_COMMAND } from "./staticServer.js";
import {
  openDb,
  listTables,
  readTable,
  insertRow,
  updateCell,
  deleteRow,
  createTable,
  DB_FILENAME,
} from "./db.js";
import { openTunnel, type TunnelHandle } from "./tunnel.js";
import { authenticate, authConfigured, userRoot, type AuthMode } from "./auth.js";
import { UsageStore, type Meter } from "./usage.js";
import { billingEnabled, realStripeConfigured, reconcileTierFromStripe } from "./billing.js";
import { createApiHandler } from "./httpApi.js";
import {
  canUseDaemonExecution,
  canPublish,
  getTier,
  effortForTier,
  clampEffortForTier,
  tokenMultiplierForEffort,
  type Tier,
  type AgentEffort,
  type UsageSnapshot,
} from "@ide/shared";
import type { DatabaseSync } from "node:sqlite";
import http from "node:http";
import path from "node:path";

/** Build-success / HMR-complete signatures that trigger an iframe refresh. */
const HMR_SIGNALS =
  /compiled successfully|webpack compiled|ready in \d|\bHMR\b|hmr update|hot updated|Local:\s+https?:\/\//i;

interface Session {
  running: Map<string, () => void>; // id -> killer (legacy/agent shells)
  procs: ProcRegistry;
  containerName: string;
  agent: AgentState;
  previewSlot: string | null;
  previewPort: number | null;
  /** Proc id of the running preview server, so it can be stopped before a new run
   *  or when switching projects (otherwise the old server holds the port + the
   *  proxy keeps routing to the stale app). */
  previewProcId: string | null;
  runtimeMode: RuntimeMode;
  forced: RuntimeMode | "auto";
  // Active project
  activeProject: string | null;
  workspaceDir: string | null;
  watcher: Watcher | null;
  ramTimer: ReturnType<typeof setInterval> | null;
  // Feature 2: lazily-opened SQLite handle for the active project.
  db: DatabaseSync | null;
  // Feature 4: live public tunnel, if any.
  tunnel: TunnelHandle | null;
  // v6: authenticated identity + per-tenant project root.
  userId: string | null;
  authMode: AuthMode;
  projectRoot: string | null;
  // LOCAL DEV ONLY: this connection earned loopback dev-trust (see
  // loopbackDevAllowed) — a token-less hello may use the local "dev" user.
  allowLoopbackDev: boolean;
}

let slotCounter = 0;

export async function startServer(config: DaemonConfig): Promise<WebSocketServer> {
  // The preview gateway is mounted on the SAME HTTP server as the API/WS (no
  // separate port) so the whole app fits one PaaS port.
  const proxy = createProxyRouter();

  // Cross-user metering + tier ledger (Stripe webhooks update it).
  const store = new UsageStore(config.metaDir);

  // Optional: serve the built web SPA on this port too, so a single service hosts
  // web + API + WS + previews. Null in local dev (Vite serves the web on :5173).
  const webHandler = makeWebHandler(config.webDir);

  // ONE HTTP server fronts everything, routed by path:
  //   /previews/*  -> the live-preview proxy (per-app dev servers)
  //   /api/*       -> the REST API (+ Stripe webhook)
  //   else         -> the built web SPA (or 404 in local dev)
  const apiHandler = createApiHandler(config, store);
  const httpServer = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith(PREVIEW_PREFIX)) return proxy.handleRequest(req, res);
    if (url.startsWith("/api/") || url === "/api") {
      apiHandler(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
      return;
    }
    if (webHandler) return webHandler(req, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  // WS upgrades are routed manually (noServer): /previews/* -> the proxy's HMR
  // socket; everything else -> the daemon WS, gated by the origin allow-list
  // (this replaces the old verifyClient, which only runs with `server:`).
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    if (url.startsWith(PREVIEW_PREFIX)) {
      proxy.handleUpgrade(req, socket, head);
      return;
    }
    verifyOrigin(req, config, (ok, code, message) => {
      if (!ok) {
        socket.write(`HTTP/1.1 ${code ?? 401} ${message ?? "Unauthorized"}\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));

  console.log(`[daemon] listening on http://${config.host}:${config.port} (web + /api + WS + /previews)`);
  console.log(`[daemon] projects root: ${config.projectsRoot}`);
  console.log(`[daemon] web SPA: ${webHandler ? config.webDir : "not served (dev — use Vite on :5173)"}`);
  console.log(`[daemon] agent API key from env: ${config.deepseekApiKey ? "present" : "MISSING"}`);
  console.log(`[daemon] auth: ${authConfigured(config) ? `Firebase (ID tokens verified, project ${config.firebaseProjectId})` : "DEV mode (local-dev user, no FIREBASE_PROJECT_ID)"}`);
  console.log(`[daemon] billing: ${realStripeConfigured(config) ? "Stripe (live keys)" : "mock Stripe (simulated upgrades, never blocks)"}`);
  console.log(`[daemon] CORS/WS origins: ${config.allowAllOrigins ? "ANY (reflected)" : config.allowedOrigins.join(", ")}`);

  // Loud warning: a non-loopback bind with no real auth = remote code execution
  // exposure (the daemon runs containers / native shells). Make it visible.
  const exposed = config.host !== "127.0.0.1" && config.host !== "localhost";
  if (exposed && (!authConfigured(config) || config.allowAllOrigins)) {
    console.warn(
      "[daemon] ⚠ SECURITY: bound to a public interface without full auth. " +
        "Anyone who can reach this port (and passes the origin check) can run code. " +
        "Before exposing to the internet: set FIREBASE_PROJECT_ID so the handshake " +
        "requires a valid Firebase ID token, keep IDE_ALLOW_ALL_ORIGINS off, set " +
        "IDE_ALLOWED_ORIGINS to your real web domain, and firewall the port.",
    );
  }

  startKeepAlive();

  wss.on("connection", (ws, req) => handleConnection(ws, req, config, proxy, store));
  httpServer.on("close", () => proxy.close());
  return wss;
}

/**
 * Self-ping keepalive for sleepy free PaaS tiers. Render's free web service spins
 * down after ~15 min with no inbound traffic; when RENDER_EXTERNAL_URL is present
 * (Render injects the live https URL) we hit our own /api/health every 10 min so
 * the instance stays awake. No-op everywhere else (local dev, an always-on host),
 * so it costs nothing off Render. As long as the process runs it keeps itself
 * alive — an external uptime pinger is still more robust if it ever does sleep.
 * Override/force the target with KEEPALIVE_URL; set it empty to disable.
 */
function startKeepAlive(): void {
  const base = process.env.KEEPALIVE_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (!base) return;
  const url = `${base.replace(/\/$/, "")}/api/health`;
  const PING_MS = 10 * 60 * 1000; // 10 min — under Render's ~15 min idle window
  const timer = setInterval(() => {
    fetch(url).catch((err) => console.warn(`[daemon] keepalive ping failed: ${(err as Error).message}`));
  }, PING_MS);
  timer.unref?.(); // the HTTP server holds the process open; don't double-hold it
  console.log(`[daemon] keepalive: self-pinging ${url} every ${PING_MS / 60000} min`);
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Same-origin trust: the request's Origin is the very host the daemon is being
 * served as (our own web app talking to its own backend). Safe to allow regardless
 * of the configured allow-list — and it means a single-service deploy (web + API +
 * WS on one origin, e.g. behind Render) needs NO IDE_ALLOWED_ORIGINS at all.
 */
function isSameOrigin(req: IncomingMessage, origin: string | undefined): boolean {
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (!originHost) return false;
  const served = [req.headers.host, firstHeader(req.headers["x-forwarded-host"])];
  return served.includes(originHost);
}

function verifyOrigin(
  req: IncomingMessage,
  config: DaemonConfig,
  done: (ok: boolean, code?: number, message?: string) => void,
): void {
  const origin = req.headers.origin;
  // Allow if the origin is same-origin (our own served app) OR on the configured
  // allow-list (cross-origin: separate web host, local Vite dev on :5173, etc.).
  if (isSameOrigin(req, origin) || allowedOriginFor(config, origin) !== null) done(true);
  else {
    console.warn(`[daemon] rejected connection from origin: ${origin ?? "<none>"}`);
    done(false, 403, "Origin not allowed");
  }
}

function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
  config: DaemonConfig,
  proxy: ProxyRouter,
  store: UsageStore,
): void {
  console.log(`[daemon] client connected (origin: ${req.headers.origin})`);
  const session: Session = {
    running: new Map(),
    procs: new ProcRegistry(),
    containerName: `ide-dev-${randomUUID().slice(0, 8)}`,
    agent: newAgentState(),
    previewSlot: null,
    previewPort: null,
    previewProcId: null,
    runtimeMode: "LOCAL_NODE",
    forced: "auto",
    activeProject: null,
    workspaceDir: null,
    watcher: null,
    ramTimer: null,
    db: null,
    tunnel: null,
    userId: null,
    authMode: "dev",
    projectRoot: null,
    allowLoopbackDev: loopbackDevAllowed(req, config),
  };

  const send = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Live RAM sampling for the process dashboard.
  session.ramTimer = setInterval(async () => {
    if (session.procs.size === 0) return;
    for (const { id, pid } of session.procs.pids()) {
      if (pid != null) session.procs.setRam(id, await sampleRam(pid));
    }
    send({ type: "processes", id: "broadcast", processes: session.procs.list() });
  }, 2000);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", id: "?", message: "Malformed JSON" });
    }
    handleMessage(msg, session, config, proxy, store, send).catch((err) =>
      send({ type: "error", id: msg.id, message: String(err?.message ?? err) }),
    );
  });

  ws.on("close", () => {
    session.agent.stopRequested = true;
    session.agent.abort?.abort();
    session.agent.pendingApproval?.(false);
    for (const kill of session.running.values()) kill();
    session.procs.killAll();
    stopContainer(session.containerName);
    if (session.previewSlot) proxy.unregister(session.previewSlot);
    session.watcher?.close();
    if (session.ramTimer) clearInterval(session.ramTimer);
    session.tunnel?.close();
    try {
      session.db?.close();
    } catch {
      /* already closed */
    }
    console.log("[daemon] client disconnected, sandbox cleaned up");
  });
}

/** Resolve the active workspace or throw a friendly error. */
function requireWs(session: Session): string {
  if (!session.workspaceDir) throw new Error("Open a project from the Hub first.");
  return session.workspaceDir;
}

/**
 * Tear down the session's current preview, if any: kill the dev/static server
 * (freeing its port) and unregister its proxy slot. Called before a new run and
 * when switching projects, so a stale server can't keep holding the port or
 * leave the proxy routing to the previous project's app. Returns true if a
 * preview was actually stopped (caller may want to let the port settle).
 */
function stopPreview(session: Session, proxy: ProxyRouter): boolean {
  let stopped = false;
  if (session.previewProcId) {
    session.running.get(session.previewProcId)?.(); // kill; close handler cleans up procs/running
    session.previewProcId = null;
    stopped = true;
  }
  if (session.previewSlot) {
    proxy.unregister(session.previewSlot);
    session.previewSlot = null;
  }
  session.previewPort = null;
  return stopped;
}

/** Ensure the client completed the authenticated handshake. */
function requireAuth(session: Session): string {
  if (!session.userId) throw new Error("Sign in first (handshake not completed).");
  return session.userId;
}

/** The authenticated user's per-tenant project root. */
function requireProjectRoot(session: Session): string {
  requireAuth(session);
  if (!session.projectRoot) throw new Error("No project root resolved for this user.");
  return session.projectRoot;
}

/** The caller's effective tier (dev mode forced to the configured dev tier). */
function currentTier(session: Session, config: DaemonConfig, store: UsageStore): Tier {
  const userId = requireAuth(session);
  return store.tierFor(userId, session.authMode === "dev" ? { devTier: config.devTier as Tier } : {});
}

/** Gate daemon-side execution. Every plan can run code; this is a safety net. */
function requireExecTier(session: Session, config: DaemonConfig, store: UsageStore): void {
  const tier = currentTier(session, config, store);
  if (!canUseDaemonExecution(tier)) {
    throw new Error(`⛔ The ${getTier(tier).name} plan can't run code on this server.`);
  }
}

/** Gate publishing/sharing apps publicly (share links, deploy) — paid plans only. */
function requirePublishTier(session: Session, config: DaemonConfig, store: UsageStore): void {
  const tier = currentTier(session, config, store);
  if (!canPublish(tier)) {
    throw new Error(
      "🔒 Sharing a public link is a Pro feature. Upgrade to Pro or Max to publish & share your app.",
    );
  }
}

/** Build a metering handle for an agent/AI call that broadcasts usage. */
function makeMeter(
  session: Session,
  config: DaemonConfig,
  store: UsageStore,
  send: (m: ServerMessage) => void,
  // Effort no longer carries a token penalty on any plan (multiplier is 1×).
  effort: AgentEffort = "low",
): Meter {
  const userId = requireAuth(session);
  const tier = currentTier(session, config, store);
  const mult = tokenMultiplierForEffort(tier, effort);
  return {
    tier,
    isOver: () => store.isOverLimit(userId, tier) || store.isDailyThrottled(userId, tier),
    paywallMessage: () =>
      store.isDailyThrottled(userId, tier)
        ? "⚡ Usage-based pricing — you've reached your current usage allowance. It refreshes shortly; upgrade to Pro for higher limits."
        : "You've used your monthly agent tokens. Upgrade to keep building.",
    record: (tokens: number): UsageSnapshot => {
      if (tokens > 0) store.addTokens(userId, tokens * mult);
      const snap = store.snapshot(userId, tier);
      send({ type: "usage_update", id: "broadcast", usage: snap });
      return snap;
    },
  };
}

async function handleMessage(
  msg: ClientMessage,
  session: Session,
  config: DaemonConfig,
  proxy: ProxyRouter,
  store: UsageStore,
  send: (m: ServerMessage) => void,
): Promise<void> {
  switch (msg.type) {
    case "hello": {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        return send({ type: "error", id: msg.id, message: "Protocol version mismatch" });
      }
      // Central auth gate: verify the Firebase ID token (or, for a loopback
      // dev-trust connection, fall back to the local dev user).
      const user = await authenticate(config, msg.token, {
        allowLoopbackDev: session.allowLoopbackDev,
      });
      session.userId = user.userId;
      session.authMode = user.mode;
      session.projectRoot = userRoot(config, user);

      const tier = currentTier(session, config, store);
      session.runtimeMode = await detectMode(session.forced);
      send({
        type: "hello_ok",
        id: msg.id,
        protocolVersion: PROTOCOL_VERSION,
        agentReady: Boolean(config.deepseekApiKey),
        // Display-only label sent to the browser — never the raw model id (which
        // stays internal to the daemon's API calls). The client doesn't read it.
        model: "Neon Agent",
        runtimeMode: session.runtimeMode,
        dockerAvailable: await dockerAvailable(),
        proxyPort: config.proxyPort,
        projectsRootName: path.basename(config.projectsRoot),
        userId: user.userId,
        authMode: user.mode,
        usage: store.snapshot(user.userId, tier),
        billingEnabled: billingEnabled(config),
      });

      // Stripe is the source of truth for the tier. Reconcile in the background
      // (handles a wiped ledger on a diskless host, or a webhook that landed under
      // a different key); if it changes the tier, push a live usage_update so the
      // UI upgrades without a manual refresh.
      if (user.mode === "firebase") {
        reconcileTierFromStripe(config, store, { userId: user.userId, email: user.email })
          .then((found) => {
            if (found !== null && found !== tier) {
              send({ type: "usage_update", id: "broadcast", usage: store.snapshot(user.userId, found) });
            }
          })
          .catch((err) => console.warn("[billing] tier reconcile failed:", (err as Error).message));
      }
      return;
    }

    // ---- Hub / projects (scoped to the authenticated user's root) ----
    case "list_projects": {
      const root = requireProjectRoot(session);
      return send({ type: "projects", id: msg.id, projects: listProjects(root) });
    }

    case "create_project": {
      const root = requireProjectRoot(session);
      const { dir, init } = createProject(root, msg.name, msg.blueprint);
      send({
        type: "project_created",
        id: msg.id,
        project: projectInfo(root, msg.name),
      });
      // Best-effort blueprint init (e.g. npm install), streamed to the terminal.
      // Init only runs for tiers that unlock daemon execution; Free stays inert.
      if (init && canUseDaemonExecution(currentTier(session, config, store))) {
        send({ type: "terminal_output", id: msg.id, stream: "stdout", data: `\r\n$ ${init}\r\n` });
        spawnTracked(init, { label: "Project setup", workspaceDir: dir }, msg.id, session, config, send);
      }
      return;
    }

    case "open_project": {
      const root = requireProjectRoot(session);
      // The project must actually exist on disk. On a diskless host (Render free)
      // a redeploy wipes /data, so a name from a stale client list may be gone —
      // return a precise error (prefixed PROJECT_NOT_FOUND so the client can prune
      // its local index) instead of letting buildTree throw a generic ENOENT.
      if (!projectExists(root, msg.name)) {
        return send({
          type: "error",
          id: msg.id,
          message: `PROJECT_NOT_FOUND: "${msg.name}" no longer exists on the server.`,
        });
      }
      const dir = resolveProject(root, msg.name);
      // Switching projects: tear down the previous project's preview so its
      // server doesn't keep holding the port / showing through the proxy.
      stopPreview(session, proxy);
      session.activeProject = msg.name;
      session.workspaceDir = dir;
      // Switching projects: drop the old project's DB handle so db_open reopens
      // storage.db inside the new workspace.
      try {
        session.db?.close();
      } catch {
        /* ignore */
      }
      session.db = null;
      // (Re)start the per-session watcher for the active project.
      session.watcher?.close();
      session.watcher = watchWorkspace(dir, (root) =>
        send({ type: "workspace_changed", id: "broadcast", root }),
      );
      return send({
        type: "project_opened",
        id: msg.id,
        workspaceName: msg.name,
        root: await buildTree(dir),
      });
    }

    case "set_runtime": {
      session.forced = msg.mode;
      session.runtimeMode = await detectMode(msg.mode);
      return send({
        type: "runtime_changed",
        id: msg.id,
        runtimeMode: session.runtimeMode,
        dockerAvailable: await dockerAvailable(),
      });
    }

    // ---- Files ----
    case "list_tree":
      return send({ type: "tree", id: msg.id, root: await buildTree(requireWs(session)) });

    case "read_file": {
      const content = await readFile(requireWs(session), msg.filePath);
      return send({ type: "file_content", id: msg.id, filePath: msg.filePath, content });
    }

    case "manual_create":
      createEntry(requireWs(session), msg.filePath, msg.kind);
      return send({ type: "manual_ok", id: msg.id, op: "create", filePath: msg.filePath });

    case "manual_update":
      writeFileSync(requireWs(session), msg.filePath, msg.content);
      return send({ type: "manual_ok", id: msg.id, op: "update", filePath: msg.filePath });

    case "manual_delete":
      deleteEntry(requireWs(session), msg.filePath);
      return send({ type: "manual_ok", id: msg.id, op: "delete", filePath: msg.filePath });

    // ---- Run / preview ----
    case "run_command": {
      requireWs(session);
      requireExecTier(session, config, store);
      if (session.runtimeMode === "DOCKER" && !(await dockerAvailable())) {
        return send({ type: "error", id: msg.id, message: "Docker selected but not available." });
      }
      spawnTracked(msg.command, { label: "Command" }, msg.id, session, config, send);
      return;
    }

    case "start_container": {
      const wsDir = requireWs(session);
      // Every plan (Free included) may run their project to preview it in the
      // iframe. Arbitrary `run_command` + `install_package` stay Pro+.
      if (session.runtimeMode === "DOCKER" && !(await dockerAvailable())) {
        return send({ type: "error", id: msg.id, message: "Docker selected but not available." });
      }
      // Stop any previous preview first so we don't collide on the app port or
      // leave the proxy routing to the old app. Give a stopped listener a moment
      // to release the port before the new server binds.
      if (stopPreview(session, proxy)) await new Promise((r) => setTimeout(r, 350));
      const slot = `app-${++slotCounter}`;
      session.previewSlot = slot;
      session.previewPort = msg.appPort;
      session.previewProcId = msg.id;
      proxy.register(slot, msg.appPort);
      // Relative preview path (trailing slash required — see proxy.ts). The client
      // turns this into an absolute URL against its own daemon base, so it works
      // same-origin behind a PaaS/tunnel AND in local dev with no localhost
      // hardcoding. Kept as `proxyUrl` for message back-compat.
      const proxyUrl = `${PREVIEW_PREFIX}${slot}/`;

      // Zero-config Run: when the client sends the default command, auto-detect
      // how to actually start this workspace. Static sites (no runnable
      // package.json) get a tiny built-in static server so the preview works
      // with no setup; a custom command the user typed is always honored.
      const requested = (msg.startCommand ?? "").trim();
      const resolved =
        !requested || requested === DEFAULT_RUN_COMMAND
          ? resolveStartCommand(wsDir, msg.appPort)
          : { command: requested, kind: "node" as const };
      send({
        type: "terminal_output",
        id: msg.id,
        stream: "stdout",
        data: `\r\n\x1b[36m▶ ${resolved.kind === "static" ? "Serving static preview" : "Starting dev server"}:\x1b[0m ${resolved.command}\r\n`,
      });

      spawnTracked(
        resolved.command,
        {
          label: "Dev server",
          port: msg.appPort,
          name: session.containerName,
          image: msg.image,
          workspaceDir: wsDir,
          onChunk: (chunk) => {
            if (session.previewSlot && HMR_SIGNALS.test(chunk)) {
              send({ type: "preview_reload", id: "broadcast", slot: session.previewSlot });
            }
          },
        },
        msg.id,
        session,
        config,
        send,
      );

      // The iframe mounts as soon as we reply, but the app port isn't listening
      // yet (static server boot, or a long `npm install`). Poll the port and
      // nudge a reload once it's actually reachable so the first paint isn't a
      // "Preview not reachable yet" 502 from the proxy.
      void waitForPort(msg.appPort).then((up) => {
        if (up && session.previewSlot === slot) {
          send({ type: "preview_reload", id: "broadcast", slot });
        }
      });

      return send({ type: "container_started", id: msg.id, proxyUrl, slot });
    }

    // ---- Agent ----
    case "agent_prompt": {
      const wsDir = requireWs(session);
      // Free MAY use the agent (reasoning + file edits) but NOT run shell commands —
      // code execution stays Pro+. The hidden Free daily cap is enforced by the meter.
      const promptTier = currentTier(session, config, store);
      const canRunCommands = canUseDaemonExecution(promptTier);
      // User-selected effort, clamped to the tier's ceiling (High is Max-only;
      // defaults to the tier default when the client sends none).
      const effort = clampEffortForTier(promptTier, msg.effort ?? effortForTier(promptTier));
      await runAgent(msg.id, msg.prompt, {
        config,
        workspaceDir: wsDir,
        mode: msg.mode,
        effort,
        canRunCommands,
        state: session.agent,
        send,
        meter: makeMeter(session, config, store, send, effort),
        runShell: (command, agentId) => runShell(command, agentId, wsDir, session, config, send),
        // Copilot approval bridge: park a resolver, ask the UI, resume on reply.
        requestApproval: (toolName, summary, detail) =>
          new Promise<boolean>((resolve) => {
            session.agent.pendingApproval = (approve) => {
              session.agent.pendingApproval = null;
              resolve(approve);
            };
            send({ type: "agent_approval", id: msg.id, toolName, summary, detail });
          }),
      });
      return;
    }

    // Feature 3 — Copilot "Approve Edit" / reject for a parked tool call.
    case "approve_tool": {
      session.agent.pendingApproval?.(msg.approve);
      return;
    }

    case "stop_agent": {
      session.agent.stopRequested = true;
      session.agent.abort?.abort();
      session.agent.pendingApproval?.(false); // unblock any parked approval
      for (const kill of session.running.values()) kill();
      session.running.clear();
      session.procs.killAll();
      send({ type: "processes", id: "broadcast", processes: session.procs.list() });
      stopContainer(session.containerName);
      return send({ type: "agent_done", id: msg.id, reason: "stopped" });
    }

    // ---- Feature A: inline AI (metered) ----
    case "ai_explain": {
      // Available on every plan (Free included); metered + subject to the daily cap.
      const meter = makeMeter(session, config, store, send);
      if (meter.isOver()) {
        send({ type: "paywall", id: msg.id, usage: meter.record(0), message: meter.paywallMessage() });
        return send({ type: "ai_done", id: msg.id });
      }
      return explain(msg.id, msg.code, config, send, meter);
    }
    case "ai_fix": {
      // Available on every plan (Free included); metered + subject to the daily cap.
      const meter = makeMeter(session, config, store, send);
      if (meter.isOver()) {
        return send({ type: "paywall", id: msg.id, usage: meter.record(0), message: meter.paywallMessage() });
      }
      return fix(msg.id, msg.filePath, msg.code, config, send, meter);
    }

    // ---- Feature B: git ----
    case "git_log": {
      const { isRepo, commits } = await gitLog(requireWs(session));
      return send({ type: "git_history", id: msg.id, commits, isRepo });
    }
    case "git_publish": {
      requirePublishTier(session, config, store);
      const result = await gitPublish(requireWs(session), msg.message, msg.remoteUrl, (s) =>
        send({ type: "terminal_output", id: msg.id, stream: "stdout", data: s }),
      );
      return send({ type: "git_result", id: msg.id, ok: result.ok, message: result.message });
    }

    // ---- Feature C: processes ----
    case "list_processes":
      return send({ type: "processes", id: msg.id, processes: session.procs.list() });
    case "kill_process": {
      session.procs.kill(msg.procId);
      return send({ type: "processes", id: "broadcast", processes: session.procs.list() });
    }

    // ---- Feature 1: visual npm package manager ----
    case "install_package": {
      const wsDir = requireWs(session);
      // Available on every plan (Free included) so a project's deps can be
      // installed and the app actually runs in the preview. No model tokens here.
      const name = msg.packageName.trim();
      // Allow optional scope and a version/tag spec; reject anything shell-unsafe.
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.\-^~><=*x| ]+)?$/i.test(name)) {
        return send({
          type: "package_result",
          id: msg.id,
          ok: false,
          packageName: name,
          message: "That doesn't look like a valid npm package name.",
        });
      }
      const command = `npm install ${name}${msg.dev ? " --save-dev" : ""}`;
      send({ type: "terminal_output", id: msg.id, stream: "stdout", data: `\r\n$ ${command}\r\n` });
      spawnTracked(
        command,
        {
          label: `Install ${name}`,
          workspaceDir: wsDir,
          onExit: (code) =>
            send({
              type: "package_result",
              id: msg.id,
              ok: code === 0,
              packageName: name,
              message: code === 0 ? `Installed ${name} ✓` : `npm install failed (exit ${code}).`,
            }),
        },
        msg.id,
        session,
        config,
        send,
      );
      return;
    }

    // ---- Feature 2: SQLite database explorer ----
    case "db_open": {
      const db = ensureDb(session);
      return send({ type: "db_schema", id: msg.id, dbPath: DB_FILENAME, tables: listTables(db) });
    }
    case "db_read": {
      const { columns, rows } = readTable(ensureDb(session), msg.table);
      return send({ type: "db_rows", id: msg.id, table: msg.table, columns, rows });
    }
    case "db_insert": {
      const db = ensureDb(session);
      insertRow(db, msg.table, msg.values);
      const { columns, rows } = readTable(db, msg.table);
      return send({ type: "db_rows", id: msg.id, table: msg.table, columns, rows });
    }
    case "db_update": {
      const db = ensureDb(session);
      updateCell(db, msg.table, msg.rowid, msg.column, msg.value);
      const { columns, rows } = readTable(db, msg.table);
      return send({ type: "db_rows", id: msg.id, table: msg.table, columns, rows });
    }
    case "db_delete": {
      const db = ensureDb(session);
      deleteRow(db, msg.table, msg.rowid);
      const { columns, rows } = readTable(db, msg.table);
      return send({ type: "db_rows", id: msg.id, table: msg.table, columns, rows });
    }
    case "db_create_table": {
      const db = ensureDb(session);
      createTable(db, msg.table, msg.columns);
      return send({ type: "db_schema", id: msg.id, dbPath: DB_FILENAME, tables: listTables(db) });
    }

    // ---- Feature 4: zero-config public tunnel (publish/share — paid only) ----
    case "start_tunnel": {
      requireWs(session);
      if (!canPublish(currentTier(session, config, store))) {
        return send({
          type: "tunnel_status",
          id: msg.id,
          state: "error",
          message:
            "🔒 Public sharing is a Pro feature. Upgrade to Pro or Max to share a live link to your app.",
        });
      }
      const port = session.previewPort;
      if (!port) {
        return send({
          type: "tunnel_status",
          id: msg.id,
          state: "error",
          message: "Start your app with ⏵ Run first, then share its live preview.",
        });
      }
      if (session.tunnel) {
        return send({ type: "tunnel_status", id: msg.id, state: "open", url: session.tunnel.url });
      }
      send({
        type: "tunnel_status",
        id: msg.id,
        state: "starting",
        message: `Opening a public link to port ${port}…`,
      });
      try {
        session.tunnel = await openTunnel(port, () => {
          session.tunnel = null;
          send({ type: "tunnel_status", id: "broadcast", state: "closed" });
        });
        return send({ type: "tunnel_status", id: msg.id, state: "open", url: session.tunnel.url });
      } catch (err) {
        return send({
          type: "tunnel_status",
          id: msg.id,
          state: "error",
          message: (err as Error).message,
        });
      }
    }
    case "stop_tunnel": {
      session.tunnel?.close();
      session.tunnel = null;
      return send({ type: "tunnel_status", id: msg.id, state: "closed" });
    }
  }
}

/** Lazily open (and cache) the active project's storage.db. */
function ensureDb(session: Session): DatabaseSync {
  const wsDir = requireWs(session);
  if (!session.db) session.db = openDb(wsDir).db;
  return session.db;
}

/**
 * Spawn a command in the active runtime, register it in the process dashboard,
 * stream output to the terminal, and (optionally) feed chunks to an HMR detector.
 */
function spawnTracked(
  command: string,
  opts: {
    label: string;
    port?: number;
    name?: string;
    image?: string;
    workspaceDir?: string;
    onChunk?: (chunk: string) => void;
    onExit?: (code: number | null) => void;
  },
  id: string,
  session: Session,
  config: DaemonConfig,
  send: (m: ServerMessage) => void,
): void {
  const handle = exec({
    mode: session.runtimeMode,
    workspaceDir: opts.workspaceDir ?? session.workspaceDir!,
    command,
    image: opts.image ?? config.defaultImage,
    name: opts.name,
    appPort: opts.port,
  });

  const meta: ProcessInfo = {
    id,
    label: opts.label,
    command,
    pid: handle.child.pid ?? null,
    port: opts.port ?? null,
    runtime: session.runtimeMode,
    ramKB: null,
    startedAtMs: Date.now(),
  };
  session.procs.add(meta, handle.kill);
  session.running.set(id, handle.kill);
  send({ type: "processes", id: "broadcast", processes: session.procs.list() });

  handle.child.stdout.on("data", (d: Buffer) => {
    const s = d.toString();
    send({ type: "terminal_output", id, stream: "stdout", data: s });
    opts.onChunk?.(s);
  });
  handle.child.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    send({ type: "terminal_output", id, stream: "stderr", data: s });
    opts.onChunk?.(s);
  });
  handle.child.on("error", (err) =>
    send({ type: "error", id, message: `Failed to start process: ${err.message}` }),
  );
  handle.child.on("close", (code) => {
    session.running.delete(id);
    session.procs.remove(id);
    send({ type: "processes", id: "broadcast", processes: session.procs.list() });
    send({ type: "command_exit", id, exitCode: code });
    opts.onExit?.(code);
  });
}

/** Agent helper: run a command and resolve with its captured output. */
function runShell(
  command: string,
  agentId: string,
  workspaceDir: string,
  session: Session,
  config: DaemonConfig,
  send: (m: ServerMessage) => void,
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const procId = `${agentId}:${randomUUID().slice(0, 6)}`;
    let combined = "";
    send({ type: "terminal_output", id: agentId, stream: "stdout", data: `\r\n$ ${command}\r\n` });

    const handle = exec({ mode: session.runtimeMode, workspaceDir, command, image: config.defaultImage });
    session.procs.add(
      {
        id: procId,
        label: "Agent command",
        command,
        pid: handle.child.pid ?? null,
        port: null,
        runtime: session.runtimeMode,
        ramKB: null,
        startedAtMs: Date.now(),
      },
      handle.kill,
    );
    session.running.set(procId, handle.kill);
    send({ type: "processes", id: "broadcast", processes: session.procs.list() });

    const finish = (exitCode: number | null) => {
      session.running.delete(procId);
      session.procs.remove(procId);
      send({ type: "processes", id: "broadcast", processes: session.procs.list() });
      resolve({ output: combined, exitCode });
    };

    handle.child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      combined += s;
      send({ type: "terminal_output", id: agentId, stream: "stdout", data: s });
    });
    handle.child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      combined += s;
      send({ type: "terminal_output", id: agentId, stream: "stderr", data: s });
    });
    handle.child.on("error", (err) => finishWith(err.message));
    handle.child.on("close", (code) => finish(code));

    function finishWith(errMsg: string) {
      combined += `spawn error: ${errMsg}`;
      finish(1);
    }
  });
}
