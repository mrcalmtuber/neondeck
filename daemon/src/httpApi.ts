import type { IncomingMessage, ServerResponse } from "node:http";
import type { Tier } from "@ide/shared";
import { allowedOriginFor, loopbackDevAllowed, type DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";
import { authenticate, authConfigured } from "./auth.js";
import {
  billingEnabled,
  createCheckoutSession,
  changeTier,
  handleWebhook,
  reconcileTierFromStripe,
} from "./billing.js";

/**
 * Minimal HTTP API mounted on the same host/port as the WebSocket (default
 * 0.0.0.0:5000; see daemon/src/config.ts).
 *
 *   POST /api/webhooks/stripe          Stripe -> verify signature -> update tier
 *   POST /api/create-checkout-session  { tier } (Bearer JWT) -> hosted checkout URL
 *   GET  /api/me                       (Bearer JWT) -> tier + usage snapshot
 *   GET  /api/health                   liveness + capability flags
 *
 * /api/billing/checkout remains as a back-compat alias of the checkout route.
 *
 * The Stripe route reads the RAW body (signature verification needs the exact
 * bytes). Browser routes use CORS limited to the daemon's allowed origins.
 */
export function createApiHandler(config: DaemonConfig, store: UsageStore) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const origin = req.headers.origin;
    // Same loopback dev-trust the WS handshake uses, so a token-less local-dev
    // user can hit the billing routes without a Firebase token.
    const allowLoopbackDev = loopbackDevAllowed(req, config);

    // CORS for browser-originated calls (dynamic: allow-list, or any origin when
    // IDE_ALLOW_ALL_ORIGINS is set).
    const corsOrigin = allowedOriginFor(config, origin);
    if (corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return end(res, 204, "");

    if (!path.startsWith("/api/")) return json(res, 404, { error: "Not found" });

    try {
      if (path === "/api/health" && req.method === "GET") {
        return json(res, 200, {
          ok: true,
          authMode: authConfigured(config) ? "firebase" : "dev",
          billingEnabled: billingEnabled(config),
          // Public client id so the browser can build the GitHub authorize URL.
          // null when GitHub OAuth isn't configured → the UI hides "Connect GitHub".
          githubClientId: config.githubClientId || null,
        });
      }

      // ---- GitHub OAuth callback: exchange the code for a token, hand it to the
      // opener via postMessage (the browser stores it; the daemon never persists
      // it). The secret stays here. ----
      if (path === "/api/github/callback" && req.method === "GET") {
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        let token = "";
        if (code && config.githubClientId && config.githubClientSecret) {
          try {
            const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                client_id: config.githubClientId,
                client_secret: config.githubClientSecret,
                code,
              }),
            });
            token = ((await tokenRes.json()) as { access_token?: string }).access_token ?? "";
          } catch {
            /* token stays empty → the page reports failure */
          }
        }
        const msg = JSON.stringify({ type: "github-oauth", token, state });
        const target = JSON.stringify(config.appOrigin);
        const html = `<!doctype html><meta charset="utf-8"><title>Connecting GitHub…</title>
<body style="font-family:system-ui;background:#0b0f19;color:#e8f0ff;display:grid;place-items:center;height:100vh">
<p>${token ? "GitHub connected — you can close this window." : "GitHub connection failed."}</p>
<script>(function(){try{window.opener&&window.opener.postMessage(${msg}, ${target});}catch(e){}setTimeout(function(){window.close();},300);})();</script>
</body>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ---- Stripe webhook (raw body, no CORS, no auth — Stripe signs it) ----
      if (path === "/api/webhooks/stripe" && req.method === "POST") {
        const raw = await readRawBody(req);
        try {
          const result = await handleWebhook(config, store, raw, req.headers["stripe-signature"] as string | undefined);
          return json(res, 200, result);
        } catch (err) {
          // 400 tells Stripe the signature/verification failed.
          return json(res, 400, { error: (err as Error).message });
        }
      }

      // ---- Create a Checkout session (real Stripe, or mock fallback) ----
      if (
        (path === "/api/create-checkout-session" || path === "/api/billing/checkout") &&
        req.method === "POST"
      ) {
        const body = await readJson(req);
        const tier = Number(body.tier) as Tier;
        if (tier !== 1 && tier !== 2) return json(res, 400, { error: "tier must be 1 (Pro) or 2 (Max)." });
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        const checkoutUrl = await createCheckoutSession(config, store, { userId: user.userId, email: user.email, tier });
        return json(res, 200, { url: checkoutUrl });
      }

      // ---- Downgrade to a lower tier (incl. Free); never upgrades ----
      if (path === "/api/billing/change-tier" && req.method === "POST") {
        const body = await readJson(req);
        const tier = Number(body.tier) as Tier;
        if (tier !== 0 && tier !== 1 && tier !== 2) return json(res, 400, { error: "Invalid tier." });
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        const devTier = user.mode === "dev" ? (config.devTier as Tier) : undefined;
        const usage = await changeTier(config, store, { userId: user.userId, tier, devTier });
        return json(res, 200, { usage });
      }

      // ---- Current tier + usage ----
      if (path === "/api/me" && req.method === "GET") {
        const user = await authenticate(config, bearer(req), { allowLoopbackDev });
        // Stripe is the source of truth — reconcile before reading (this is the
        // call the app makes on return from Checkout, so the upgrade lands here
        // even if the webhook/ledger missed it). Best-effort; never blocks /me.
        if (user.mode === "firebase") {
          await reconcileTierFromStripe(config, store, {
            userId: user.userId,
            email: user.email,
          }).catch(() => null);
        }
        const tier = store.tierFor(user.userId, user.mode === "dev" ? { devTier: config.devTier as Tier } : {});
        return json(res, 200, { userId: user.userId, tier, usage: store.snapshot(user.userId, tier) });
      }

      return json(res, 404, { error: "Unknown API route" });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  };
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(payload);
}

function end(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code);
  res.end(body);
}
