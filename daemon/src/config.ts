import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { PROXY_PORT, DAEMON_PORT, type AgentEffort } from "@ide/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Built web SPA, relative to the daemon source/dist (repo/web/dist). Served when
 *  it exists so one process can host web + API + WS + previews on a single port. */
const DEFAULT_WEB_DIR = path.resolve(__dirname, "../../web/dist");

/**
 * Daemon configuration. Resolved from CLI flags / env at startup.
 *
 * `projectsRoot` is the hub directory that holds each project subfolder. The
 * active project (chosen from the Hub) becomes a session's workspace, and that
 * workspace is the jail for every file/container op — nothing outside it is
 * reachable. It defaults to a hidden app folder (~/.neondeck/projects) so user
 * projects don't clutter the home directory; override with IDE_PROJECTS_ROOT.
 *
 * `deepseekApiKey` is read from the host environment and kept in backend memory
 * only — it is never serialized to the browser.
 */
export interface DaemonConfig {
  projectsRoot: string;
  /** Interface the WS/HTTP server binds. Default 0.0.0.0 (headless prod, e.g. a
   *  Raspberry Pi 5). Override with --host 127.0.0.1 for loopback-only dev. */
  host: string;
  /** WS/HTTP listen port (default 5000). */
  port: number;
  allowedOrigins: string[];
  /** When true, accept WS/HTTP from ANY origin (reflected). Opt-in only — set
   *  IDE_ALLOW_ALL_ORIGINS=1 or include "*" in the origin list. Don't enable on
   *  an internet-facing node without Firebase auth + a firewall. */
  allowAllOrigins: boolean;
  /** Container image used for `run_command` shells and the dev server. */
  defaultImage: string;
  /** Legacy preview gateway port. The proxy is now mounted on the main `port`
   *  (see server.ts) so the whole app fits one PaaS port; this is kept only for
   *  the hello payload's back-compat field and binds nothing. */
  proxyPort: number;
  /** Built web SPA directory served on the main port (empty/missing → not served,
   *  e.g. local dev where Vite serves the web). Override with IDE_WEB_DIR. */
  webDir: string;
  /** DeepSeek secret, sourced from process.env.DEEPSEEK_API_KEY. Never sent out. */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  /** Model per reasoning-effort level (free=low / pro=high / max=max). Each
   *  defaults to deepseekModel; set AGENT_MODEL_LOW / _HIGH / _MAX to route the
   *  higher-effort tiers to a distinct (e.g. reasoning) model. */
  agentModels: Record<AgentEffort, string>;

  // ---- auth (Firebase) ----
  /** Firebase project id. When set the daemon verifies real Firebase ID tokens
   *  (against Google's public certs); set to "" to fall back to a local "dev"
   *  user. Defaults to the live NeonDeck project so auth works out of the box. */
  firebaseProjectId: string;
  /** Tier granted to the local dev user when auth is not configured. */
  devTier: number;
  /** LOCAL DEV ONLY: when true AND the daemon is bound to a loopback host, a
   *  token-less connection from loopback is granted the local "dev" user (so
   *  daemon mode works with no sign-in). Off by default; never enable on a
   *  public node or behind a reverse proxy (see server.ts gating). */
  trustLoopback: boolean;

  // ---- v6: billing (Stripe, test-mode from env) ----
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Stripe price ids per paid tier (test-mode). Empty until you set them. */
  stripePricePro: string;
  stripePriceMax: string;
  /** Where Stripe Checkout returns the user (defaults to the app origin). */
  appOrigin: string;

  // ---- v7: GitHub OAuth (per-user project sync to their own GitHub) ----
  /** OAuth App client id (public — sent to the browser to build the authorize
   *  URL) and secret (daemon-only — used in the code→token exchange). Empty until
   *  set; when unset the whole GitHub-sync feature is off. */
  githubClientId: string;
  githubClientSecret: string;

  // ---- Admin ops ----
  /** Login emails granted admin access (the ops dashboard + maintenance toggle).
   *  From ADMIN_EMAILS (comma-separated); compared lowercased against the user's
   *  Firebase email. Defaults to the owner so the dashboard works out of the box. */
  adminEmails: string[];

  /** Directory holding cross-user metering/account ledgers (hidden from Hub). */
  metaDir: string;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.your-ide-domain.com", // <-- replace with your verified production domain
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/** Legacy + hidden default locations for the projects hub. */
const LEGACY_PROJECTS_ROOT = path.join(os.homedir(), "ide-projects");
const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), ".neondeck", "projects");

/** Resolve the projects hub. An explicit override (flag/env/--workspace) always
 *  wins; otherwise default to the hidden ~/.neondeck/projects, migrating a legacy
 *  ~/ide-projects into it once so existing projects don't disappear. */
function resolveProjectsRoot(args: Record<string, string>): string {
  // Back-compat: --workspace X is treated as a single project under root=dirname(X).
  const explicit =
    args.root ??
    process.env.IDE_PROJECTS_ROOT ??
    (args.workspace ? path.dirname(path.resolve(args.workspace)) : null);
  if (explicit) return path.resolve(explicit);

  const root = DEFAULT_PROJECTS_ROOT;
  try {
    if (!fs.existsSync(root) && fs.existsSync(LEGACY_PROJECTS_ROOT)) {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.renameSync(LEGACY_PROJECTS_ROOT, root);
      console.log(`[daemon] migrated projects: ${LEGACY_PROJECTS_ROOT} -> ${root}`);
    }
  } catch (err) {
    console.warn(`[daemon] projects migration skipped: ${(err as Error).message}`);
  }
  return root;
}

