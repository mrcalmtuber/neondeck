import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Hardened sandbox flags applied to EVERY container this daemon spawns.
 *
 * These implement the privilege-dropper guardrails:
 *   --cap-drop=ALL        drop every Linux kernel capability
 *   --user=1000:1000      never run as root inside the container
 *   --security-opt        block privilege escalation (setuid binaries can't regain caps)
 *   --memory / --cpus     hard cgroup limits: 256MB RAM, 0.5 vCPU
 *   --pids-limit          cap process count to stop fork bombs
 *   --read-only           root filesystem is immutable
 *   --network             see runContainer note
 *
 * The ONLY writable surface is the explicit project volume mounted below,
 * plus a small tmpfs for /tmp (read-only rootfs breaks most tooling otherwise).
 */
export const SANDBOX_FLAGS = [
  "--cap-drop=ALL",
  "--user=1000:1000",
  "--security-opt=no-new-privileges",
  "--memory=256m",
  "--memory-swap=256m", // disallow swap escape past the RAM cap
  "--cpus=0.5",
  "--pids-limit=256",
  "--read-only",
  "--tmpfs=/tmp:rw,size=64m,mode=1777",
];

export interface SpawnContainerOpts {
  image: string;
  /** Absolute host path mounted read-write at /workspace (the project dir). */
  workspaceDir: string;
  /** Command executed via `sh -c`. */
  command: string;
  /** Extra `docker run` flags (e.g. published ports). */
  extraFlags?: string[];
  /** If set, container is named so it can be addressed/stopped later. */
  name?: string;
  /** Run detached (-d) instead of streaming in the foreground. */
  detached?: boolean;
}

/**
 * Builds the full `docker run` argument vector. Kept pure so it can be
 * unit-tested without touching Docker.
 */
export function buildRunArgs(opts: SpawnContainerOpts): string[] {
  const args = ["run", "--rm", "-i"];
  if (opts.detached) args.push("-d");
  if (opts.name) args.push("--name", opts.name);

  args.push(...SANDBOX_FLAGS);

  // The single writable mount: the user's project directory.
  args.push("--volume", `${opts.workspaceDir}:/workspace:rw`);
  args.push("--workdir", "/workspace");

  if (opts.extraFlags) args.push(...opts.extraFlags);

  args.push(opts.image, "sh", "-c", opts.command);
  return args;
}

/**
 * Spawn a container in the foreground and return the live child process.
 * Caller wires up stdout/stderr/exit. We pass an argv array to `spawn`
 * (never a shell string) so the AI-supplied command can't break out of the
 * `sh -c` argument into the host shell.
 */
export function runContainer(opts: SpawnContainerOpts): ChildProcessWithoutNullStreams {
  const args = buildRunArgs(opts);
  return spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
}

/** Force-stop and remove a named container. Used by the Stop Agent button. */
export function stopContainer(name: string): void {
  const p = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
  // Swallow spawn failures (e.g. docker not installed). Without this handler a
  // failed cleanup spawn emits an unhandled 'error' event and crashes the daemon.
  p.on("error", () => {});
}

/**
 * Resolves true if the `docker` CLI is invocable. Lets the daemon return a
 * clean error to the UI instead of crashing when Docker isn't installed.
 */
export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    // Single settle: a timeout, an error, or close — whichever comes first wins,
    // so a hung `docker` CLI can never stall the hello handshake that awaits this.
    const settle = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
      settle(false);
    }, 3000);
    p.on("error", () => settle(false));
    p.on("close", (code) => settle(code === 0));
  });
}
