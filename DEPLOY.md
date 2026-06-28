# Deploying NeonDeck (one service, one URL)

NeonDeck runs as a **single service**: one process serves the web app, the REST API, the
WebSocket, and the live-preview gateway on **one port**. This guide targets **Render**
(it has a usable free tier). The same `Dockerfile` works on any Docker host — see the
bottom for Fly / Railway / a VM.

## Deploy to Render

1. **Push this repo to GitHub** (Render deploys from a connected git repo).

2. **Create the service.** Easiest path: Render Dashboard → **New → Blueprint** → pick this
   repo. Render reads `render.yaml` and creates a free Docker web service. (Or **New → Web
   Service → Docker**, free plan, health check path `/api/health`.)

3. **Set the secrets** (Dashboard → the service → Environment) — only two are required:
   - `AGENT_API_KEY` — your DeepSeek key (stays server-side, never shipped to the browser)
   - `FIREBASE_PROJECT_ID` — the project your web app uses, **`neondeck-8cbe0`** (must match
     the web client, or the handshake rejects every login)
   - `IDE_APP_ORIGIN` / `IDE_ALLOWED_ORIGINS` — **not needed.** The daemon auto-trusts
     same-origin requests (web + API + WS share one origin), and Stripe's checkout return URL
     is auto-derived from Render's `RENDER_EXTERNAL_URL`. Only set `IDE_APP_ORIGIN` if you
     serve the web from a *different* host (e.g. a custom domain).
   - **Stripe** (real billing) — optional; see the **Stripe** section below.

4. **Deploy.** Then **add `<name>.onrender.com` to Firebase → Authentication → Authorized
   domains** of the `neondeck-8cbe0` project (Google sign-in needs the domain whitelisted on
   HTTPS).

5. Open **https://<name>.onrender.com**. The web auto-connects to the daemon same-origin
   (no build config needed); previews render through the same URL.

### ⚠ Render free-tier limits (important)
- **Sleeps after ~15 min idle** → the next visit cold-starts (~30–60s) and any running
  preview dev server is killed. Fine for occasional family use; annoying for always-on.
