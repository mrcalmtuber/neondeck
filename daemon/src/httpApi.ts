import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEffort, Tier } from "@ide/shared";
import { allowedOriginFor, loopbackDevAllowed, type DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";
import type { DevStore } from "./devProgram.js";
import { ApiError, type ApiRunManager } from "./apiRuns.js";
import { zipSync } from "fflate";
import { authenticate, authConfigured, userStorageKey } from "./auth.js";
import { fetchSnapshotFiles } from "./firestoreFs.js";
import { adminAuthAvailable, generateResetLink, generateEmailVerificationLink } from "./firebaseAdmin.js";
import { sendResendEmail, passwordResetHtml, emailVerificationHtml } from "./devEmail.js";
import { verifyUnsub } from "./marketing.js";
import {
  billingEnabled,
  createCheckoutSession,
  createApiCheckoutSession,
  changeTier,
  handleWebhook,
  reconcileTierFromStripe,
} from "./billing.js";

/**
 * Minimal HTTP API mounted on the same host/port as the WebSocket (default
 * 0.0.0.0:5050; see daemon/src/config.ts and DAEMON_PORT in shared/src/protocol.ts).
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
export function createApiHandler(
  config: DaemonConfig,
  store: UsageStore,
  devStore: DevStore,
  apiRuns: ApiRunManager,
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const origin = req.headers.origin;

    // ---- Public developer API (/api/v1/*) — API-key auth, server-to-server.
    // Routed BEFORE the CORS block on purpose: no Access-Control headers are
    // ever emitted here, so a browser page can't be scripted against it.
    if (path.startsWith("/api/v1/")) {
      return handleDevApi(req, res, url, config, store, devStore, apiRuns);
    }

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

      // ---- Forgot password (public, pre-auth): generate a Firebase reset link
      // via the Admin SDK and send it as a branded email through Resend. The
      // response NEVER reveals whether the account exists; when admin/Resend
      // aren't configured (or fail) the client falls back to Firebase's own
      // default sender, so the flow degrades instead of dead-ending. ----
      if (path === "/api/auth/reset" && req.method === "POST") {
        const body = await readJson(req);
        const email = String(body.email ?? "")
          .trim()
          .toLowerCase();
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json(res, 400, { error: "Enter a valid email address." });
        }
        if (
          windowLimited(clientIp(req, config), resetIpOps, RESET_MAX, RESET_WINDOW_MS) ||
          windowLimited(email, resetEmailOps, RESET_MAX, RESET_WINDOW_MS)
        ) {
          res.setHeader("Retry-After", "900");
          return json(res, 429, { error: "Too many reset requests. Try again in a few minutes." });
        }
        if (!adminAuthAvailable() || !config.resendApiKey) {
          return json(res, 200, { ok: false, fallback: true });
        }
        try {
          const link = await generateResetLink(email, config.appOrigin);
          if (link) {
            await sendResendEmail(config, {
              from: config.passwordResetEmailFrom,
              to: email,
              subject: "Reset your Kryct password",
              html: passwordResetHtml(link),
            });
          }
          // Unknown email (link === null) returns the SAME body — no enumeration.
          return json(res, 200, { ok: true, sent: "resend" });
        } catch (err) {
          console.warn("[auth] reset email failed:", (err as Error).message);
          return json(res, 200, { ok: false, fallback: true });
        }
      }

      // ---- Email verification (signed-in): send a BRANDED verification email
      // through Resend (Firebase's default sender is unreliable / lands in spam).
      // Auth'd by the caller's token; only ever mails the caller's OWN address.
      // Degrades to the client's Firebase sender via {fallback:true}. ----
      if (path === "/api/auth/verify-email" && req.method === "POST") {
        const body = await readJson(req);
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        ).catch(() => null);
        if (!user || !user.email) return json(res, 200, { ok: false, fallback: true });
        if (windowLimited(user.userId, verifyOps, RESET_MAX, RESET_WINDOW_MS)) {
          res.setHeader("Retry-After", "900");
          return json(res, 429, { error: "Too many requests. Try again in a few minutes." });
        }
        if (!adminAuthAvailable() || !config.resendApiKey) {
          return json(res, 200, { ok: false, fallback: true });
        }
        try {
          const link = await generateEmailVerificationLink(user.email, config.appOrigin);
          if (link) {
            await sendResendEmail(config, {
              from: config.passwordResetEmailFrom,
              to: user.email,
              subject: "Verify your Kryct email",
              html: emailVerificationHtml(link),
            });
          }
          return json(res, 200, { ok: true, sent: "resend" });
        } catch (err) {
          console.warn("[auth] verification email failed:", (err as Error).message);
          return json(res, 200, { ok: false, fallback: true });
        }
      }

      // ---- Marketing consent (signed-in): store the sign-up checkbox choices
      // (ToS accepted; marketing opt-in). Called right after registration. ----
      if (path === "/api/account/consent" && req.method === "POST") {
        const body = await readJson(req);
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        await store.ensureLoaded(user.userId);
        store.setMarketingConsent(user.userId, body.marketingOptIn !== false);
        await store.flush();
        return json(res, 200, { ok: true });
      }

      // ---- Email unsubscribe — STEP 2 of a two-step opt-out. The email link
      // sends the user to the app (…/?unsub=<uid>&t=<token>), which shows a
      // confirmation popup; only that popup's confirm button POSTs here to
      // actually hard-stop all mail. The signed token is the authorization
      // (works signed-out, straight from the email). ----
      if (path === "/api/email/unsubscribe" && req.method === "POST") {
        const body = await readJson(req);
        const uid = String(body.u ?? "");
        const token = String(body.t ?? "");
        if (!uid || !verifyUnsub(uid, token, config.resendApiKey)) {
          return json(res, 400, { error: "This unsubscribe link isn't valid or has expired." });
        }
        await store.ensureLoaded(uid);
        store.setEmailUnsubscribed(uid);
        await store.flush();
        return json(res, 200, { ok: true });
      }

      // ---- Suspension appeal (signed-in users): relay the user's message to
      // the support inbox via Resend, reply-to set to their account email so
      // support can answer directly. Without Resend the client falls back to a
      // plain mailto: link — the flow never dead-ends. ----
      if (path === "/api/support/appeal" && req.method === "POST") {
        const body = await readJson(req);
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        const message = String(body.message ?? "").trim();
        if (message.length < 10) {
          return json(res, 400, { error: "Tell us a bit more (at least 10 characters)." });
        }
        if (message.length > 2000) {
          return json(res, 400, { error: "Please keep your appeal under 2000 characters." });
        }
        if (windowLimited(user.userId, appealOps, APPEAL_MAX, APPEAL_WINDOW_MS)) {
          res.setHeader("Retry-After", "3600");
          return json(res, 429, {
            error: "You've already sent several appeals today — support will get back to you.",
          });
        }
        if (!config.resendApiKey) return json(res, 200, { ok: false, fallback: true });
        try {
          await sendResendEmail(config, {
            from: config.devEmailFrom,
            to: config.supportEmail,
            replyTo: user.email ?? undefined,
            subject: `Suspension appeal — ${user.email ?? user.userId}`,
            html: `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px">Suspension appeal</h2>
  <p style="margin:0 0 4px"><strong>User:</strong> ${escapeHtml(user.email ?? "(no email)")}</p>
  <p style="margin:0 0 4px"><strong>User id:</strong> ${escapeHtml(user.userId)}</p>
  <p style="margin:0 0 12px"><strong>Sent:</strong> ${new Date().toISOString()}</p>
  <p style="background:#f5f5f7;border-radius:8px;padding:12px 16px;white-space:pre-wrap">${escapeHtml(message)}</p>
  <p style="color:#666;font-size:13px">Reply to this email to answer the user directly. Unsuspend via the admin dashboard.</p>
</div>`,
          });
          return json(res, 200, { ok: true });
        } catch (err) {
          console.warn("[support] appeal email failed:", (err as Error).message);
          return json(res, 200, { ok: false, fallback: true });
        }
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
        // Deliver the token to whichever origin the app is actually on. The popup
        // may be served from the onrender URL, a custom domain (same host as the
        // opener), or — in local dev — a different port than the web app. So we
        // postMessage to each candidate origin: the request's own origin AND the
        // configured appOrigin. The browser only delivers to the one matching
        // window.opener's real origin and drops the rest, so this never leaks the
        // token and needs no IDE_APP_ORIGIN change when you add a custom domain.
        const rawHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
          .split(",")[0]
          .trim();
        // Sanitize — it's embedded in the HTML below; only allow a real host[:port].
        const reqHost = /^[a-zA-Z0-9.\-:]+$/.test(rawHost) ? rawHost : "";
        const fwdProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
        const reqProto =
          fwdProto === "https" || fwdProto === "http"
            ? fwdProto
            : (req.socket as unknown as { encrypted?: boolean }).encrypted
              ? "https"
              : "http";
        const targets = [
          ...new Set([reqHost ? `${reqProto}://${reqHost}` : "", config.appOrigin].filter(Boolean)),
        ];
        const msg = JSON.stringify({ type: "github-oauth", token, state });
        const html = `<!doctype html><meta charset="utf-8"><title>Connecting GitHub…</title>
<body style="font-family:system-ui;background:#0b0f19;color:#e8f0ff;display:grid;place-items:center;height:100vh">
<p>${token ? "GitHub connected — you can close this window." : "GitHub connection failed."}</p>
<script>(function(){var T=${JSON.stringify(targets)},M=${msg};try{if(window.opener)T.forEach(function(o){try{window.opener.postMessage(M,o);}catch(e){}});}catch(e){}setTimeout(function(){window.close();},300);})();</script>
</body>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ---- Stripe webhook (raw body, no CORS, no auth — Stripe signs it) ----
      if (path === "/api/webhooks/stripe" && req.method === "POST") {
        const raw = await readRawBody(req);
        try {
          const result = await handleWebhook(config, store, devStore, raw, req.headers["stripe-signature"] as string | undefined);
          await devStore.flush(); // card-on-file must survive an immediate restart
          return json(res, 200, result);
        } catch (err) {
          // 400 tells Stripe the signature/verification failed.
          return json(res, 400, { error: (err as Error).message });
        }
      }

      // ---- Developer program: card + metered API billing checkout (one hosted
      // session collects the card AND activates the $6/$10-per-1M metered
      // subscription). Requires an ACCEPTED developer. ----
      if (path === "/api/dev/create-card-session" && req.method === "POST") {
        if (!config.devProgramEnabled) return json(res, 403, { error: "The developer program is disabled." });
        const body = await readJson(req);
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        await devStore.ensureLoaded(user.userId);
        if (devStore.statusFor(user.userId).status !== "accepted") {
          return json(res, 403, { error: "You're not an accepted developer yet." });
        }
        const checkoutUrl = await createApiCheckoutSession(config, devStore, {
          userId: user.userId,
          email: user.email,
        });
        await devStore.flush(); // persist a mock card-grant immediately
        return json(res, 200, { url: checkoutUrl });
      }

      // ---- Create a Checkout session (real Stripe, or mock fallback) ----
      if (
        (path === "/api/create-checkout-session" || path === "/api/billing/checkout") &&
        req.method === "POST"
      ) {
        const body = await readJson(req);
        const tier = Number(body.tier) as Tier;
        if (tier !== 1 && tier !== 2) return json(res, 400, { error: "tier must be 1 (Pro) or 2 (Max)." });
        const interval = body.interval === "year" ? "year" : "month";
        const user = await authenticate(
          config,
          bearer(req) ?? (typeof body.token === "string" ? body.token : undefined),
          { allowLoopbackDev },
        );
        await store.ensureLoaded(user.userId); // operate on the durable tier/usage
        const start = await createCheckoutSession(config, store, {
          userId: user.userId,
          email: user.email,
          tier,
          interval,
        });
        await store.flush(); // persist a mock-grant immediately (don't lose it to a restart)
        if (start.clientSecret && !config.stripePublishableKey) {
          return json(res, 500, {
            error: "Checkout is misconfigured: set STRIPE_PUBLISHABLE_KEY (pk_…) on the daemon.",
          });
        }
        return json(res, 200, {
          ...start,
          ...(start.clientSecret ? { publishableKey: config.stripePublishableKey } : {}),
        });
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
        await store.ensureLoaded(user.userId); // read the durable tier before changing it
        const devTier = user.mode === "dev" ? (config.devTier as Tier) : undefined;
        const usage = await changeTier(config, store, { userId: user.userId, tier, devTier });
        await store.flush(); // persist the downgrade immediately so a reload can't revert it
        return json(res, 200, { usage });
      }

      // ---- Current tier + usage ----
      if (path === "/api/me" && req.method === "GET") {
        const user = await authenticate(config, bearer(req), { allowLoopbackDev });
        await store.ensureLoaded(user.userId); // durable usage before reading the meter
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

      // ---- Project .zip export (Bearer token). Serves any OWNED snapshot
      // project — it's the user's own data, bounded by the snapshot quota
      // (~20 MB stored) and rate-limited. Archived projects are the primary
      // UI entry point (their only remaining action besides Restore).
      if (path === "/api/project-zip" && req.method === "GET") {
        const user = await authenticate(config, bearer(req), { allowLoopbackDev });
        const name = String(url.searchParams.get("name") ?? "");
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name)) {
          return json(res, 400, { error: "Invalid project name." });
        }
        if (windowLimited(user.userId, zipOps, ZIP_MAX, ZIP_WINDOW_MS)) {
          res.setHeader("Retry-After", "600");
          return json(res, 429, { error: "Too many downloads — try again in a few minutes." });
        }
        const key = userStorageKey({ userId: user.userId, mode: user.mode });
        const files = await fetchSnapshotFiles(config, key, name);
        if (!files || files.size === 0) {
          return json(res, 404, { error: "No backup found for this project." });
        }
        const input: Record<string, Uint8Array> = {};
        for (const [rel, buf] of files) input[rel] = buf;
        const zipped = zipSync(input); // sync is fine: the snapshot quota bounds size
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": zipped.length,
          "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}.zip"`,
        });
        res.end(Buffer.from(zipped));
        return;
      }

      return json(res, 404, { error: "Unknown API route" });
    } catch (err) {
      return json(res, 400, { error: safeErr(err) });
    }
  };
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

// ---------------------------------------------------------------------------
// Public developer API — /api/v1/* (Authorization: Bearer ndk_...)
// ---------------------------------------------------------------------------

/** Per-key sliding-window rate buckets (same style as the WS limiter). */
const KEY_RATE_WINDOW_MS = 60_000;
const KEY_RATE_MAX = 60; // requests / min / key
const KEY_RUN_MAX = 5; // run creations / min / key

function keyRateLimited(keyId: string, bucket: Map<string, number[]>, max: number): boolean {
  return windowLimited(keyId, bucket, max, KEY_RATE_WINDOW_MS);
}

/**
 * M14: every rate bucket registers here with its widest window so a single
 * periodic sweep can evict fully-stale keys. Without it these Maps grow forever
 * as an attacker cycles unique IPs / emails / key ids, exhausting daemon memory.
 */
const RATE_BUCKETS: Array<{ bucket: Map<string, number[]>; windowMs: number }> = [];
function registerBucket(bucket: Map<string, number[]>, windowMs: number): Map<string, number[]> {
  RATE_BUCKETS.push({ bucket, windowMs });
  return bucket;
}
function sweepRateBuckets(): void {
  const now = Date.now();
  for (const { bucket, windowMs } of RATE_BUCKETS) {
    for (const [key, list] of bucket) {
      // A key is dead once its most-recent hit falls outside the window.
      if (list.length === 0 || now - list[list.length - 1] >= windowMs) bucket.delete(key);
    }
  }
}
// Sweep every 10 min. unref so it never keeps the process alive on its own.
setInterval(sweepRateBuckets, 10 * 60_000).unref?.();

const keyOps = registerBucket(new Map<string, number[]>(), KEY_RATE_WINDOW_MS);
const keyRunOps = registerBucket(new Map<string, number[]>(), KEY_RATE_WINDOW_MS);

/** Generic sliding-window limiter (shared by the API-key and reset buckets). */
function windowLimited(
  key: string,
  bucket: Map<string, number[]>,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const list = (bucket.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  bucket.set(key, list);
  return list.length > max;
}

// Password-reset abuse guard: 3 requests / 15 min per client IP AND per email.
const RESET_WINDOW_MS = 15 * 60_000;
const RESET_MAX = 3;
const resetIpOps = registerBucket(new Map<string, number[]>(), RESET_WINDOW_MS);
const resetEmailOps = registerBucket(new Map<string, number[]>(), RESET_WINDOW_MS);

// Suspension-appeal guard: 3 appeals / 24h per user (they go to a human inbox).
const APPEAL_WINDOW_MS = 24 * 3_600_000;
const APPEAL_MAX = 3;
const appealOps = registerBucket(new Map<string, number[]>(), APPEAL_WINDOW_MS);

// Email-verification resend guard: reuse the reset cadence (3 / 15 min per user).
const verifyOps = registerBucket(new Map<string, number[]>(), RESET_WINDOW_MS);

// Project-zip export guard: 5 downloads / 10 min per user (each can be ~20 MB).
const ZIP_WINDOW_MS = 10 * 60_000;
const ZIP_MAX = 5;
const zipOps = registerBucket(new Map<string, number[]>(), ZIP_WINDOW_MS);

/** Escape user-supplied text before interpolating it into email HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Requester IP — behind Render's TLS proxy the socket address is the proxy,
 *  so honor X-Forwarded-For exactly when the daemon trusts proxy headers. */
function clientIp(req: IncomingMessage, config: DaemonConfig): string {
  if (config.trustProxyHeaders) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function handleDevApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: DaemonConfig,
  store: UsageStore,
  devStore: DevStore,
  apiRuns: ApiRunManager,
): Promise<void> {
  const path = url.pathname;
  try {
    if (!config.devProgramEnabled) {
      return json(res, 403, { error: "The developer program is disabled." });
    }
    // ---- API-key auth (the ONLY credential /api/v1 accepts) ----
    const token = bearer(req);
    if (!token || !token.startsWith("ndk_")) {
      return json(res, 401, { error: "Missing API key. Send `Authorization: Bearer ndk_...`." });
    }
    const resolved = await devStore.resolveKey(token);
    if (!resolved) return json(res, 401, { error: "Invalid or revoked API key." });
    const { userId, keyId } = resolved;

    await store.ensureLoaded(userId);
    if (store.isSuspended(userId)) {
      return json(res, 403, { error: "This account is suspended." });
    }
    if (!devStore.statusFor(userId).cardOnFile) {
      return json(res, 402, { error: "No active billing — add a card in Settings → Dev." });
    }
    if (keyRateLimited(keyId, keyOps, KEY_RATE_MAX)) {
      res.setHeader("Retry-After", "30");
      return json(res, 429, { error: "Rate limit exceeded (60 requests/min)." });
    }
    devStore.touchLastUsed(userId, keyId);

    // ---- Routes ----
    if (path === "/api/v1/runs" && req.method === "POST") {
      if (keyRateLimited(keyId, keyRunOps, KEY_RUN_MAX)) {
        res.setHeader("Retry-After", "30");
        return json(res, 429, { error: "Run-creation limit exceeded (5/min)." });
      }
      const body = await readJson(req);
      const run = await apiRuns.createRun(userId, keyId, {
        project: String(body.project ?? ""),
        prompt: String(body.prompt ?? ""),
        effort: typeof body.effort === "string" ? (body.effort as AgentEffort) : undefined,
      });
      return json(res, 201, run);
    }

    const runMatch = path.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)(\/events|\/cancel)?$/);
    if (runMatch) {
      const [, runId, sub] = runMatch;
      if (!sub && req.method === "GET") {
        const run = apiRuns.getRun(userId, runId);
        if (!run) return json(res, 404, { error: "No such run." });
        return json(res, 200, run);
      }
      if (sub === "/events" && req.method === "GET") {
        apiRuns.attachSse(userId, runId, res); // writes the SSE headers itself
        return;
      }
      if (sub === "/cancel" && req.method === "POST") {
        const out = apiRuns.cancelRun(userId, runId);
        return json(res, 200, { runId, status: out.status });
      }
    }

    if (path === "/api/v1/projects" && req.method === "GET") {
      const projects = await apiRuns.listProjectsFor(userId);
      return json(res, 200, { projects });
    }

    return json(res, 404, { error: "Unknown API route." });
  } catch (err) {
    if (err instanceof ApiError) {
      if (!res.headersSent) return json(res, err.status, { error: err.message });
      return;
    }
    if (!res.headersSent) return json(res, 400, { error: safeErr(err) });
  }
}

/** Strip absolute server paths from an error before returning it to a client (L3). */
function safeErr(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err);
  return raw.replace(/\/(?:Users|home|root|app|data|var|tmp|opt|private|mnt|srv)\/[^\s'")]*/gi, "<path>");
}

/** Cap on request bodies (M7) — API payloads are tiny JSON / Stripe webhooks; a
 *  bigger body is abuse and would otherwise buffer unbounded in memory. */
const MAX_BODY_BYTES = 1_000_000; // 1 MB

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      total += (c as Buffer).length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c as Buffer);
    });
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
