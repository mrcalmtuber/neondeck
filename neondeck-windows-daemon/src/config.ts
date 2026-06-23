import path from "node:path";
import os from "node:os";
import { PROXY_PORT, DAEMON_PORT } from "./shared/protocol.js";

/**
 * Daemon configuration. Resolved from CLI flags / env at startup.
 *
 * `projectsRoot` is the hub directory that holds each project subfolder. The
 * active project (chosen from the Hub) becomes a session's workspace, and that
 * workspace is the jail for every file/container op — nothing outside it is
 * reachable.
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
  /** Host gateway port that fronts dynamic container preview slots. */
  proxyPort: number;
  /** DeepSeek secret, sourced from process.env.DEEPSEEK_API_KEY. Never sent out. */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;

  // ---- auth (Firebase) ----
  /** Firebase project id. When set the daemon verifies real Firebase ID tokens
   *  (against Google's public certs); set to "" to fall back to a local "dev"
   *  user. Defaults to the live NeonDeck project so auth works out of the box. */
  firebaseProjectId: string;
  /** Tier granted to the local dev user when auth is not configured. */
  devTier: number;

  // ---- v6: billing (Stripe, test-mode from env) ----
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Stripe price ids per paid tier (test-mode). Empty until you set them. */
  stripePricePro: string;
  stripePriceMax: string;
  /** Where Stripe Checkout returns the user (defaults to the app origin). */
  appOrigin: string;

  /** Directory holding cross-user metering/account ledgers (hidden from Hub). */
  metaDir: string;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.your-ide-domain.com", // <-- replace with your verified production domain
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function loadConfig(argv: string[]): DaemonConfig {
  const args = parseFlags(argv);

  // Back-compat: --workspace X is treated as a single project under root=dirname(X).
  const projectsRoot = path.resolve(
    args.root ??
      process.env.IDE_PROJECTS_ROOT ??
      (args.workspace ? path.dirname(path.resolve(args.workspace)) : null) ??
      path.join(os.homedir(), "ide-projects"),
  );

  const extraOrigins = (args.origin ?? process.env.IDE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins];
  const allowAllOrigins =
    /^(1|true|yes)$/i.test(process.env.IDE_ALLOW_ALL_ORIGINS ?? "") ||
    allowedOrigins.includes("*");
  const appOrigin =
    process.env.IDE_APP_ORIGIN ?? extraOrigins.find((o) => o !== "*") ?? "http://localhost:5173";

  return {
    projectsRoot,
    // Bind globally by default so a headless ARM64 node (Pi 5) is reachable by
    // external users; flip to 127.0.0.1 with --host for loopback-only dev.
    host: args.host ?? process.env.IDE_DAEMON_HOST ?? "0.0.0.0",
    port: Number(args.port ?? process.env.IDE_DAEMON_PORT ?? DAEMON_PORT),
    allowedOrigins,
    allowAllOrigins,
    defaultImage: args.image ?? process.env.IDE_IMAGE ?? "node:20-alpine",
    proxyPort: Number(args.proxyPort ?? process.env.IDE_PROXY_PORT ?? PROXY_PORT),
    // Secret stays here, in backend memory. White-label aliases (AGENT_*) are
    // preferred; the legacy provider-named vars remain as a fallback so existing
    // setups keep working. Field names are internal only — never user-facing.
    deepseekApiKey: process.env.AGENT_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
    deepseekBaseUrl:
      process.env.AGENT_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    deepseekModel: process.env.AGENT_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",

    // Auth (Firebase) — ID tokens verified server-side against Google's public
    // certs. The project id is public; no service-account secret is needed.
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "neondeck-production",
    devTier: parseTier(process.env.IDE_DEV_TIER) ?? 2, // local dev unlocks Max

    // Billing (Stripe, test-mode from env).
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    stripePricePro: process.env.STRIPE_PRICE_PRO ?? "",
    stripePriceMax: process.env.STRIPE_PRICE_MAX ?? "",
    appOrigin,

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
