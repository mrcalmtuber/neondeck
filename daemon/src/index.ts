#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer, flushAllSessions } from "./server.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Load secrets from the nearest `.env` BEFORE config reads process.env. Walks up
 * from the working dir (npm runs workspace scripts with cwd=daemon/, so the repo
 * root `.env` is one level up). Uses Node's built-in env-file loader — no dotenv
 * dependency. The file is gitignored, so secrets never get committed.
 */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        console.log(`[daemon] loaded secrets from ${candidate}`);
      } catch (err) {
        console.warn(`[daemon] failed to load ${candidate}:`, (err as Error).message);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
}
loadDotEnv();

/**
 * CLI entry point for the local agent bridge.
 *
 *   npx ide-daemon --workspace ~/my-project
 *   ide-daemon --workspace ~/my-project --origin https://app.your-ide-domain.com
 *
 *   # Headless production node (Raspberry Pi 5), reachable by external users:
 *   ide-daemon --root ~/neondeck-projects --host 0.0.0.0 --port 5000 \
 *     --origin https://app.neondeck.io
 *
 * Runs in the foreground. The bind host/port come from config (default
 * 0.0.0.0:5000); pass --host 127.0.0.1 for loopback-only local development.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));

  if (!fs.existsSync(config.projectsRoot)) {
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    console.log(`[daemon] created projects root: ${config.projectsRoot}`);
  }

  const wss = await startServer(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[daemon] shutting down…");
    // Push every open project to GitHub before the (diskless) box goes away.
    await flushAllSessions(config).catch(() => {});
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // never hang on lingering sockets
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
