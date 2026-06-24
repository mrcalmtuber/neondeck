# NeonDeck — single-image deploy: one process serves the web SPA, the API, the
# WebSocket, and the live-preview gateway on ONE port (see daemon/src/server.ts).
#
# Build:  docker build -t neondeck .
# Run:    docker run -p 8080:8080 -e PORT=8080 -e FIREBASE_PROJECT_ID=... \
#                 -e AGENT_API_KEY=... -v nd-data:/data neondeck

# ---- builder: install deps + build shared, daemon, and web ----
# Node 24+ is REQUIRED at runtime: the daemon imports the built-in `node:sqlite`
# (db.ts), which only exists on Node 22.5+ and is flagless on 24+. Node 20 builds
# fine (types are shimmed) but crashes on boot.
FROM node:24 AS builder
WORKDIR /app
# Copy the whole monorepo (node_modules/.env/dist excluded via .dockerignore).
COPY . .
RUN npm install
# Builds @ide/shared -> daemon/dist -> web/dist (see root package.json "build").
RUN npm run build

# ---- runtime: Node + git + npm (user projects run via npm in LOCAL_NODE mode) ----
FROM node:24-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Bring the built workspaces + node_modules (incl. the @ide/shared workspace link).
COPY --from=builder /app /app

ENV NODE_ENV=production \
    IDE_DAEMON_HOST=0.0.0.0 \
    IDE_WEB_DIR=/app/web/dist \
    IDE_PROJECTS_ROOT=/data/projects \
    PORT=8080

# Projects live on the mounted volume so they survive redeploys/restarts.
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "daemon/dist/index.js"]
