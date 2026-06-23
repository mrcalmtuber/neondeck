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

3. **Set the secrets / per-deploy values** (Dashboard → the service → Environment):
   - `AGENT_API_KEY` — your DeepSeek key (stays server-side, never shipped to the browser)
   - `FIREBASE_PROJECT_ID` — e.g. `neondeck-production` (so the handshake requires a real
     Firebase ID token; **don't** leave auth off on a public URL)
   - `IDE_APP_ORIGIN` and `IDE_ALLOWED_ORIGINS` — your service URL,
     `https://<name>.onrender.com` (set after the first deploy reveals the name)

4. **Deploy.** Then **add `<name>.onrender.com` to Firebase → Authentication → Authorized
   domains** (Google sign-in needs the domain whitelisted on HTTPS).

5. Open **https://<name>.onrender.com**. The web auto-connects to the daemon same-origin
   (no build config needed); previews render through the same URL.

### ⚠ Render free-tier limits (important)
- **Sleeps after ~15 min idle** → the next visit cold-starts (~30–60s) and any running
  preview dev server is killed. Fine for occasional family use; annoying for always-on.
- **No persistent disk on free** → user projects (`IDE_PROJECTS_ROOT=/data/projects`) are
  **wiped on every restart/sleep/deploy**. To keep projects, upgrade to a paid instance and
  uncomment the `disk:` block in `render.yaml` (mount `/data`). Render injects `PORT`
  automatically; the daemon reads it.

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
