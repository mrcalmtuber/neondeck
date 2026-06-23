# NeonDeck Windows Daemon

A **self-contained, Windows-compatible** build of the NeonDeck backend daemon,
split out of the monorepo into a single isolated package.

It bundles the backend app (WebSocket bridge + HTTP `/api` server on one port),
the runtime code-execution engine (Docker / native host cascade), the DeepSeek
AI logic (inline explain/fix + the agent loop), and the Stripe checkout +
webhook handlers.

## What's included

- `src/` — the full daemon source (server, executor, docker, agent, ai,
  billing, httpApi, usage, projects, workspace, git, tunnel, proxy, auth, db, …).
- `src/shared/` — **vendored** `@ide/shared` protocol + tier definitions. In the
  monorepo this was a separate workspace package (`@ide/shared`); here it lives
  inside `src/` so the folder builds and runs with no workspace symlinks.
- `package.json`, `tsconfig.json`, `.env.example`.

## Requirements

- **Node.js >= 22.5.0** — the SQLite explorer uses the built-in `node:sqlite`
  module (stable on 22.5+), and the `.env` loader uses `process.loadEnvFile`.

## Setup (Windows / PowerShell or CMD)

```sh
npm install
copy .env.example .env      # then edit .env (PowerShell: cp .env.example .env)
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
# or, for live-reload development:
npm run dev
```

## Windows-compatibility changes vs. the macOS/Linux original

1. **Execution engine (`src/executor.ts`).** Native (`LOCAL_NODE`) command
   execution previously used the POSIX-only `spawn("sh", ["-c", command])`.
   Windows has no `sh`, so on `process.platform === "win32"` the command now runs
   through the platform shell with `{ shell: true }` (cmd.exe). This lets
   compilers/build tools (`npm`, `tsc`, `vite`, `python`, `gcc`, …) and their
   `.cmd`/`.bat` shims resolve from `PATH`. POSIX behavior is unchanged.

2. **Vendored `@ide/shared`.** Imports of `@ide/shared` were repointed to the
   local `./shared/protocol.js` so there is exactly one package, one
   `npm install`, and one `tsc` build — no monorepo required.

## Notes / not changed (intentionally)

- **Filesystem paths were already cross-platform.** All host-path construction
  already uses `path.join` / `path.resolve` / `path.dirname` / `path.sep`
  (`workspace.ts`, `projects.ts`, `usage.ts`, `config.ts`, `index.ts`). The
  remaining ``${x}/y`` strings are **URLs** (Stripe return URLs) and **in-container
  Linux paths** (`/workspace`) — running `path.join()` on those would corrupt
  them, so they were left as-is.
- **RAM sampling (`procs.ts`)** already short-circuits on Windows (`ps` is
  POSIX-only) and returns `null` there.
- **Docker** is optional. The `docker run` calls use argv spawns and Docker
  Desktop resolves `docker.exe` from `PATH`; if you mount Windows project paths
  into Linux containers, ensure the drive is shared in Docker Desktop settings.
