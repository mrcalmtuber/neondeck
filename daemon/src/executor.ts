import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeMode } from "@ide/shared";
import { runContainer, dockerAvailable, stopContainer } from "./docker.js";

/**
 * Runtime cascade executor.
 *
 *  LEVEL 1 — DOCKER:     hardened sandboxed container (see docker.ts flags).
 *  LEVEL 2 — LOCAL_NODE: native child_process.spawn on the host, cwd=workspace.
 *  LEVEL 3 — BROWSER:    handled entirely in the frontend; never reaches here.
 *
 * `detectMode` picks the most isolated backend the host can actually provide.
 */
export async function detectMode(forced: RuntimeMode | "auto"): Promise<RuntimeMode> {
  if (forced !== "auto") return forced;
  return (await dockerAvailable()) ? "DOCKER" : "LOCAL_NODE";
}

/**
 * Env var NAMES whose values must never reach a user's app / shell — the daemon's
 * own secrets. In LOCAL_NODE mode children share the daemon's process, so without
 * this a user could read e.g. `$AGENT_API_KEY` from inside their project. (Docker
 * mode already passes NO host env, so it's clean.) Matched case-insensitively.
 */
const SECRET_ENV_PATTERN = /(API_KEY|_KEY$|_SECRET|SECRET|TOKEN|PASSWORD|STRIPE|FIREBASE|DEEPSEEK|AGENT_API)/i;

/** Host env minus the daemon's secrets — keeps PATH/HOME/etc. so npm/node still work. */
function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_ENV_PATTERN.test(k)) out[k] = v;
  }
  return out;
}

export interface ExecOpts {
  mode: RuntimeMode;
  workspaceDir: string;
  command: string;
  image: string;
  /** Optional container name (Docker mode) so it can be addressed/stopped. */
  name?: string;
  /** Published app port (Docker mode); native mode binds the host directly. */
  appPort?: number;
}

export interface ExecHandle {
  child: ChildProcessWithoutNullStreams;
  /** Force-terminate this process (and its container, in Docker mode). */
  kill: () => void;
}

/**
 * Spawn the command in the requested runtime and return the live process plus
 * a uniform killer. The caller wires stdout/stderr/exit.
 */
export function exec(opts: ExecOpts): ExecHandle {
  if (opts.mode === "DOCKER") {
    const child = runContainer({
      image: opts.image,
      workspaceDir: opts.workspaceDir,
      command: opts.command,
      name: opts.name,
      extraFlags:
        opts.appPort != null ? ["-p", `127.0.0.1:${opts.appPort}:${opts.appPort}`] : undefined,
    });
    return {
      child,
      kill: () => {
        child.kill("SIGKILL");
        if (opts.name) stopContainer(opts.name);
      },
    };
  }

  // LOCAL_NODE: run directly on the host OS inside the workspace directory.
  // No `shell: true` — the argv form keeps the AI/user command contained to
  // the `sh -c` argument rather than the daemon's own shell. The env is scrubbed
  // of the daemon's secrets so a user's app/shell can't read them.
  const child = spawn("sh", ["-c", opts.command], {
    cwd: opts.workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizedChildEnv(),
  }) as ChildProcessWithoutNullStreams;

  return { child, kill: () => child.kill("SIGKILL") };
}
