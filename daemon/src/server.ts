import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type RuntimeMode,
  type ProcessInfo,
  type AdminSessionInfo,
  type AdminUserInfo,
  type MaintenanceState,
} from "@ide/shared";
import { allowedOriginFor, loopbackDevAllowed, type DaemonConfig } from "./config.js";
import { buildTree, readFile, searchFiles, createEntry, writeFileSync, deleteEntry } from "./workspace.js";
import { stopContainer, dockerAvailable, reapOrphanContainers } from "./docker.js";
import { exec, detectMode } from "./executor.js";
import { watchWorkspace, type Watcher } from "./watcher.js";
import { createProxyRouter, PREVIEW_PREFIX, type ProxyRouter } from "./proxy.js";
import { makeWebHandler } from "./webStatic.js";
import { runAgent, newAgentState, type AgentState } from "./agent.js";
import { listProjects, createProject, deleteProject, resolveProject, projectInfo, projectExists } from "./projects.js";
import { gitLog, gitPublish } from "./git.js";
import { explain, fix } from "./ai.js";
import { redactError } from "./redact.js";
import { ProcRegistry, sampleRam } from "./procs.js";
import { resolveStartCommand, waitForPort, DEFAULT_RUN_COMMAND } from "./staticServer.js";
import { allocatePreviewPort, releasePreviewPort } from "./ports.js";
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
import { authenticate, authConfigured, userRoot, userStorageKey, type AuthMode, type AuthedUser } from "./auth.js";
import { pushProject, pullProject, listRemoteProjects, removeRemoteProject } from "./githubSync.js";
import {
  snapshotEnabled,
  snapshotProject,
  restoreProject,
  listSnapshotProjects,
  listSnapshotProjectMeta,
  getSnapshotState,
  touchSnapshotActivity,
  deleteSnapshot,
  type SnapshotProjectMeta,
} from "./firestoreFs.js";
import { sweepSnapshotLifecycle } from "./lifecycle.js";
import { UsageStore, type Meter } from "./usage.js";
import { initFirestore, lookupUserByEmail, lookupEmails } from "./firebaseAdmin.js";
import { billingEnabled, realStripeConfigured, reconcileTierFromStripe, reportApiUsage } from "./billing.js";
import { DevStore } from "./devProgram.js";
import { processDevWaitlist } from "./devEmail.js";
import { processMarketingEmails } from "./marketing.js";
import { execCapture } from "./shellRun.js";
import { moderatePrompt, policyFor, type ModerationVerdict } from "./moderation.js";
import { createApiRunManager } from "./apiRuns.js";
import { createApiHandler } from "./httpApi.js";
import {
  canUseDaemonExecution,
  canPublish,
  FREE_PUBLISH_TRIAL_MS,
  getTier,
  effortForTier,
  clampEffortForTier,
  tokenMultiplierForEffort,
  maxProjectsForTier,
  DEFAULT_MAINTENANCE_MESSAGE,
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
  // v7: GitHub OAuth token (browser-held, re-sent each connect) for project sync,
  // plus a debounced push timer and a quiet window after a restore so the pull's
  // own file writes don't immediately trigger a redundant push.
  githubToken: string | null;
  syncTimer: ReturnType<typeof setTimeout> | null;
  suppressSyncUntil: number;
  /** Projects already warned about exceeding the snapshot quota (once/session). */
  truncationWarned: Set<string>;
  // LOCAL DEV ONLY: this connection earned loopback dev-trust (see
  // loopbackDevAllowed) — a token-less hello may use the local "dev" user.
  allowLoopbackDev: boolean;
  // ---- Admin ops ----
  /** Stable id for this connection (used to target it from the admin dashboard). */
  id: string;
  /** Authenticated email (for the admin dashboard); null until hello. */
  email: string | null;
  /** True when this user's email is in ADMIN_EMAILS. */
  isAdmin: boolean;
  /** This admin is watching the live ops dashboard (gets admin_state pushes). */
  adminSubscribed: boolean;
  connectedAtMs: number;
  /** This connection's sender, stored so we can broadcast to every session. While
   *  detached (socket dropped, agent still running) this points at a buffer that
   *  collects agent output for replay on reattach. */
  send: (m: ServerMessage) => void;
  /** Agent output captured while detached, replayed when a socket reattaches. */
  replayBuffer?: ServerMessage[];
  // ---- rate limiting (M3) ----
  /** Timestamps (ms) of recent messages — general flood guard. */
  recentOps: number[];
  /** Timestamps (ms) of recent HEAVY (process-spawning) ops. */
  recentHeavy: number[];
  // ---- developer program ----
  /** From the verified Firebase ID token — gates dev_register (we email that
   *  address and attach a card to it). */
  emailVerified: boolean;
  /** Tokens consumed by the CURRENT agent run while in-IDE API billing is
   *  active. Reported to the Stripe meters once, when the run settles. */
  apiBillingPending: { input: number; output: number };
}

// ---- rate limiting (M3): only model tokens were metered before, so file/project/
// preview/db ops could be spammed (disk fill, port-pool exhaustion, process spawn).
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 200; // general client messages per 10s (very generous for real use)
const HEAVY_WINDOW_MS = 30_000;
const HEAVY_MAX = 15; // process-spawning ops per 30s
// M3: hard ceiling on simultaneously-tracked child processes per session. Docker
// sandboxes get --pids-limit=256; LOCAL_NODE has no equivalent, so a session could
// keep spawning until the host is starved. The rate limiter bounds spawn RATE; this
// bounds how many can be ALIVE at once. Generous — a preview dev server + a burst of
// commands stays well under it.
const MAX_LIVE_PROCS = 16;
// H7: one-shot commands (run_command / install_package) get a hard runtime ceiling
// so a hung `npm install` or a `sleep 999999` can't squat a slot forever. The
// long-lived preview dev server is exempt (it's spawnTracked WITH a port and is
// meant to keep running) — see spawnTracked.
const ONESHOT_TIMEOUT_MS = 300_000;
const HEAVY_OPS: ReadonlySet<string> = new Set([
  "create_project",
  "delete_project",
  "start_container",
  "run_command",
  "install_package",
  "start_tunnel",
]);

/** True when this message should be rejected for exceeding the session's rate. */
function rateLimited(session: Session, msg: ClientMessage): boolean {
  const now = Date.now();
  session.recentOps = session.recentOps.filter((t) => now - t < RATE_WINDOW_MS);
  session.recentOps.push(now);
  if (session.recentOps.length > RATE_MAX) return true;
  if (HEAVY_OPS.has(msg.type)) {
    session.recentHeavy = session.recentHeavy.filter((t) => now - t < HEAVY_WINDOW_MS);
    session.recentHeavy.push(now);
    if (session.recentHeavy.length > HEAVY_MAX) return true;
  }
  return false;
}