export function loadConfig(argv: string[]): DaemonConfig {
  const args = parseFlags(argv);

  const projectsRoot = resolveProjectsRoot(args);

  const extraOrigins = (args.origin ?? process.env.IDE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins];
  const allowAllOrigins =
    /^(1|true|yes)$/i.test(process.env.IDE_ALLOW_ALL_ORIGINS ?? "") ||
    allowedOrigins.includes("*");
  // Where Stripe Checkout returns the browser. Prefer an explicit override; on
  // Render the platform injects RENDER_EXTERNAL_URL (the live https URL), so real
  // checkout returns to the deployed site with zero manual config.
  const appOrigin =
    process.env.IDE_APP_ORIGIN ??
    process.env.RENDER_EXTERNAL_URL ??
    extraOrigins.find((o) => o !== "*") ??
    "http://localhost:5173";

  // Base agent model; effort variants fall back to it unless explicitly overridden.
  const agentModel = process.env.AGENT_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

  return {
    projectsRoot,
    // Bind globally by default so a headless ARM64 node (Pi 5) is reachable by
    // external users; flip to 127.0.0.1 with --host for loopback-only dev.
    host: args.host ?? process.env.IDE_DAEMON_HOST ?? "0.0.0.0",
    // $PORT is injected by PaaS platforms (Fly/Render/Railway) — honor it so one
    // service can be reached on the platform's assigned port.
    port: Number(args.port ?? process.env.PORT ?? process.env.IDE_DAEMON_PORT ?? DAEMON_PORT),
    allowedOrigins,
    allowAllOrigins,
    defaultImage: args.image ?? process.env.IDE_IMAGE ?? "node:20-alpine",
    proxyPort: Number(args.proxyPort ?? process.env.IDE_PROXY_PORT ?? PROXY_PORT),
    webDir: args.webDir ?? process.env.IDE_WEB_DIR ?? DEFAULT_WEB_DIR,
    // Secret stays here, in backend memory. White-label aliases (AGENT_*) are
    // preferred; the legacy provider-named vars remain as a fallback so existing
    // setups keep working. Field names are internal only — never user-facing.
    deepseekApiKey: process.env.AGENT_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
    deepseekBaseUrl:
      process.env.AGENT_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    deepseekModel: agentModel,
    agentModels: {
      low: process.env.AGENT_MODEL_LOW ?? agentModel,
      medium: process.env.AGENT_MODEL_MEDIUM ?? agentModel,
      high: process.env.AGENT_MODEL_HIGH ?? agentModel,
    },

    // Auth (Firebase) — ID tokens verified server-side against Google's public
    // certs. The project id is public; no service-account secret is needed.
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "neondeck-8cbe0",
    devTier: parseTier(process.env.IDE_DEV_TIER) ?? 2, // local dev unlocks Max
    trustLoopback: /^(1|true|yes)$/i.test(process.env.IDE_TRUST_LOOPBACK ?? ""),

    // Billing (Stripe, test-mode from env).
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    stripePricePro: process.env.STRIPE_PRICE_PRO ?? "",
    stripePriceMax: process.env.STRIPE_PRICE_MAX ?? "",
    appOrigin,

    // GitHub OAuth (per-user project sync). Off unless both are set.
    githubClientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    githubClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",

    // Admin ops — who can see the dashboard + flip maintenance.
    adminEmails: (process.env.ADMIN_EMAILS ?? "jbondgamer911@gmail.com")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),

    metaDir: path.join(projectsRoot, ".ide-meta"),
  };
}

/**
 * Dynamic CORS / WS origin gate. Returns the value to reflect in
 * Access-Control-Allow-Origin (or pass to ws verifyClient), or null to reject.
 * With allowAllOrigins we echo whatever origin asked; otherwise we match the
 * configured allow-list exactly.
 */
export function allowedOriginFor(config: DaemonConfig, origin: string | undefined): string | null {
  if (config.allowAllOrigins) return origin ?? "*";
  if (origin && config.allowedOrigins.includes(origin)) return origin;
  return null;
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Decide whether a connection may use the token-less local "dev" user. Shared by
 * the WS handshake (server.ts) and the HTTP API (httpApi.ts). ALL must hold
 * (defense-in-depth so a public node never grants dev access):
 *   1. IDE_TRUST_LOOPBACK is set,
 *   2. the daemon is bound to a loopback host (a 0.0.0.0 bind disables it),
 *   3. NO proxy headers are present (a proxy makes every client look loopback),
 *   4. the socket's remote address is loopback.
 * Never enable IDE_TRUST_LOOPBACK on a public node or behind a reverse proxy.
 */
export function loopbackDevAllowed(req: IncomingMessage, config: DaemonConfig): boolean {
  if (!config.trustLoopback) return false;
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    console.warn("[daemon] IDE_TRUST_LOOPBACK ignored: daemon is not bound to a loopback host.");
    return false;
  }
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"]) {
    return false; // a proxy is in front — the socket address can't be trusted
  }
  return LOOPBACK_ADDRS.has(req.socket.remoteAddress ?? "");
}

/** Accept a tier as 0/1/2 or free/pro/max. */
function parseTier(v: string | undefined): number | null {
  if (!v) return null;
  const map: Record<string, number> = { free: 0, pro: 1, max: 2, "0": 0, "1": 1, "2": 2 };
  return map[v.trim().toLowerCase()] ?? null;
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}