- **No persistent disk on free** → user projects (`IDE_PROJECTS_ROOT=/data/projects`) are
  **wiped on every restart/sleep/deploy**. Two ways to keep them: let users **Connect GitHub**
  (next section — free, projects sync to each user's own repo), **or** upgrade to a paid instance
  and uncomment the `disk:` block in `render.yaml` (mount `/data`). Render injects `PORT`
  automatically; the daemon reads it.
- **The monthly token meter is also on that diskless FS** → without a durable store, every user's
  usage **resets to 0 on each restart/deploy** (they'd get unlimited tokens). Fix it for free by
  persisting usage to **Firestore** — see **"Persist usage (Firestore)"** below.

## Connect GitHub (free per-user project persistence)

When the `GITHUB_OAUTH_*` vars are set, users get an optional **"Connect GitHub"** prompt (before
the first-run tour, and in Settings). Once connected, each user's projects are synced to **their
own** private `neondeck-projects` repo — committed on change, restored on open — so they survive
the diskless wipe. The OAuth token lives in the user's **browser** (re-sent each connect), so it
also survives redeploys; the daemon never persists it. Off entirely when the vars are unset.

1. **Create a GitHub OAuth App:** GitHub → **Settings → Developer settings → OAuth Apps → New OAuth
   App**:
   - Application name: `NeonDeck`
   - Homepage URL: `https://<your-app>.onrender.com`
   - Authorization callback URL: `https://<your-app>.onrender.com/api/github/callback`
     *(also add `http://localhost:5050/api/github/callback` for local dev)*
   - Register → copy the **Client ID**, then **Generate a client secret** and copy it.
2. **Set the env vars in Render** (the service → Environment, both `sync:false`):
   - `GITHUB_OAUTH_CLIENT_ID` = the Client ID
   - `GITHUB_OAUTH_CLIENT_SECRET` = the client secret (daemon-only — never shipped to the browser)
3. **Redeploy.** Users can now connect; their projects sync to `github.com/<user>/neondeck-projects`.

Scope requested is `repo` (projects can be private). Disconnect (in Settings) clears the stored
token. If a GitHub call fails, the IDE keeps working — sync is best-effort.

## Persist usage (Firestore)

The per-user **monthly token meter** lives in a JSON ledger on the diskless FS, so a restart/deploy
wipes it and everyone's usage resets to 0. Point it at **Firestore** (same Firebase project as auth)
so usage survives. One-time setup:

1. **Get a service-account key:** Firebase console → your project (`neondeck-8cbe0`) → **Project
   settings → Service accounts → Generate new private key**. This downloads a JSON file. *(This is a
   server secret — never commit it or ship it to the browser. It is only used for Firestore writes;
   token verification still uses public certs and needs no secret.)*
2. **Set it in Render** (service → Environment, `sync:false`): `FIREBASE_SERVICE_ACCOUNT` = the
   **entire JSON** (paste it as-is, or base64-encode it first if the dashboard mangles newlines).
   Must be the **same project** as `FIREBASE_PROJECT_ID` so uids match.
3. **Redeploy.** On boot the daemon logs `[firestore] usage persistence enabled`. Usage is now stored
   per user in the `neondeck_usage` collection (lazy-loaded on connect, debounced writes, flushed on
   shutdown). No Firestore? It silently falls back to the local ledger.

Tiers already reconcile from Stripe on connect, so paid plans are unaffected; this is specifically
about the **token counter**. (Free, durable, no new vendor — it reuses your existing Firebase project.)

## Admin dashboard & maintenance

Admins (login emails in `ADMIN_EMAILS`) get **Settings → 🛡 Admin**, a live ops dashboard:
- **Active sessions** — every connected user, their open project, whether the agent is running (and
  its step), process count, and how long they've been connected. **Cancel agent** stops a stuck
  run on any session.
- **Maintenance mode** — a toggle that **locks every non-admin out** with a red full-screen notice
  and refuses agent runs (admins keep full access). It flips live (no redeploy) and resets if the
  service restarts — handy for pushing a risky change or pausing usage during a test.
  - **Surviving a restart:** because the live toggle is in-memory, a redeploy clears it. To keep the
    site locked **across** a deploy, set **`MAINTENANCE_MODE=on`** (and optional `MAINTENANCE_MESSAGE`)
    in Render → the daemon boots already locked. To reopen, set it to `off` (or remove it) and
    redeploy. Note: while `MAINTENANCE_MODE=on` is set, every restart re-locks — so turning it off via
    the dashboard is only until the next restart; clear the env var to fully reopen.

Set `ADMIN_EMAILS` in Render (Environment, comma-separated; matched lowercased against the user's
Firebase email). It's **optional** — it defaults to the owner email in code, so the dashboard works
out of the box; set it to add teammates or change the admin. All admin actions are re-checked
server-side, so non-admins can't reach them even if the UI were forced. Single Render instance →
the dashboard sees every connected user.

## Auto-deploy (push → live)

`render.yaml` sets `autoDeploy: true`, so once the repo is connected, **every push to the
deployed branch redeploys automatically** — no manual "Deploy latest commit" needed.

- Already created the service before this change? Flip it in the dashboard too:
  **the service → Settings → Build & Deploy → Auto-Deploy → Yes** (the dashboard value wins
  over the blueprint for an existing service).
- Normal workflow now: `git add -A && git commit -m "…" && git push` → Render builds and
  ships it. Watch progress under the service's **Events / Logs**.

## Stripe (real billing)

The code is already wired end-to-end: real Stripe Checkout, a signature-verified webhook
(`/api/webhooks/stripe`), and downgrade/cancel. **Until you set the keys below, upgrades fall
back to a free simulated "upgrade"** (instant tier grant, no charge) — fine for a demo, but
set these four to take real money:

1. **Create the products/prices** in the Stripe Dashboard (use **Test mode** first):
   Products → add **Pro** ($10/mo recurring) and **Max** ($20/mo recurring). Copy each
   **Price ID** (looks like `price_…`).
2. **Get your secret key:** Developers → API keys → **Secret key** (`sk_test_…`, later
   `sk_live_…`).
3. **Add the webhook:** Developers → Webhooks → **Add endpoint** →
   URL `https://<your-app>.onrender.com/api/webhooks/stripe`. Subscribe to:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy the
   **Signing secret** (`whsec_…`).
4. **Set the env vars in Render** (the service → Environment — all four `sync:false`, so
   they're never committed):
   - `STRIPE_SECRET_KEY` = `sk_…`
   - `STRIPE_PRICE_PRO` = `price_…` (Pro)
   - `STRIPE_PRICE_MAX` = `price_…` (Max)
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…`
5. **Redeploy.** The checkout **return URL is auto-derived** from Render's
   `RENDER_EXTERNAL_URL`, so you don't need `IDE_APP_ORIGIN` unless you serve the app from a
   different host (e.g. a custom domain) — then set `IDE_APP_ORIGIN=https://yourdomain`.

Test it: open the live site → upgrade to Pro → you'll hit Stripe's hosted checkout; pay with
test card `4242 4242 4242 4242` (any future expiry / CVC). The webhook flips the tier in the
ledger. Switch to live keys (`sk_live_…` + a live-mode webhook) when you're ready to charge
real cards.

## Custom domain (is it free?)

**The domain *feature* is free on Render** (custom domains work on the free plan, HTTPS cert
included). What costs money is *owning a domain name*:

- **$0, keep what you have:** the `…onrender.com` URL is already a real HTTPS address — totally
  fine for family/personal use.
- **$0, free subdomain:** services like **`js.org`** (for open-source JS projects, via a PR to
  their GitHub repo) or **`is-a.dev`** give a free subdomain you point at Render. `.tk/.ml`
  (Freenom) free domains are effectively dead now — don't rely on them.
- **~$10/yr, your own domain:** buy from Cloudflare/Namecheap/Porkbun, then in Render: the
  service → **Settings → Custom Domains → Add** → add your domain → create the **CNAME**
  record Render shows at your registrar. Cert provisions automatically in a few minutes.

After adding a custom domain, also: (a) add that host to **Firebase → Authentication →
Authorized domains** (so Google sign-in works); (b) if GitHub sync is on, add
`https://yourdomain/api/github/callback` to your GitHub OAuth App's callback URLs (keep the
onrender one too); and (c) optionally set `IDE_APP_ORIGIN=https://yourdomain` so **Stripe**
checkout returns to the custom domain. GitHub OAuth needs no `IDE_APP_ORIGIN` change — the
callback delivers the token to whatever origin the user is on.

### Cloudflare-registered domain, hosted on Render (step by step)

You buy the name from **Cloudflare** but keep **everything on Render** — Cloudflare is only the
registrar + a DNS pointer, not a second host and not a proxy in front of your app.

1. **Buy the domain** at Cloudflare → **Domain Registration → Register Domains**. Registering
   through Cloudflare automatically puts the domain on Cloudflare's DNS — that's required and
   fine; you'll only use it to point at Render.
2. **Add the domain in Render:** the service → **Settings → Custom Domains → Add Custom Domain**
   → enter your host, e.g. `app.yourdomain.com` (and/or the apex `yourdomain.com`). Render shows
   the DNS target to create (it'll be `neondeck.onrender.com`).
3. **Create the DNS record in Cloudflare** (dash → your domain → **DNS → Records → Add record**):
   - subdomain (e.g. `app`) → **CNAME** → `neondeck.onrender.com`
   - apex (`yourdomain.com`) → **CNAME** → `neondeck.onrender.com` (Cloudflare flattens apex
     CNAMEs automatically, so this is allowed)
   - **Proxy status = DNS only (grey cloud)** so traffic goes straight to Render and **Render
     issues the HTTPS cert**. (Orange-cloud proxy also works, but then set Cloudflare **SSL/TLS
     → Full** to avoid redirect loops. Grey cloud is the no-fuss choice when Render is the host.)
4. **Wait for the cert.** Render auto-provisions HTTPS in a few minutes; the domain row flips to
   **"Certificate Issued"**. Then `https://app.yourdomain.com` serves the whole app.
5. **Whitelist the host for sign-in** (required): Firebase → project **`neondeck-8cbe0`** →
   Authentication → **Settings → Authorized domains → Add domain** → your custom host. Without
   this, Google sign-in fails on the new URL.
6. **(GitHub sync only) Register the new callback URL:** in your GitHub OAuth App add
   `https://app.yourdomain.com/api/github/callback` to the Authorization callback URLs (keep the
   onrender one so both hosts keep working). The browser builds `redirect_uri` from whatever host
   you're on, so the custom-domain callback must be registered or GitHub rejects the redirect.
   *(No `IDE_APP_ORIGIN` change needed — the callback delivers the token to whatever origin the
   user is on.)*
7. **(Optional) Point Stripe at the new host:** in Render → Environment set
   `IDE_APP_ORIGIN=https://app.yourdomain.com` and redeploy, so checkout returns the user to the
   custom domain instead of `…onrender.com`. The Stripe webhook can stay on the onrender.com URL.

**No `IDE_ALLOWED_ORIGINS` needed.** Web + API + WebSocket all come from the one custom-domain
origin, and the daemon auto-trusts same-origin requests (`isSameOrigin` in `daemon/src/server.ts`
matches the request's `Origin` against the served `Host`/`X-Forwarded-Host`). You only add
origins when the web is served from a *different* host than the daemon.

**Cost:** the domain is ≈ **$10/yr** (Cloudflare sells at wholesale, no markup); the Render
custom domain + auto HTTPS cert and Cloudflare DNS are **free**.

## Per-user sandboxing / isolation — what you get

| Layer | Status | Notes |
|---|---|---|
| **Files** | ✅ isolated per user | Each signed-in user gets their own `users/<uid>/` project tree (`auth.ts` `userRoot`); a session is jailed to a project under it — users can't list or open each other's files. |
| **Secrets** | ✅ not leaked | User apps/shells run with a **scrubbed env** — the daemon's secrets (API key, etc.) are stripped before spawning (`executor.ts`), so a project can't read `$AGENT_API_KEY`. |
| **Process / CPU / RAM** | ❌ shared on a PaaS | Without Docker, all users' code runs in the **one** service container (`LOCAL_NODE`). One user can hog CPU/RAM or crash the shared box. **Safe for family/trusted users; not for untrusted strangers.** |

**Getting *full* per-user isolation:** the code already runs each command in a **hardened
container** when Docker is available (`docker.ts`: `--cap-drop=ALL`, non-root, 256MB / 0.5
vCPU / pid limits, read-only rootfs, isolated network) and auto-selects it
(`executor.ts` `detectMode`). Render (free *or* paid) can't run Docker-in-Docker, so it
tops out at the table above. To get true process/resource isolation, run the **same image**
on a **Docker-capable host** — e.g. an **Oracle Cloud Always-Free VM** with Docker
installed; the daemon then sandboxes every run automatically.

## Local sanity check (acts like the PaaS, one port)
```bash
npm run build
IDE_WEB_DIR=web/dist PORT=8080 IDE_PROJECTS_ROOT=/tmp/nd-projects \
  IDE_TRUST_LOOPBACK=1 IDE_DAEMON_HOST=127.0.0.1 node daemon/dist/index.js
# open http://localhost:8080  → web, /api/health, and Run → previews all on 8080
```
Local *development* is unchanged: `npm run dev:daemon` + `npm run dev:web` (:5050 / :5173).

## Other platforms (same Dockerfile)
- **Fly.io** — works, but no longer has a free always-on tier. Add a `fly.toml` (single
  internal port + a `[[mounts]]` volume at `/data`) and `fly deploy`.
- **Railway** — auto-detects the Dockerfile; add a Volume at `/data`; set the env vars.
  (Trial credit, then paid.)
- **A VM (Oracle Cloud Always-Free, etc.)** — the only way to get Docker-backed per-user
  isolation *and* persistence for free. Run the image with `-v /data:/data` and Docker
  available on the host.