export async function startServer(config: DaemonConfig): Promise<WebSocketServer> {
  // The preview gateway is mounted on the SAME HTTP server as the API/WS (no
  // separate port) so the whole app fits one PaaS port.
  const proxy = createProxyRouter();

  // Cross-user metering + tier ledger (Stripe webhooks update it). Backed by
  // Firestore when a service account is configured (so the monthly token meter
  // survives Render's diskless redeploys); otherwise a local JSON ledger.
  const firestore = initFirestore(config.firebaseServiceAccount);
  const store = new UsageStore(config.metaDir, { firestore });
  usageStore = store; // module refs for the admin dashboard (tier/usage view + edits)
  serverConfig = config;

  // Developer program: waitlist state + card-on-file + API keys, same durable
  // backing as the usage ledger (Firestore, or a local JSON file in dev).
  const devStore = new DevStore(config.metaDir, { firestore });
  devStoreRef = devStore;

  // MAINTENANCE (temporary — remove later): boot already locked if MAINTENANCE_MODE
  // is set in the environment, so a lockout survives a restart/redeploy.
  if (config.maintenanceMode) {
    maintenance = { on: true, message: config.maintenanceMessage };
    console.log("[maintenance] booting in maintenance mode (MAINTENANCE_MODE set)");
  }

  // Graceful shutdown (usage flush + project flush) is owned by index.ts so both
  // complete before the process exits — see flushUsage() / flushAllSessions().
  // (Previously a separate handler here could process.exit() the moment the small
  // usage flush settled, truncating the longer project-snapshot flush on redeploy.)

  // Optional: serve the built web SPA on this port too, so a single service hosts
  // web + API + WS + previews. Null in local dev (Vite serves the web on :5173).
  const webHandler = makeWebHandler(config.webDir);

  // ONE HTTP server fronts everything, routed by path:
  //   /previews/*  -> the live-preview proxy (per-app dev servers)
  //   /api/*       -> the REST API (+ Stripe webhook)
  //   else         -> the built web SPA (or 404 in local dev)
  // Public developer API run manager (session-less agent runs, metered billing).
  const apiRuns = createApiRunManager(config, store, devStore);
  const apiHandler = createApiHandler(config, store, devStore, apiRuns);
  const httpServer = http.createServer((req, res) => {
    const url = req.url || "/";
    // Previews render untrusted user/AI HTML we don't control — don't impose the
    // app's headers on them (and they're isolated via the iframe sandbox / a
    // separate origin instead). Everything else (web SPA + API) gets a baseline.
    if (url.startsWith(PREVIEW_PREFIX)) return proxy.handleRequest(req, res);
    setSecurityHeaders(res);
    if (url.startsWith("/api/") || url === "/api") {
      apiHandler(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: redactError(err) }));
      });
      return;
    }
    // Firebase's hosted OAuth handler, re-served from OUR origin: Safari's ITP
    // blocks the cross-site storage handoff *.firebaseapp.com needs, so the web
    // client uses this origin as its authDomain in production and we forward
    // the handler's static pages/JSON (Firebase's documented proxy workaround).
    if (url.startsWith("/__/")) {
      void proxyFirebaseAuth(req, res, config);
      return;
    }
    if (webHandler) return webHandler(req, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  // WS upgrades are routed manually (noServer): /previews/* -> the proxy's HMR
  // socket; everything else -> the daemon WS, gated by the origin allow-list
  // (this replaces the old verifyClient, which only runs with `server:`).
  // maxPayload caps a single WS frame (M7) so a huge manual_update/agent_prompt
  // can't buffer unbounded memory. 12 MB is generous for editing large files.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
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
  // Reap any sandbox containers a previous (crashed) run left behind (M5).
  void dockerAvailable().then((ok) => {
    if (ok) reapOrphanContainers();
  });

  wss.on("connection", (ws, req) => handleConnection(ws, req, config, proxy, store, devStore));
  httpServer.on("close", () => proxy.close());

  // Keep the ops dashboard fresh (agent running/step, proc counts) while an admin
  // is watching. Cheap no-op when nobody is subscribed.
  setInterval(() => {
    if ([...activeSessions].some((s) => s.adminSubscribed)) broadcastAdminState();
  }, 3000).unref();

  // Developer-program waitlist: accept anyone whose ~2-day wait is up and send
  // the acceptance email. A boot pass (2 min in) guarantees progress on every
  // wake of a sleepy free-tier host; the hourly pass covers a long-lived process.
  if (config.devProgramEnabled) {
    const pass = () => void processDevWaitlist(config, devStore, pushDevStatus);
    setTimeout(pass, 2 * 60_000).unref();
    setInterval(pass, 60 * 60_000).unref();
  }

  // Recurring marketing / lifecycle email (segmented cadence). OFF unless
  // MARKETING_EMAILS is set; the hourly pass spaces sends across the week.
  if (config.marketingEmails && config.resendApiKey) {
    const pass = () => void processMarketingEmails(config, store);
    setTimeout(pass, 5 * 60_000).unref();
    setInterval(pass, 60 * 60_000).unref();
    console.log("[marketing] recurring email engine ON");
  }

  // Snapshot inactivity lifecycle: warn → archive → delete idle Firestore-
  // persisted projects (lifecycle.ts). Boot pass 7 min in (staggered after the
  // other jobs), then every FS_SWEEP_MINUTES.
  if (config.fsLifecycleEnabled && snapshotEnabled(config)) {
    const pass = () => void sweepSnapshotLifecycle(config, store);
    setTimeout(pass, Math.min(7 * 60_000, config.fsSweepMinutes * 60_000)).unref();
    setInterval(pass, config.fsSweepMinutes * 60_000).unref();
    console.log("[fs-lifecycle] inactivity sweep ON");
  }

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
 * Forward /__/* (Firebase Hosting's reserved namespace: the OAuth handler
 * pages, iframe helpers, init.json) to <project>.firebaseapp.com so the whole
 * sign-in dance stays same-site. The surface is static GETs — the OAuth flow
 * itself travels via top-level redirects, never POSTs through us.
 */
async function proxyFirebaseAuth(
  req: IncomingMessage,
  res: http.ServerResponse,
  config: DaemonConfig,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method not allowed");
    return;
  }
  const target = `https://${config.firebaseProjectId}.firebaseapp.com${req.url}`;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: String(req.headers.accept ?? "*/*") },
      redirect: "manual", // pass provider redirects (e.g. → accounts.google.com) through
    });
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "cache-control", "location"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn("[auth] firebase handler proxy failed:", (err as Error).message);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Auth handler unreachable.");
  }
}

/**
 * Baseline security headers for the web app + API (not previews). Deliberately
 * conservative: it locks the dangerous CSP sinks (base-uri hijack, plugin embeds,
 * clickjacking, cross-origin form posts) WITHOUT constraining script/style/connect
 * — so Firebase auth, the daemon WebSocket, CodeMirror and inline styles keep
 * working with zero tuning. Tighten script-src/connect-src to an allow-list after
 * testing against the Firebase + daemon origins.
 */
function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // `payment` stays allowed for self + Stripe so wallets (Apple/Google Pay) work
  // inside the embedded checkout iframe; everything else stays locked.
  res.setHeader(
    "Permissions-Policy",
    'geolocation=(), microphone=(), camera=(), payment=(self "https://js.stripe.com" "https://checkout.stripe.com")',
  );
  res.setHeader(
    "Content-Security-Policy",
    "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'",
  );
}

/**
 * Same-origin trust: the request's Origin is the very host the daemon is being
 * served as (our own web app talking to its own backend). Safe to allow regardless
 * of the configured allow-list — and it means a single-service deploy (web + API +
 * WS on one origin, e.g. behind Render) needs NO IDE_ALLOWED_ORIGINS at all.
 */
