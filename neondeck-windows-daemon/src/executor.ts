import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeMode } from "./shared/protocol.js";
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
  //
  // Windows compatibility: there is no `sh` on a default Windows install, so we
  // can't use the POSIX `sh -c <command>` argv form. On Windows we hand the raw
  // command string to the platform shell (cmd.exe) via `{ shell: true }`, which
  // also lets toolchain/compiler binaries (npm, tsc, vite, python, gcc, …) and
  // their `.cmd`/`.bat` shims resolve from PATH the way they do in a terminal.
  // On POSIX we keep the original `sh -c` argv form so the AI/user command stays
  // contained to the shell argument rather than the daemon's own process args.
  const isWindows = process.platform === "win32";
  const child = (
    isWindows
      ? spawn(opts.command, {
          cwd: opts.workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
          shell: true, // route through cmd.exe so compilers/build tools resolve
        })
      : spawn("sh", ["-c", opts.command], {
          cwd: opts.workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        })
  ) as ChildProcessWithoutNullStreams;

  return { child, kill: () => child.kill("SIGKILL") };
}
