# NeonDeck

> ## ▶ Try it live — **[neondeck.onrender.com](https://neondeck.onrender.com)**

[![Live](https://img.shields.io/badge/live-neondeck.onrender.com-ff007f)](https://neondeck.onrender.com)
[![License](https://img.shields.io/badge/license-Proprietary-red)](./LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646cff?logo=vite&logoColor=white)
![Deploy](https://img.shields.io/badge/deploy-Render-46e3b7?logo=render&logoColor=white)

A hybrid web IDE. The UI runs as a normal website; code, files, and Docker
containers execute on the **daemon** node — your own machine for local dev, or a
cloud host for a shared production deployment (it ships as a single Docker
service — see [DEPLOY.md](./DEPLOY.md)). The browser talks to the daemon over a
single WebSocket bridge.

## Architecture

```
┌─────────────────────── Browser (website) ───────────────────────┐
│  3-panel IDE: Agent sidebar | Live Preview ⇄ Code | File Tree   │
│                                                                  │
│  Agent sidebar ──prompt──┐  (no provider key in the browser)     │
└──────────────────────────┼───────────────────────────────────────┘
                           │ ws://<node>:5000  (default 0.0.0.0:5000)
┌──────────────────────────▼────────────────────────────────────────┐
│  NeonDeck Daemon (@ide/daemon)                                    │
│   • origin-checked WS server + REST API (host/port configurable)  │
│   • central agent proxy: attaches the server provider key,        │
│     streams the model loop + tool calls (key never leaves here)   │
│   • file read/write jailed to the workspace dir                   │
│   • child_process → `docker run` with hardened sandbox flags      │
└───────────────────────────────────────────────────────────────────┘
```

| Module | Location | Purpose |
| --- | --- | --- |
| Shared protocol | `shared/src/protocol.ts` | Typed message contract for the WS bridge |
| Daemon | `daemon/src/*` | WS server + REST API + central agent proxy + Docker orchestration |
| Web frontend | `web/src/*` | React three-panel IDE |

## What is and isn't private

- **Stays on the daemon node:** all files, the editor workspace, every Docker
  container, **and the agent provider API key** (read from the daemon's env;
  never serialized to the browser).
- **Leaves the node:** only the prompts + code context the agent sends to the
  configured model endpoint. The browser sends prompt text to the daemon; the
  daemon attaches the key and calls the model.

> When the daemon is bound to a public interface it is a real server that sees
> the workspace of every connected user. Don't describe it as "100% private /
> nothing leaves your machine" in that mode — gate it behind Firebase auth.

## Sandbox guardrails (`daemon/src/docker.ts`)

Every container is spawned with:

```
--cap-drop=ALL --user=1000:1000 --security-opt=no-new-privileges
--memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=256
--read-only --tmpfs=/tmp:...   --volume <workspace>:/workspace:rw
```

Only the project directory is writable; the root filesystem is read-only; the
container runs unprivileged with hard CPU/RAM limits. The published app port is
bound to `127.0.0.1` only.

## Run it

```bash
npm install            # installs all workspaces

# 1) Start the agent against a projects folder (loopback-only for local dev)
npm run daemon -- --root ~/neondeck-projects \
  --host 127.0.0.1 --origin http://localhost:5173

# 2) Start the website
npm run dev:web        # http://localhost:5173
```

The agent provider key lives only in the daemon's env (`DEEPSEEK_API_KEY` /
`AGENT_API_KEY`); the browser sidebar streams through the daemon and never sees
it. Open the site, sign in with Firebase email/password (or create an account),
then drive the agent.

### Deploy to production

NeonDeck ships as a **single Docker service** — one process serves the web app,
REST API, WebSocket, and live previews on one port (same-origin, so no separate
web build or origin allow-list is needed). The supported path is **Render's free
tier**; see **[DEPLOY.md](./DEPLOY.md)** for the full runbook (one service,
auto-deploy on push, optional Stripe billing, optional per-user GitHub project
sync, and custom domains).

## ⚠️ Verify before shipping

- **Agent model:** the built-in default `deepseek-v4-flash` is the spec's literal
  id but is **not** a model the real DeepSeek API serves — live calls 400 until
  you set `AGENT_MODEL` (e.g. `deepseek-chat` / `deepseek-reasoner`) and a valid
  `AGENT_BASE_URL`.
- **Exposing the daemon:** binding `--host 0.0.0.0` makes the node reachable by
  external users — and the daemon runs containers / native shells. Before
  internet exposure: set `FIREBASE_PROJECT_ID` (so the handshake requires a valid
  Firebase ID token), set `IDE_ALLOWED_ORIGINS` to your real domain, keep
  `IDE_ALLOW_ALL_ORIGINS` off, and firewall the port. The `Origin` header is one
  layer, not complete auth.
- **Firebase config:** the web app config is hardcoded in
  `web/src/lib/firebaseClient.ts` (Firebase web keys are public by design).
  Override via `VITE_FIREBASE_*`. The daemon verifies ID tokens against Google's
  public certs — no service-account secret required.
- **Billing:** Stripe is optional. Without `STRIPE_SECRET_KEY` a mock Stripe is
  used and upgrades are simulated locally, so billing never blocks the workspace.
```