function isSameOrigin(
  req: IncomingMessage,
  origin: string | undefined,
  config: DaemonConfig,
): boolean {
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (!originHost) return false;
  // Only consult X-Forwarded-Host when we trust the fronting proxy (L15) — a
  // directly-exposed node must not let a spoofed header fake same-origin.
  const served = [req.headers.host];
  if (config.trustProxyHeaders) served.push(firstHeader(req.headers["x-forwarded-host"]));
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
  if (isSameOrigin(req, origin, config) || allowedOriginFor(config, origin) !== null) done(true);
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
  devStore: DevStore,
): void {
  console.log(`[daemon] client connected (origin: ${req.headers.origin})`);
  const session: Session = {
    running: new Map(),
    procs: new ProcRegistry(),
    // L25: full UUID (dashes stripped) instead of an 8-hex prefix, so a
    // co-tenant on the same Docker host can't feasibly enumerate container names.
    containerName: `ide-dev-${randomUUID().replace(/-/g, "")}`,
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
    githubToken: null,
    syncTimer: null,
    suppressSyncUntil: 0,
    truncationWarned: new Set(),
    allowLoopbackDev: loopbackDevAllowed(req, config),
    id: randomUUID(),
    email: null,
    isAdmin: false,
    adminSubscribed: false,
    connectedAtMs: Date.now(),
    send: () => {},
    recentOps: [],
    recentHeavy: [],
    emailVerified: false,
    apiBillingPending: { input: 0, output: 0 },
  };
  activeSessions.add(session);

  // Raw sender bound to THIS socket. The session this socket drives is `current`:
  // normally the fresh session above, but on a reconnect within the grace window it
  // is swapped to the user's still-alive detached session (see reattach), so an
  // in-flight agent keeps streaming to the new socket.
  const rawSend = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  let current = session;
  current.send = rawSend;

  // Live RAM sampling for the process dashboard (restartable so a reattached
  // session resumes sampling on the new socket).
  const startRamTimer = (s: Session) =>
    setInterval(async () => {
      if (s.procs.size === 0) return;
      for (const { id, pid } of s.procs.pids()) {
        if (pid != null) s.procs.setRam(id, await sampleRam(pid));
      }
      s.send({ type: "processes", id: "broadcast", processes: s.procs.list() });
    }, 2000);
  current.ramTimer = startRamTimer(current);

  // Full teardown of a session's sandbox. Used by the close handler (immediate) and
  // by the grace timer when a dropped user never reconnects.
  const cleanup = async (sess: Session) => {
    sess.agent.stopRequested = true;
    sess.agent.abort?.abort();
    sess.agent.pendingApproval?.(false);
    await flushSync(sess, config).catch(() => {}); // best-effort final GitHub push
    for (const kill of sess.running.values()) kill();
    sess.procs.killAll();
    stopContainer(sess.containerName);
    if (sess.previewSlot) proxy.unregister(sess.previewSlot);
    releasePreviewPort(sess.previewPort);
    sess.watcher?.close();
    if (sess.ramTimer) clearInterval(sess.ramTimer);
    sess.tunnel?.close();
    try {
      sess.db?.close();
    } catch {
      /* already closed */
    }
    activeSessions.delete(sess);
    if (sess.userId && detached.get(sess.userId)?.session === sess) detached.delete(sess.userId);
    broadcastAdminState();
    console.log("[daemon] session cleaned up");
  };

  // Reattach this socket to a still-alive session (called from hello) — either one
  // detached in the grace window, or one still active because the daemon hasn't
  // noticed the old socket died yet (abrupt drop). The old socket's late close is
  // a no-op thanks to the `sess.send !== rawSend` guard in the close handler.
  const reattach = (older: Session) => {
    activeSessions.delete(current); // discard the fresh placeholder this socket came in on
    if (current.ramTimer) clearInterval(current.ramTimer);
    if (older.ramTimer) clearInterval(older.ramTimer); // takeover: stop its prior socket's timer
    current = older; // drive the live session, routing its output to THIS socket
    older.send = rawSend;
    older.ramTimer = startRamTimer(older);
    activeSessions.add(older);
    const buf = older.replayBuffer ?? []; // replay the gap so the chat catches up
    older.replayBuffer = undefined;
    for (const m of buf) rawSend(m);
    console.log(`[daemon] reattached socket to live session for ${older.userId}`);
  };

  // WS heartbeat: ping each client; a socket that misses a pong is half-open
  // (common on phones / flaky Wi-Fi / proxies) and gets terminated so its session
  // is cleaned up (or detached) instead of lingering. Browsers auto-reply to pings.
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
  });
  const heartbeat = setInterval(() => {
    if (!isAlive) {
      ws.terminate(); // triggers ws.on("close") below
      return;
    }
    isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already closing */
    }
  }, 30_000);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return rawSend({ type: "error", id: "?", message: "Malformed JSON" });
    }
    // M9: TS types are erased at runtime — enforce the minimal shape every handler
    // assumes (an object with a string `type`) before dispatch, so a bare JSON
    // scalar / array / `null` can't reach the switch and trip on `msg.type`.
    if (typeof msg !== "object" || msg === null || Array.isArray(msg) || typeof msg.type !== "string") {
      return rawSend({ type: "error", id: "?", message: "Malformed message" });
    }
    handleMessage(msg, current, config, proxy, store, devStore, rawSend, { reattach }).catch((err) =>
      rawSend({ type: "error", id: msg.id, message: redactError(err) }),
    );
  });

  ws.on("close", async () => {
    clearInterval(heartbeat);
    const sess = current;
    // If a newer connection already took over this session (its sender no longer
    // points at this socket), this is a stale close — do nothing, the new socket
    // owns the session now.
    if (sess.send !== rawSend) return;
    // Survive a brief drop: if an agent is mid-run, hold the session (and its
    // sandbox) for a grace window so a reconnect can reattach and keep streaming.
    // Buffer the agent's output meanwhile; it's replayed on reattach.
    if (sess.userId && sess.agent.abort != null) {
      if (sess.ramTimer) {
        clearInterval(sess.ramTimer);
        sess.ramTimer = null;
      }
      const buffer: ServerMessage[] = [];
      sess.replayBuffer = buffer;
      sess.send = (m) => {
        if (buffer.length < 500) buffer.push(m);
      };
      const prev = detached.get(sess.userId);
      if (prev && prev.session !== sess) {
        clearTimeout(prev.timer);
        void cleanup(prev.session); // evict an older detached session for this user
      }
      const timer = setTimeout(() => {
        detached.delete(sess.userId!);
        void cleanup(sess);
      }, GRACE_MS);
      timer.unref?.();
      detached.set(sess.userId, { session: sess, timer });
      broadcastAdminState();
      console.log(`[daemon] client dropped with agent running — holding ${GRACE_MS / 1000}s for reattach`);
      return;
    }
    await cleanup(sess);
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
  releasePreviewPort(session.previewPort);
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

/**
 * Admin gate. The email must be in ADMIN_EMAILS *and* verified by Firebase.
 * Without the email_verified check, anyone could email/password-signup with an
 * admin's address (verification is separate from account creation) and be handed
 * the admin dashboard. Dev-mode users have no email, so they never match.
 */
function isAdminUser(user: AuthedUser, config: DaemonConfig): boolean {
  return user.emailVerified && !!user.email && config.adminEmails.includes(user.email.toLowerCase());
}

/**
 * L26: persistent audit trail for privileged admin mutations. Admins can change
 * tiers / usage / limits and suspend accounts; without a record there's no
 * traceability if an admin account is misused. Emitted to stdout (captured by the
 * platform's log store) with the actor, the action, and the target.
 */
function adminAudit(session: Session, action: string, detail: Record<string, unknown> = {}): void {
  console.log(
    `[audit] admin=${session.email ?? session.userId ?? "?"} action=${action} ${JSON.stringify(detail)}`,
  );
}

// ---- v7: GitHub project sync (per-user, to their own GitHub) ----
const SYNC_DEBOUNCE_MS = 5000;

/** Live sessions, so a graceful shutdown can flush every open project to GitHub. */
const activeSessions = new Set<Session>();

/**
 * "Survive a brief drop": when a socket closes WHILE an agent is mid-run, the
 * session (and its sandbox) is held here keyed by userId for a grace window, so a
 * reconnect can reattach and keep streaming. If the user never returns, the grace
 * timer tears it down. Agents do NOT run forever after everyone leaves.
 */
const GRACE_MS = 120_000; // 2 min: covers refreshes / network blips, not abandonment
// Keyed by userId (L12): a single user's concurrent tabs/devices are NOT fully
// independent — a reconnect reattaches to (and a newer one evicts) the same user's
// detached session. This is intentional (one agent run per user), just documented.
const detached = new Map<string, { session: Session; timer: ReturnType<typeof setTimeout> }>();

// Module refs (set in startServer) so buildAdminState can show each session's tier
// + usage and admin actions can adjust them.
let usageStore: UsageStore | null = null;
let serverConfig: DaemonConfig | null = null;
let devStoreRef: DevStore | null = null;

/** Push fresh developer-program state to every connected session of a user —
 *  after waitlist acceptance, a card webhook, or a key change. */
function pushDevStatus(userId: string): void {
  if (!devStoreRef || !serverConfig?.devProgramEnabled) return;
  const dev = devStoreRef.statusFor(userId);
  for (const s of activeSessions) {
    if (s.userId === userId) s.send({ type: "dev_status", id: "broadcast", dev });
  }
}

// ---- Admin ops + maintenance ----
// MAINTENANCE (temporary — remove later): in-memory flag flipped by an admin.
// Resets on restart (fine for a diskless free instance). Non-admins are locked out.
let maintenance: MaintenanceState = { on: false, message: "" };

/** Snapshot every live session for the admin dashboard. */
function buildAdminState(): AdminSessionInfo[] {
  return [...activeSessions].map((s) => {
    let tier = 0;
    let tokensUsed = 0;
    let tokensLimit = 0;
    if (usageStore && serverConfig && s.userId) {
      tier = currentTier(s, serverConfig, usageStore);
      const snap = usageStore.snapshot(s.userId, tier as Tier);
      tokensUsed = snap.tokensUsed;
      tokensLimit = snap.tokensLimit;
    }
    return {
      sessionId: s.id,
      userId: s.userId,
      email: s.email,
      authMode: s.authMode,
      project: s.activeProject,
      agentRunning: s.agent.abort != null,
      agentStep: s.agent.abort != null ? s.agent.step : null,
      procCount: s.procs.size,
      previewActive: s.previewSlot != null,
      connectedAtMs: s.connectedAtMs,
      tier,
      tokensUsed,
      tokensLimit,
      limitOverride: usageStore && s.userId ? usageStore.limitOverride(s.userId) : null,
    };
  });
}

/** Push a fresh usage snapshot (and optional notice) to every connected session of
 *  a user after an admin edits their tier/usage/limit. No-op if they're offline. */
function notifyUserUsage(userId: string, text: string | null): void {
  if (!usageStore || !serverConfig) return;
  for (const s of activeSessions) {
    if (s.userId !== userId) continue;
    const tier = currentTier(s, serverConfig, usageStore);
    const snap = usageStore.snapshot(userId, tier);
    s.send({ type: "usage_update", id: "broadcast", usage: snap });
    if (snap.limitReached) {
      s.send({ type: "paywall", id: "broadcast", usage: snap, message: "You've reached your usage limit." });
    }
    if (text) s.send({ type: "notice", id: "broadcast", level: "info", text });
  }
}

/** Push the live ops state to every subscribed admin (no-op if none watching). */
function broadcastAdminState(): void {
  const sessions = buildAdminState();
  for (const s of activeSessions) {
    if (s.adminSubscribed) s.send({ type: "admin_state", id: "broadcast", sessions, maintenance });
  }
}

/** Stable cache key for this session's user (mirrors the FS jail). */
function sessionStorageKey(session: Session): string {
  return userStorageKey({ userId: session.userId ?? "anon", mode: session.authMode });
}

/** Whether this session persists durably and via which path. GitHub (when the
 *  user connected it) is preferred; otherwise the Firestore snapshot store is the
 *  free "persistent disk" safety net. */
function canPersist(session: Session, config: DaemonConfig): boolean {
  return Boolean(session.githubToken) || snapshotEnabled(config);
}

/** Persist the active project once — GitHub if connected, else a Firestore
 *  snapshot. Used by both the debounced and immediate flush paths. Never throws. */
async function persistActiveProject(session: Session, config: DaemonConfig): Promise<void> {
  if (!session.activeProject || !session.workspaceDir) return;
  // Capture now: a project switch can land while the snapshot awaits.
  const project = session.activeProject;
  const dir = session.workspaceDir;
  const key = sessionStorageKey(session);
  if (session.githubToken) {
    await pushProject(config, session.githubToken, key, project, dir);
  } else if (snapshotEnabled(config)) {
    const res = await snapshotProject(config, key, project, dir, { db: session.db });
    if (res?.truncated && !session.truncationWarned.has(project)) {
      session.truncationWarned.add(project);
      session.send({
        type: "notice",
        id: "broadcast",
        level: "warn",
        text: `"${project}" exceeds the ${config.fsProjectQuotaMb} MB backup quota — ${res.skipped.length} file(s) aren't being backed up.`,
      });
    }
  }
}

/** Debounced persist of the active project. No-op without a durable path / open
 *  project, or inside the post-restore quiet window. */
function scheduleSync(session: Session, config: DaemonConfig): void {
  if (!canPersist(session, config) || !session.activeProject || !session.workspaceDir) return;
  if (Date.now() < session.suppressSyncUntil) return;
  if (session.syncTimer) clearTimeout(session.syncTimer);
  session.syncTimer = setTimeout(() => {
    session.syncTimer = null;
    void persistActiveProject(session, config);
  }, SYNC_DEBOUNCE_MS);
}

/** Immediately persist the active project (cancelling any pending debounce). Used
 *  on project switch, disconnect, and shutdown. Never throws. */
async function flushSync(session: Session, config: DaemonConfig): Promise<void> {
  if (session.syncTimer) {
    clearTimeout(session.syncTimer);
    session.syncTimer = null;
  }
  await persistActiveProject(session, config);
}

/** Flush every connected session — called on SIGTERM so a redeploy doesn't lose
 *  the latest edits. Best-effort. */
export async function flushAllSessions(config: DaemonConfig): Promise<void> {
  await Promise.allSettled([...activeSessions].map((s) => flushSync(s, config)));
}

/** Persist buffered usage metering + developer-program state on shutdown (so the
 *  last few seconds aren't lost). Called by index.ts alongside flushAllSessions. */
export async function flushUsage(): Promise<void> {
  await Promise.allSettled([usageStore?.flush(), devStoreRef?.flush()]);
}

/** The user's effective project NAMES — local dirs unioned with their durable
 *  copies (GitHub repo, or Firestore snapshots when GitHub isn't connected). Used
 *  by list_projects and the per-tier creation cap so a diskless wipe can't be used
 *  to slip past the limit. */
async function effectiveProjectNames(session: Session, config: DaemonConfig): Promise<Set<string>> {
  const root = requireProjectRoot(session);
  const names = new Set(listProjects(root).map((p) => p.name));
  const key = sessionStorageKey(session);
  const remote = session.githubToken
    ? await listRemoteProjects(config, session.githubToken, key)
    : snapshotEnabled(config)
      ? await listSnapshotProjects(config, key)
      : [];
  for (const n of remote) names.add(n);
  return names;
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

/**
 * SECURITY (C2): whether it's safe to execute user/agent code right now. When
 * IDE_REQUIRE_SANDBOX is set we only allow execution inside a hardened Docker
 * sandbox and refuse the weakly-isolated LOCAL_NODE host-exec fallback (on a
 * Docker-less host that fallback has no real FS/network jail — a tenant could read
 * other tenants' files). Off by default so local/single-tenant dev is unaffected.
 */
function sandboxOk(session: Session, config: DaemonConfig): boolean {
  return !config.requireSandbox || session.runtimeMode === "DOCKER";
}
function assertSandbox(session: Session, config: DaemonConfig): void {
  if (!sandboxOk(session, config)) {
    throw new Error(
      "⛔ Code execution is disabled on this server: a hardened sandbox (Docker) is required but isn't available.",
    );
  }
}

/**
 * Gate publishing/sharing apps publicly (share links, git publish, deploy).
 * Paid plans: always allowed. Free: allowed until 30 days after the FIRST
 * publish (window recorded by markFirstPublish on publish SUCCESS — this gate
 * never starts the clock itself, so failed attempts don't burn it), then an
 * upgrade is required to bring the app back online.
 */
function requirePublishTier(session: Session, config: DaemonConfig, store: UsageStore): void {
  const tier = currentTier(session, config, store);
  if (canPublish(tier)) return;
  const first = store.firstPublishAt(requireAuth(session));
  if (first == null || Date.now() - first < FREE_PUBLISH_TRIAL_MS) return;
  throw new Error(
    "🔒 Your 30 free days of publishing have ended — upgrade to Pro or Max to bring your app back online.",
  );
}

/**
 * Graduated enforcement for a flagged agent prompt (see moderation.ts):
 *   - CSAE → immediate, unappealable ban (never warned).
 *   - NSFW / weapons-drugs → a formal WARNING on the first offense (prompt
 *     blocked, account intact), escalating to an appealable suspension on the
 *     next offense in any warnable category.
 * Returns "warned" or "suspended" so the caller can finish the run message.
 */
async function enforceModeration(
  session: Session,
  store: UsageStore,
  verdict: ModerationVerdict,
): Promise<"warned" | "suspended"> {
  const userId = requireAuth(session);
  const category = verdict.category!;
  const { warn, appealable } = policyFor(category);
  await store.ensureLoaded(userId);

  // First offense in a warnable category → warn, don't suspend.
  if (warn && store.modStrikes(userId) < 1) {
    store.addModStrike(userId);
    await store.flush();
    const message =
      `⚠️ Policy warning: your request appeared to seek ${verdict.label}, which our ` +
      `Terms of Service and Acceptable Use Policy prohibit. This is a formal warning — ` +
      `a further violation will result in your account being suspended.`;
    console.warn(`[moderation] warned ${userId} — category=${category}`);
    session.send({ type: "policy_warning", id: "broadcast", message });
    return "warned";
  }

  // CSAE, or a repeat offense → suspend (CSAE is unappealable).
  const message = appealable
    ? `We detected a request to generate ${verdict.label}, a serious violation of our Terms ` +
      `of Service and Acceptable Use Policy. Following an earlier warning, your account has ` +
      `been suspended.`
    : `We detected a request involving ${verdict.label}. This is a severe, zero-tolerance ` +
      `violation of our Terms of Service, and your account has been permanently banned.`;
  console.warn(
    `[moderation] suspended ${userId} — category=${category} appealable=${appealable}`,
  );
  store.setSuspended(userId, true, message, appealable);
  await store.flush();
  for (const s of activeSessions) {
    if (s.userId !== userId) continue;
    s.send({ type: "suspension_changed", id: "broadcast", suspended: true, message, appealable });
    s.agent.abort?.abort(); // stop anything already running
  }
  broadcastAdminState();
  return "suspended";
}

/** Record a successful publish (starts the Free 30-day window on first use)
 *  and refresh the client's usage snapshot so the countdown shows right away. */
function notePublishSuccess(session: Session, config: DaemonConfig, store: UsageStore): void {
  const tier = currentTier(session, config, store);
  if (canPublish(tier)) return;
  const userId = requireAuth(session);
  store.markFirstPublish(userId);
  session.send({ type: "usage_update", id: "broadcast", usage: store.snapshot(userId, tier) });
}

/** Build a metering handle for an agent/AI call that broadcasts usage.
 *  Pass `devStore` (the agent path does) to honor the user's in-IDE API-billing
 *  toggle: tokens then bill to their metered Stripe subscription instead of
 *  Sparks — no limits, RAW token counts (no effort multiplier), reported once
 *  when the run settles (see flushApiBilling). Inline AI (explain/fix) doesn't
 *  pass it and stays on Sparks. */
function makeMeter(
  session: Session,
  config: DaemonConfig,
  store: UsageStore,
  send: (m: ServerMessage) => void,
  // Effort no longer carries a token penalty on any plan (multiplier is 1×).
  effort: AgentEffort = "low",
  devStore?: DevStore,
): Meter {
  const userId = requireAuth(session);
  const tier = currentTier(session, config, store);
  const mult = tokenMultiplierForEffort(tier, effort);
  if (devStore && config.devProgramEnabled && devStore.billInIdeActive(userId)) {
    return {
      tier,
      // No limits on metered billing. Suspension still locks the user out — it's
      // enforced before the agent starts (the agent_prompt suspension gate).
      isOver: () => false,
      paywallMessage: () => "",
      record: (tokens: number, split?: { input: number; output: number }): UsageSnapshot => {
        if (tokens > 0) {
          // RAW tokens — billed usage tracks provider cost, not Sparks nudges. A
          // missing split counts everything as input (the cheaper rate).
          session.apiBillingPending.input += Math.max(0, split ? split.input : tokens);
          session.apiBillingPending.output += Math.max(0, split ? split.output : 0);
        }
        const snap = store.snapshot(userId, tier);
        send({ type: "usage_update", id: "broadcast", usage: snap, billedToApi: true });
        return snap;
      },
    };
  }
  return {
    tier,
    isOver: () => store.isOverLimit(userId, tier) || store.isDailyThrottled(userId, tier),
    paywallMessage: () =>
      store.isDailyThrottled(userId, tier)
        ? "⚡ Usage-based pricing — you've reached your current usage allowance. It refreshes shortly; upgrade to Pro for higher limits."
        : "You've used your monthly Sparks (usage fluctuates). Upgrade to keep building.",
    record: (tokens: number): UsageSnapshot => {
      if (tokens > 0) store.addTokens(userId, tokens * mult);
      const snap = store.snapshot(userId, tier);
      send({ type: "usage_update", id: "broadcast", usage: snap });
      return snap;
    },
  };
}

/** Report a settled run's API-billed tokens to the Stripe meters (at most two
 *  events, idempotent by the run id) and reset the pending bucket. No-op when
 *  nothing accrued. Fire-and-forget — metering must never fail a run. */
function flushApiBilling(
  session: Session,
  config: DaemonConfig,
  devStore: DevStore,
  identifier: string,
): void {
  const pending = session.apiBillingPending;
  if (pending.input + pending.output <= 0 || !session.userId) return;
  session.apiBillingPending = { input: 0, output: 0 };
  void reportApiUsage(config, devStore.customerIdFor(session.userId), pending, identifier);
  // Accumulate the developer's running usage/cost total, then push a fresh
  // dev_status so the settings panel reflects the new spend without a reload.
  devStore.recordUsage(session.userId, pending.input, pending.output);
  pushDevStatus(session.userId);
}

async function handleMessage(
  msg: ClientMessage,
  session: Session,
  config: DaemonConfig,
  proxy: ProxyRouter,
  store: UsageStore,
  devStore: DevStore,
  send: (m: ServerMessage) => void,
  opts?: { reattach: (older: Session) => void },
): Promise<void> {
  // Rate limiting (M3). The handshake is exempt; everything else is bounded so a
  // client can't flood project/preview/db/file ops (only model tokens were metered).
  if (msg.type !== "hello" && rateLimited(session, msg)) {
    return send({
      type: "error",
      id: msg.id,
      message: "You're going too fast — please slow down and try again in a moment.",
    });
  }
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

      // Reattach to this user's still-running session if one is parked in the grace
      // window — i.e. the previous socket closed (tab close / refresh / navigate /
      // dropped connection all send a TCP close) while an agent was mid-run. The
      // in-flight agent then keeps streaming to this new socket. We deliberately do
      // NOT adopt a still-ACTIVE session here: that would let a second browser tab
      // hijack the first tab's running agent.
      const live = detached.get(user.userId);
      const older: Session | undefined = live?.session;
      if (live) {
        clearTimeout(live.timer);
        detached.delete(user.userId);
      }
      if (older && opts?.reattach) {
        older.githubToken = msg.githubToken ?? older.githubToken;
        older.isAdmin = isAdminUser(user, config);
        older.emailVerified = user.emailVerified;
        opts.reattach(older); // swap this socket to drive `older`; flush its replay buffer
        await store.ensureLoaded(older.userId!);
        if (config.devProgramEnabled) await devStore.ensureLoaded(older.userId!);
        const tierR = currentTier(older, config, store);
        older.runtimeMode = await detectMode(older.forced);
        send({
          type: "hello_ok",
          id: msg.id,
          protocolVersion: PROTOCOL_VERSION,
          agentReady: Boolean(config.deepseekApiKey),
          model: "Kryct Agent",
          runtimeMode: older.runtimeMode,
          dockerAvailable: await dockerAvailable(),
          proxyPort: config.proxyPort,
          projectsRootName: path.basename(config.projectsRoot),
          previewOrigin: config.previewOrigin || undefined,
          userId: older.userId!,
          authMode: older.authMode,
          usage: store.snapshot(older.userId!, tierR),
          billingEnabled: billingEnabled(config),
          isAdmin: older.isAdmin,
          maintenance,
          suspended: store.isSuspended(older.userId!),
          suspendMessage: store.suspendMessageFor(older.userId!),
          suspendAppealable: store.suspendAppealableFor(older.userId!),
          marketingOptIn: store.marketingOptIn(older.userId!),
          // If a run is still in flight, tell the client so it can restore the live
          // UI after a full reload (where its in-memory state was wiped).
          activeRun:
            older.agent.abort != null && older.agent.promptId && older.activeProject
              ? { promptId: older.agent.promptId, project: older.activeProject }
              : null,
          dev:
            config.devProgramEnabled && older.authMode === "firebase"
              ? devStore.statusFor(older.userId!)
              : undefined,
        });
        send({
          type: "notice",
          id: "broadcast",
          level: "info",
          text: "Reconnected — your agent kept running.",
        });
        broadcastAdminState();
        return;
      }

      session.userId = user.userId;
      session.authMode = user.mode;
      session.email = user.email ?? null;
      session.emailVerified = user.emailVerified;
      session.isAdmin = isAdminUser(user, config);
      session.projectRoot = userRoot(config, user);
      // v7: a GitHub token (browser-held) enables per-user project sync this session.
      session.githubToken = msg.githubToken ?? null;

      // Hydrate this user's durable usage (Firestore) before reading their meter,
      // so the monthly limiter reflects prior spend instead of a wiped-to-0 ledger.
      await store.ensureLoaded(user.userId);
      if (user.mode === "firebase") store.recordLogin(user.userId, user.email ?? null);
      if (config.devProgramEnabled) await devStore.ensureLoaded(user.userId);

      const tier = currentTier(session, config, store);
      session.runtimeMode = await detectMode(session.forced);
      send({
        type: "hello_ok",
        id: msg.id,
        protocolVersion: PROTOCOL_VERSION,
        agentReady: Boolean(config.deepseekApiKey),
        // Display-only label sent to the browser — never the raw model id (which
        // stays internal to the daemon's API calls). The client doesn't read it.
        model: "Kryct Agent",
        runtimeMode: session.runtimeMode,
        dockerAvailable: await dockerAvailable(),
        proxyPort: config.proxyPort,
        projectsRootName: path.basename(config.projectsRoot),
        previewOrigin: config.previewOrigin || undefined,
        userId: user.userId,
        authMode: user.mode,
        usage: store.snapshot(user.userId, tier),
        billingEnabled: billingEnabled(config),
        isAdmin: session.isAdmin,
        maintenance,
        suspended: store.isSuspended(user.userId),
        suspendMessage: store.suspendMessageFor(user.userId),
        suspendAppealable: store.suspendAppealableFor(user.userId),
        marketingOptIn: store.marketingOptIn(user.userId),
        dev:
          config.devProgramEnabled && user.mode === "firebase"
            ? devStore.statusFor(user.userId)
            : undefined,
      });
      broadcastAdminState(); // a (re)identified session — refresh the ops dashboard

      // Stripe is the source of truth for the tier. Reconcile in the background
      // (handles a wiped ledger on a diskless host, or a webhook that landed under
      // a different key); if it changes the tier, push a live usage_update so the
      // UI upgrades without a manual refresh.
      if (user.mode === "firebase") {
        reconcileTierFromStripe(config, store, { userId: user.userId, email: user.email })
          .then((found) => {
            // Push the EFFECTIVE tier (which may include an active gratuity gift), not
            // the raw Stripe `found`, so a comp upgrade isn't visually downgraded.
            const eff = currentTier(session, config, store);
            if (found !== null && eff !== tier) {
              send({ type: "usage_update", id: "broadcast", usage: store.snapshot(user.userId, eff) });
            }
          })
          .catch((err) => console.warn("[billing] tier reconcile failed:", (err as Error).message));
      }
      return;
    }

    // ---- Hub / projects (scoped to the authenticated user's root) ----
    case "list_projects": {
      const root = requireProjectRoot(session);
      const projects = listProjects(root);
      // After a diskless wipe the local dir is empty but the user's durable copy
      // (GitHub repo, or Firestore snapshots when GitHub isn't connected) still
      // has their projects — surface those names too (restored on open). 0 mtime
      // sorts them after live local ones.
      const have = new Set(projects.map((p) => p.name));
      const key = sessionStorageKey(session);
      const metaByName = new Map<string, SnapshotProjectMeta>();
      if (!session.githubToken && snapshotEnabled(config)) {
        for (const m of await listSnapshotProjectMeta(config, key)) metaByName.set(m.project, m);
      }
      const remote = session.githubToken
        ? await listRemoteProjects(config, session.githubToken, key)
        : [...metaByName.keys()];
      for (const name of remote) {
        if (!have.has(name)) {
          projects.push({ name, lastModifiedMs: metaByName.get(name)?.updatedAt ?? 0, entryCount: 0 });
        }
      }
      // Decorate inactivity-lifecycle state on both local and snapshot-only rows.
      for (const p of projects) {
        const m = metaByName.get(p.name);
        if (!m) continue;
        if (m.archivedAt) {
          p.state = "archived";
          p.deleteAtMs = m.archivedAt + config.fsArchiveGraceHours * 3_600_000;
        } else if (m.warnedAt) {
          p.state = "warned";
          p.archiveAtMs = m.warnedAt + config.fsWarnGraceHours * 3_600_000;
        }
      }
      return send({ type: "projects", id: msg.id, projects });
    }

    case "create_project": {
      const root = requireProjectRoot(session);
      // Per-tier project SLOT cap. Count the user's EFFECTIVE projects (local +
      // durable) so a diskless wipe can't be used to exceed it; creating a name
      // that already exists isn't a new slot (createProject rejects dupes anyway).
      const tier = currentTier(session, config, store);
      const max = maxProjectsForTier(tier);
      const existing = await effectiveProjectNames(session, config);
      if (!existing.has(msg.name) && existing.size >= max) {
        return send({
          type: "error",
          id: msg.id,
          message: `🔒 Your ${getTier(tier).name} plan allows up to ${max} projects. Delete one to make room, or upgrade for more.`,
        });
      }
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
      const dir = resolveProject(root, msg.name);
      // The project must exist on disk. On a diskless host (Render free) a redeploy
      // wipes /data, so a name from a stale list may be gone locally — try to
      // restore it from the user's GitHub first; only if that finds nothing do we
      // return a precise PROJECT_NOT_FOUND (prefixed so the client prunes its index).
      let justRestored = false;
      if (!projectExists(root, msg.name)) {
        const key = sessionStorageKey(session);
        if (session.githubToken) {
          justRestored = await pullProject(config, session.githubToken, key, msg.name, dir);
        } else if (snapshotEnabled(config)) {
          // Inactivity lifecycle: an archived project can't be opened — only
          // restored (restore_project) or exported (.zip). Local-dir opens skip
          // this gate on purpose: local disk is live truth and un-archives.
          const st = await getSnapshotState(config, key, msg.name);
          if (st?.archivedAt) {
            return send({
              type: "error",
              id: msg.id,
              message: `PROJECT_ARCHIVED: "${msg.name}" is archived — restore it or download a .zip from your dashboard.`,
            });
          }
          justRestored = await restoreProject(config, key, msg.name, dir);
        }
        if (!justRestored) {
          return send({
            type: "error",
            id: msg.id,
            message: `PROJECT_NOT_FOUND: "${msg.name}" no longer exists on the server.`,
          });
        }
      }
      // Persist the project we're leaving before switching away from it.
      await flushSync(session, config);
      // Switching projects: tear down the previous project's preview so its
      // server doesn't keep holding the port / showing through the proxy.
      stopPreview(session, proxy);
      session.activeProject = msg.name;
      session.workspaceDir = dir;
      // After a restore, briefly ignore the pull's own file writes so we don't
      // immediately re-push an identical tree.
      session.suppressSyncUntil = justRestored ? Date.now() + 8000 : 0;
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
      session.watcher = watchWorkspace(dir, (root) => {
        send({ type: "workspace_changed", id: "broadcast", root });
        scheduleSync(session, config); // debounced persist (GitHub or Firestore)
      });
      // Opening IS activity — bump the inactivity clock and clear any warning,
      // even when the dir was already on disk (a read-only user never syncs).
      if (!session.githubToken && snapshotEnabled(config)) {
        void touchSnapshotActivity(config, sessionStorageKey(session), msg.name);
      }
      return send({
        type: "project_opened",
        id: msg.id,
        workspaceName: msg.name,
        root: await buildTree(dir),
      });
    }

    case "delete_project": {
      const root = requireProjectRoot(session);
      const key = sessionStorageKey(session);
      // If we're deleting the currently-open project, tear it down first so the
      // watcher/preview/db don't keep touching (or re-persisting) a dir we remove.
      if (session.activeProject === msg.name) {
        if (session.syncTimer) {
          clearTimeout(session.syncTimer);
          session.syncTimer = null;
        }
        stopPreview(session, proxy);
        session.watcher?.close();
        session.watcher = null;
        try {
          session.db?.close();
        } catch {
          /* ignore */
        }
        session.db = null;
        session.activeProject = null;
        session.workspaceDir = null;
      }
      deleteProject(root, msg.name); // local dir (validated + jailed)
      // Remove the durable copy too, so the slot is genuinely freed and the
      // project doesn't reappear in list_projects after a diskless wipe.
      if (session.githubToken) {
        await removeRemoteProject(config, session.githubToken, key, msg.name);
      } else if (snapshotEnabled(config)) {
        await deleteSnapshot(config, key, msg.name);
      }
      return send({ type: "project_deleted", id: msg.id, name: msg.name });
    }

    case "restore_project": {
      // Un-archive / clear the inactivity warning. Only clears the lifecycle
      // flags — the next normal open_project performs the actual file restore.
      requireProjectRoot(session); // auth guard, same as its siblings
      const key = sessionStorageKey(session);
      if (session.githubToken || !snapshotEnabled(config)) {
        // Nothing to clear on the GitHub path (exempt from the lifecycle).
        return send({ type: "project_restored", id: msg.id, name: msg.name });
      }
      const ok = await touchSnapshotActivity(config, key, msg.name);
      if (!ok) {
        return send({ type: "error", id: msg.id, message: `No backup found for "${msg.name}".` });
      }
      return send({ type: "project_restored", id: msg.id, name: msg.name });
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

    case "search_files": {
      const { matches, truncated } = await searchFiles(requireWs(session), msg.query, {
        caseSensitive: msg.caseSensitive,
      });
      return send({ type: "search_results", id: msg.id, matches, truncated });
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
      assertSandbox(session, config);
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
      assertSandbox(session, config);
      if (session.runtimeMode === "DOCKER" && !(await dockerAvailable())) {
        return send({ type: "error", id: msg.id, message: "Docker selected but not available." });
      }
      // Stop any previous preview first so we don't collide on the app port or
      // leave the proxy routing to the old app. Give a stopped listener a moment
      // to release the port before the new server binds.
      if (stopPreview(session, proxy)) await new Promise((r) => setTimeout(r, 350));
      // Allocate a UNIQUE port for this preview (ignore the client's hardcoded
      // hint) so concurrent previews never collide and a stale/orphaned server on
      // some other port can't shadow this one.
      const appPort = await allocatePreviewPort();
      // M17: a random slug (not a sequential app-N) so preview slots can't be
      // enumerated/guessed by an attacker probing /previews/app-1, app-2, …
      const slot = `app-${randomUUID().slice(0, 12)}`;
      session.previewSlot = slot;
      session.previewPort = appPort;
      session.previewProcId = msg.id;
      proxy.register(slot, appPort);
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
          ? resolveStartCommand(wsDir, appPort)
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
          port: appPort,
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
      void waitForPort(appPort).then((up) => {
        if (up && session.previewSlot === slot) {
          send({ type: "preview_reload", id: "broadcast", slot });
        }
      });

      return send({ type: "container_started", id: msg.id, proxyUrl, slot });
    }

    // ---- Agent ----
    case "agent_prompt": {
      // MAINTENANCE (temporary — remove later): block non-admins while maintenance
      // is on (the client also shows a full-screen lockout; this is defense-in-depth).
      if (maintenance.on && !session.isAdmin) {
        send({
          type: "notice",
          id: msg.id,
          level: "warn",
          text: maintenance.message || DEFAULT_MAINTENANCE_MESSAGE,
        });
        return send({ type: "agent_done", id: msg.id, reason: "stopped" });
      }
      // Suspended users are locked out (the client also shows a full-screen screen).
      if (session.userId && !session.isAdmin && store.isSuspended(session.userId)) {
        send({
          type: "notice",
          id: msg.id,
          level: "warn",
          text: store.suspendMessageFor(session.userId) || "Your account has been suspended.",
        });
        return send({ type: "agent_done", id: msg.id, reason: "stopped" });
      }
      // Content safety: a prompt hitting a zero-tolerance category (sexual
      // content involving minors, NSFW generation, weapons/drugs) is enforced
      // per the Terms of Service — a first offense warns, a repeat suspends,
      // and CSAE is an immediate unappealable ban. Admins and the local dev
      // user are exempt (the dev user is local-only and would otherwise
      // self-lock).
      if (config.agentModeration && !session.isAdmin && session.authMode === "firebase") {
        const verdict = moderatePrompt(msg.prompt);
        if (verdict.flagged) {
          await enforceModeration(session, store, verdict);
          return send({ type: "agent_done", id: msg.id, reason: "stopped" });
        }
      }
      const wsDir = requireWs(session);
      // Free MAY use the agent (reasoning + file edits) but NOT run shell commands —
      // code execution stays Pro+. The hidden Free daily cap is enforced by the meter.
      // Also require a real sandbox (C2) — with IDE_REQUIRE_SANDBOX and no Docker the
      // agent can still reason + write files, but not execute shell commands.
      const promptTier = currentTier(session, config, store);
      const canRunCommands = canUseDaemonExecution(promptTier) && sandboxOk(session, config);
      // User-selected effort, clamped to the tier's ceiling (High is Max-only;
      // defaults to the tier default when the client sends none).
      const effort = clampEffortForTier(promptTier, msg.effort ?? effortForTier(promptTier));
      // Route ALL agent output through session.send (not the captured socket sender)
      // so a mid-run disconnect buffers it and a reattach redirects it to the new
      // socket — the run survives a brief drop instead of streaming into the void.
      let lastFrameAt = Date.now();
      const emit = (m: ServerMessage) => {
        lastFrameAt = Date.now();
        session.send(m);
      };
      // Run-scoped keepalive: Render's proxy cuts connections with ~100s of
      // silence, and a run can go that quiet (model think-time, approval waits,
      // long shell steps). Send a tiny "ka" frame only when nothing else flowed
      // for 25s — and never while detached (session.send would eat replay slots).
      const ka = setInterval(() => {
        if (session.replayBuffer) return;
        if (Date.now() - lastFrameAt < 25_000) return;
        lastFrameAt = Date.now();
        session.send({ type: "ka", id: "broadcast" });
      }, 5_000);
      ka.unref?.();
      try {
        await runAgent(msg.id, msg.prompt, {
          config,
          workspaceDir: wsDir,
          mode: msg.mode,
          effort,
          canRunCommands,
          state: session.agent,
          send: emit,
          meter: makeMeter(session, config, store, emit, effort, devStore),
          runShell: (command, agentId) => runShell(command, agentId, wsDir, session, config, emit),
          // Copilot approval bridge: park a resolver, ask the UI, resume on reply.
          requestApproval: (toolName, summary, detail) =>
            new Promise<boolean>((resolve) => {
              session.agent.pendingApproval = (approve) => {
                session.agent.pendingApproval = null;
                resolve(approve);
              };
              emit({ type: "agent_approval", id: msg.id, toolName, summary, detail });
            }),
        });
      } finally {
        clearInterval(ka);
        // If this run billed to the user's metered API subscription, report it
        // now (one input + one output meter event, idempotent by the prompt id).
        flushApiBilling(session, config, devStore, msg.id);
      }
      broadcastAdminState(); // run finished — clear "running" on the ops dashboard
      return;
    }

    // Feature 3 — Copilot "Approve Edit" / reject for a parked tool call.
    case "approve_tool": {
      session.agent.pendingApproval?.(msg.approve);
      return;
    }

    // ---- Developer program (waitlist -> card -> pay-per-use API keys) ----
    case "dev_register": {
      if (!config.devProgramEnabled) {
        return send({ type: "error", id: msg.id, message: "The developer program is disabled." });
      }
      if (session.authMode !== "firebase" || !session.userId || !session.email) {
        return send({ type: "error", id: msg.id, message: "Sign in with a real account to register." });
      }
      if (!session.emailVerified) {
        return send({
          type: "error",
          id: msg.id,
          message: "Verify your email first — the acceptance email goes to that address.",
        });
      }
      await devStore.ensureLoaded(session.userId);
      const dev = devStore.register(session.userId, session.email);
      await devStore.flush(); // the waitlist clock starts now — don't lose it to a restart
      return send({ type: "dev_status", id: msg.id, dev });
    }
    case "dev_create_key": {
      if (!config.devProgramEnabled) {
        return send({ type: "error", id: msg.id, message: "The developer program is disabled." });
      }
      const userId = requireAuth(session);
      await devStore.ensureLoaded(userId);
      const cur = devStore.statusFor(userId);
      if (cur.status !== "accepted") {
        return send({ type: "error", id: msg.id, message: "You're not an accepted developer yet." });
      }
      if (!cur.cardOnFile) {
        return send({ type: "error", id: msg.id, message: "Add a payment card first — API usage is billed per use." });
      }
      const label = typeof msg.label === "string" ? msg.label.slice(0, 60) : undefined;
      const { plaintext, key } = await devStore.createKey(userId, label);
      await devStore.flush(); // a key the user just saw must survive a restart
      send({ type: "dev_key_created", id: msg.id, keyId: key.id, prefix: key.prefix, plaintext });
      pushDevStatus(userId); // refresh key lists on every open tab
      return;
    }
    case "dev_revoke_key": {
      const userId = requireAuth(session);
      await devStore.ensureLoaded(userId);
      const ok = await devStore.revokeKey(userId, msg.keyId);
      if (!ok) return send({ type: "error", id: msg.id, message: "Could not revoke that key." });
      await devStore.flush();
      send({ type: "dev_status", id: msg.id, dev: devStore.statusFor(userId) });
      pushDevStatus(userId);
      return;
    }
    case "dev_set_bill_in_ide": {
      if (!config.devProgramEnabled) {
        return send({ type: "error", id: msg.id, message: "The developer program is disabled." });
      }
      const userId = requireAuth(session);
      await devStore.ensureLoaded(userId);
      const cur = devStore.statusFor(userId);
      if (msg.on && (cur.status !== "accepted" || !cur.cardOnFile)) {
        return send({
          type: "error",
          id: msg.id,
          message: "API billing needs an accepted developer account with a card on file.",
        });
      }
      devStore.setBillInIde(userId, msg.on);
      await devStore.flush();
      send({ type: "dev_status", id: msg.id, dev: devStore.statusFor(userId) });
      pushDevStatus(userId);
      return;
    }

    // ---- Admin ops (rejected for non-admins; the daemon is the authority) ----
    case "admin_subscribe": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      session.adminSubscribed = true;
      return send({ type: "admin_state", id: msg.id, sessions: buildAdminState(), maintenance });
    }
    case "admin_cancel_agent": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      const target = [...activeSessions].find((s) => s.id === msg.sessionId);
      adminAudit(session, "cancel_agent", { sessionId: msg.sessionId, targetUser: target?.userId ?? null });
      if (target) {
        target.agent.stopRequested = true;
        target.agent.abort?.abort();
        target.agent.pendingApproval?.(false); // unblock any parked approval
        target.send({ type: "notice", id: "broadcast", level: "warn", text: "An admin stopped your agent." });
      }
      broadcastAdminState();
      return;
    }
    case "admin_set_maintenance": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      // MAINTENANCE (temporary — remove later)
      adminAudit(session, "set_maintenance", { on: msg.on });
      maintenance = { on: msg.on, message: msg.message || DEFAULT_MAINTENANCE_MESSAGE };
      for (const s of activeSessions) s.send({ type: "maintenance_changed", id: "broadcast", maintenance });
      broadcastAdminState();
      return;
    }
    case "admin_set_tier": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      if (!msg.userId) return;
      const tier = Math.max(0, Math.min(2, Math.floor(msg.tier))) as Tier;
      await store.ensureLoaded(msg.userId);
      const prevTier = store.tierFor(msg.userId);
      adminAudit(session, "set_tier", { targetUser: msg.userId, from: prevTier, to: tier });
      if (tier > prevTier) {
        // Gratuity: grant the higher tier for ONE MONTH, then auto-revert to their
        // base (started/real) tier — handled lazily by store.tierFor on expiry.
        store.grantGift(msg.userId, tier, Date.now() + 30 * 24 * 60 * 60 * 1000);
        await store.flush();
        notifyUserUsage(msg.userId, null);
        const planName = getTier(tier).name;
        for (const s of activeSessions) {
          if (s.userId !== msg.userId) continue;
          s.send({
            type: "account_gift",
            id: "broadcast",
            tier,
            title: "A gift from Kryct",
            message: `As a gratuity, we’ve upgraded you to the ${planName} plan for one month — no charge. Thank you for being part of Kryct.`,
          });
        }
      } else {
        // Direct set (downgrade or same): clear any gift and set the base tier.
        store.clearGift(msg.userId);
        store.setTier(msg.userId, tier);
        await store.flush();
        notifyUserUsage(msg.userId, `An admin set your plan to ${getTier(tier).name}.`);
      }
      broadcastAdminState();
      return;
    }
    case "admin_set_usage": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      if (!msg.userId) return;
      await store.ensureLoaded(msg.userId);
      adminAudit(session, "set_usage", { targetUser: msg.userId, tokensUsed: msg.tokensUsed });
      store.setMonthlyTokens(msg.userId, msg.tokensUsed);
      await store.flush(); // persist immediately
      notifyUserUsage(msg.userId, "An admin updated your usage.");
      broadcastAdminState();
      return;
    }
    case "admin_set_limit": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      if (!msg.userId) return;
      await store.ensureLoaded(msg.userId);
      adminAudit(session, "set_limit", { targetUser: msg.userId, limit: msg.limit });
      store.setLimitOverride(msg.userId, msg.limit);
      await store.flush(); // persist immediately
      notifyUserUsage(msg.userId, "An admin updated your token limit.");
      broadcastAdminState();
      return;
    }
    case "admin_set_suspended": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      if (!msg.userId) return;
      await store.ensureLoaded(msg.userId);
      adminAudit(session, "set_suspended", { targetUser: msg.userId, suspended: msg.suspended });
      store.setSuspended(msg.userId, msg.suspended, msg.message); // admin bans are appealable
      await store.flush(); // persist immediately
      // Lock out the target live (every one of their connected sessions).
      for (const s of activeSessions) {
        if (s.userId !== msg.userId) continue;
        s.send({
          type: "suspension_changed",
          id: "broadcast",
          suspended: msg.suspended,
          message: msg.message,
          appealable: true,
        });
        if (msg.suspended) s.agent.abort?.abort(); // stop any in-flight run
      }
      broadcastAdminState();
      return;
    }
    case "admin_lookup_user": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      const found = await lookupUserByEmail(msg.email);
      if (!found) return send({ type: "admin_user", id: msg.id, user: null });
      await store.ensureLoaded(found.userId);
      const tier = store.tierFor(found.userId) as Tier;
      const snap = store.snapshot(found.userId, tier);
      return send({
        type: "admin_user",
        id: msg.id,
        user: {
          userId: found.userId,
          email: found.email,
          tier,
          tokensUsed: snap.tokensUsed,
          tokensLimit: snap.tokensLimit,
          limitOverride: store.limitOverride(found.userId),
          online: [...activeSessions].some((s) => s.userId === found.userId),
          suspended: store.isSuspended(found.userId),
          suspendMessage: store.suspendMessageFor(found.userId),
        },
      });
    }
    case "admin_list_users": {
      if (!session.isAdmin) return send({ type: "error", id: msg.id, message: "Not authorized." });
      const cutoff = msg.sinceMs ?? Date.now() - 4 * 24 * 60 * 60 * 1000; // last 4 days
      const recent = await store.listRecentUsers(cutoff);
      const byId = new Map<string, (typeof recent)[number]>();
      for (const r of recent) byId.set(r.userId, r);
      // Overlay live values + emails for connected users (always include them).
      const liveEmail = new Map<string, string | null>();
      const online = new Set<string>();
      for (const s of activeSessions) {
        if (!s.userId) continue;
        online.add(s.userId);
        liveEmail.set(s.userId, s.email);
        const t = currentTier(s, config, store);
        const snap = store.snapshot(s.userId, t);
        byId.set(s.userId, {
          userId: s.userId,
          tier: t,
          tokensUsed: snap.tokensUsed,
          tokensLimit: snap.tokensLimit,
          limitOverride: store.limitOverride(s.userId),
          suspended: store.isSuspended(s.userId),
          suspendMessage: store.suspendMessageFor(s.userId),
        });
      }
      const uids = [...byId.keys()];
      const emails = await lookupEmails(uids);
      const users: AdminUserInfo[] = uids.map((uid) => {
        const r = byId.get(uid)!;
        return {
          userId: uid,
          email: liveEmail.get(uid) ?? emails[uid] ?? null,
          tier: r.tier,
          tokensUsed: r.tokensUsed,
          tokensLimit: r.tokensLimit,
          limitOverride: r.limitOverride,
          online: online.has(uid),
          suspended: r.suspended,
          suspendMessage: r.suspendMessage,
        };
      });
      users.sort((a, b) => Number(b.online) - Number(a.online) || b.tokensUsed - a.tokensUsed);
      return send({ type: "admin_users", id: msg.id, users });
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
      if (result.ok) notePublishSuccess(session, config, store);
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
      assertSandbox(session, config);
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
      // SECURITY (H2): `--ignore-scripts` blocks arbitrary pre/post-install code
      // execution from the installed package (the npm-lifecycle RCE path), which
      // matters most on the Docker-less LOCAL_NODE fallback. Deps still install;
      // only their lifecycle scripts are skipped.
      const command = `npm install --ignore-scripts ${name}${msg.dev ? " --save-dev" : ""}`;
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

    // ---- Feature 4: zero-config public tunnel (publish/share — paid plans
    // always; Free gets 30 days from its first publish) ----
    case "start_tunnel": {
      requireWs(session);
      try {
        requirePublishTier(session, config, store);
      } catch (err) {
        return send({
          type: "tunnel_status",
          id: msg.id,
          state: "error",
          message: (err as Error).message,
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
        notePublishSuccess(session, config, store); // Free: first publish starts the 30-day window
        // M8: be honest that this is a PUBLIC link through a third-party relay.
        send({
          type: "notice",
          id: "broadcast",
          level: "warn",
          text: "This share is a PUBLIC link routed through a third-party relay (loca.lt) — anyone with the URL can reach your running app while it's open. Stop the share when you're done.",
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
  // M3: refuse to spawn once too many are already alive on this session. Prevents
  // a session from exhausting host processes on the un-sandboxed LOCAL_NODE path.
  if (session.running.size >= MAX_LIVE_PROCS) {
    send({
      type: "error",
      id,
      message: `Too many processes are already running (limit ${MAX_LIVE_PROCS}). Stop one and try again.`,
    });
    return;
  }

  const handle = exec({
    mode: session.runtimeMode,
    workspaceDir: opts.workspaceDir ?? session.workspaceDir!,
    command,
    image: opts.image ?? config.defaultImage,
    name: opts.name,
    appPort: opts.port,
    network: config.containerNetwork,
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

  // H7: hard timeout for one-shot commands (no published port). The preview dev
  // server is spawned WITH a port and is meant to run indefinitely, so it's exempt.
  let timedOut = false;
  const timeout =
    opts.port == null
      ? setTimeout(() => {
          timedOut = true;
          send({
            type: "terminal_output",
            id,
            stream: "stderr",
            data: `\r\n[kryct] Command exceeded ${Math.round(ONESHOT_TIMEOUT_MS / 1000)}s with no exit and was stopped.\r\n`,
          });
          handle.kill();
        }, ONESHOT_TIMEOUT_MS)
      : undefined;
  timeout?.unref?.();

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
    send({ type: "error", id, message: `Failed to start process: ${redactError(err)}` }),
  );
  handle.child.on("close", (code) => {
    if (timeout) clearTimeout(timeout);
    session.running.delete(id);
    session.procs.remove(id);
    send({ type: "processes", id: "broadcast", processes: session.procs.list() });
    send({ type: "command_exit", id, exitCode: timedOut ? null : code });
    opts.onExit?.(timedOut ? null : code);
  });
}

/** Agent helper: run a command and resolve with its captured output. The real
 *  logic (incl. the dev-server timeout guard) lives in shellRun.ts so the
 *  session-less public-API run path shares it verbatim. */
function runShell(
  command: string,
  agentId: string,
  workspaceDir: string,
  session: Session,
  config: DaemonConfig,
  send: (m: ServerMessage) => void,
): Promise<{ output: string; exitCode: number | null }> {
  return execCapture(command, agentId, workspaceDir, {
    runtimeMode: session.runtimeMode,
    procs: session.procs,
    running: session.running,
    config,
    send,
  });
}
