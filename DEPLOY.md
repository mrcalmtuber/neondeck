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
  **wiped on every restart/sleep/deploy**. To keep projects, upgrade to a paid instance and
  uncomment the `disk:` block in `render.yaml` (mount `/data`). Render injects `PORT`
  automatically; the daemon reads it.

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
Authorized domains** (so Google sign-in works), and (b) if it differs from the onrender host,
set `IDE_APP_ORIGIN=https://yourdomain` so Stripe returns to the right place.

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
