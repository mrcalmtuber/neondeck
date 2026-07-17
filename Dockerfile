# Kryct — single-image deploy: one process serves the whole platform on ONE port.
#
# Build:  docker build -t kryct .
# Run:    docker run -p 8080:8080 -e PORT=8080 -e FIREBASE_PROJECT_ID=... \
#                 -e AGENT_API_KEY=... -v kryct-data:/data kryct

# ---- builder ----
# Node 24+ is REQUIRED at runtime (the runtime uses the built-in `node:sqlite`,
# available on Node 22.5+ and flagless on 24+; older Node builds but crashes on boot).
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
