import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type RuntimeMode,
  type ProcessInfo,
} from "./shared/protocol.js";
import { allowedOriginFor, type DaemonConfig } from "./config.js";
import { buildTree, readFile, createEntry, writeFileSync, deleteEntry } from "./workspace.js";
import { stopContainer, dockerAvailable } from "./docker.js";
import { exec, detectMode } from "./executor.js";
import { watchWorkspace, type Watcher } from "./watcher.js";
import { startProxyAuto, type ProxyRouter } from "./proxy.js";
import { runAgent, newAgentState, type AgentState } from "./agent.js";
import { listProjects, createProject, resolveProject, projectInfo } from "./projects.js";
import { gitLog, gitPublish } from "./git.js";
import { explain, fix } from "./ai.js";
import { ProcRegistry, sampleRam } from "./procs.js";
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
import { billingEnabled, realStripeConfigured } from "./billing.js";
import { createApiHandler } from "./httpApi.js";
import { canUseDaemonExecution, getTier, type Tier, type UsageSnapshot } from "./shared/protocol.js";
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
}

let slotCounter = 0;

export async function startServer(config: DaemonConfig): Promise<WebSocketServer> {
  // Bind the preview gateway to the same interface as the API/WS so external
  // users on a headless node can also reach running app previews.
  const proxy = await startProxyAuto(config.proxyPort, config.host);
  config.proxyPort = proxy.port;

  // Cross-user metering + tier ledger (Stripe webhooks update it).
  const store = new UsageStore(config.metaDir);

  // One loopback HTTP server fronts BOTH the REST API (/api/*) and the
  // WebSocket upgrade. verifyClient still gates WS by origin.
  const apiHandler = createApiHandler(config, store);
  const httpServer = http.createServer((req, res) => {
    apiHandler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    });
  });

  const wss = new WebSocketServer({
    server: httpServer, // share the port; no separate bind
    verifyClient: (info, done) => verifyOrigin(info.origin, config, done),
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));

  console.log(`[daemon] listening on ws://${config.host}:${config.port} (+ HTTP /api)`);
  console.log(`[daemon] projects root: ${config.projectsRoot}`);
  console.log(`[daemon] proxy gateway port: ${config.proxyPort}`);
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

  wss.on("connection", (ws, req) => handleConnection(ws, req, config, proxy, store));
  wss.on("close", () => proxy.close());
  return wss;
}

function verifyOrigin(
  origin: string | undefined,
  config: DaemonConfig,
  done: (ok: boolean, code?: number, message?: string) => void,
): void {
  if (allowedOriginFor(config, origin) !== null) done(true);
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

/** Gate daemon-side execution (Docker/native) on a paid tier. */
function requireExecTier(session: Session, config: DaemonConfig, store: UsageStore): void {
  const tier = currentTier(session, config, store);
  if (!canUseDaemonExecution(tier)) {
    throw new Error(
      `⛔ The ${getTier(tier).name} plan runs in your browser only (Level 3). Upgrade to Pro to run code, install packages, and use the agent on the daemon.`,
    );
  }
}

/** Build a metering handle for an agent/AI call that broadcasts usage. */
function makeMeter(
  session: Session,
  config: DaemonConfig,
  store: UsageStore,
  send: (m: ServerMessage) => void,
): Meter {
  const userId = requireAuth(session);
  const tier = currentTier(session, config, store);
  return {
    tier,
    isOver: () => store.isOverLimit(userId, tier),
    record: (tokens: number): UsageSnapshot => {
      if (tokens > 0) store.addTokens(userId, tokens);
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
      // Central auth gate: verify the Firebase ID token (or fall back to dev user).
      const user = await authenticate(config, msg.token);
      session.userId = user.userId;
      session.authMode = user.mode;
      session.projectRoot = userRoot(config, user);

      const tier = currentTier(session, config, store);
      session.runtimeMode = await detectMode(session.forced);
      return send({
        type: "hello_ok",
        id: msg.id,
        protocolVersion: PROTOCOL_VERSION,
        agentReady: Boolean(config.deepseekApiKey),
        model: config.deepseekModel,
        runtimeMode: session.runtimeMode,
        dockerAvailable: await dockerAvailable(),
        proxyPort: config.proxyPort,
        projectsRootName: path.basename(config.projectsRoot),
        userId: user.userId,
        authMode: user.mode,
        usage: store.snapshot(user.userId, tier),
        billingEnabled: billingEnabled(config),
      });
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
      const dir = resolveProject(requireProjectRoot(session), msg.name);
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
      requireExecTier(session, config, store);
      if (session.runtimeMode === "DOCKER" && !(await dockerAvailable())) {
        return send({ type: "error", id: msg.id, message: "Docker selected but not available." });
      }
      const slot = `app-${++slotCounter}`;
      session.previewSlot = slot;
      session.previewPort = msg.appPort;
      proxy.register(slot, msg.appPort);
      const proxyUrl = `http://localhost:${config.proxyPort}/previews/${slot}`;

      spawnTracked(
        msg.startCommand,
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
      return send({ type: "container_started", id: msg.id, proxyUrl, slot });
    }

    // ---- Agent ----
    case "agent_prompt": {
      const wsDir = requireWs(session);
      requireExecTier(session, config, store);
      await runAgent(msg.id, msg.prompt, {
        config,
        workspaceDir: wsDir,
        mode: msg.mode,
        state: session.agent,
        send,
        meter: makeMeter(session, config, store, send),
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
      requireExecTier(session, config, store);
      const meter = makeMeter(session, config, store, send);
      if (meter.isOver()) {
        send({ type: "paywall", id: msg.id, usage: meter.record(0), message: "Monthly tokens exhausted." });
        return send({ type: "ai_done", id: msg.id });
      }
      return explain(msg.id, msg.code, config, send, meter);
    }
    case "ai_fix": {
      requireExecTier(session, config, store);
      const meter = makeMeter(session, config, store, send);
      if (meter.isOver()) {
        return send({ type: "paywall", id: msg.id, usage: meter.record(0), message: "Monthly tokens exhausted." });
      }
      return fix(msg.id, msg.filePath, msg.code, config, send, meter);
    }

    // ---- Feature B: git ----
    case "git_log": {
      const { isRepo, commits } = await gitLog(requireWs(session));
      return send({ type: "git_history", id: msg.id, commits, isRepo });
    }
    case "git_publish": {
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
      requireExecTier(session, config, store);
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

    // ---- Feature 4: zero-config public tunnel ----
    case "start_tunnel": {
      requireWs(session);
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
