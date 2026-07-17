import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizedChildEnv } from "./executor.js";

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
 *   --network             egress policy, passed per-run (see buildRunArgs / config
 *                         IDE_CONTAINER_NETWORK). Default "bridge"; set "none" to
 *                         cut all outbound access (data-exfil / SSRF / mining).
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
  /** Docker `--network` mode (e.g. "bridge", "none"). Controls egress. */
  network?: string;
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

  // Egress policy (default bridge; "none" = air-gapped). Explicit per-run so it's
  // never accidentally the Docker default with no restriction.
  args.push(`--network=${opts.network || "bridge"}`);

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
  // C4: pass a scrubbed env to the `docker` CLI process. Containers themselves
  // already get NO host env (the sandbox design), but the CLI process inherits
  // whatever we give it — no reason for it to carry the daemon's secrets in its
  // own /proc/<pid>/environ. sanitizedChildEnv keeps PATH + DOCKER_HOST/DOCKER_*
  // (none match the secret pattern) so the CLI still reaches the daemon.
  return spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: sanitizedChildEnv() });
}

/** Force-stop and remove a named container. Used by the Stop Agent button. */
export function stopContainer(name: string): void {
  const p = spawn("docker", ["rm", "-f", name], { stdio: "ignore", env: sanitizedChildEnv() });
  // Swallow spawn failures (e.g. docker not installed). Without this handler a
  // failed cleanup spawn emits an unhandled 'error' event and crashes the daemon.
  p.on("error", () => {});
}

/**
 * Best-effort reaper (M5): remove leftover Kryct sandbox containers from a
 * previous run. A crashed/killed daemon can't run its own per-session cleanup, so
 * `ide-dev-*` containers can linger and squat resources. The name-prefix filter
 * guarantees it only ever touches our own containers. Runs once at startup.
 */
export function reapOrphanContainers(): void {
  // `$(…)` empty when there are none → `docker rm -f` no-ops via `|| true`.
  const p = spawn(
    "sh",
    ["-c", "docker rm -f $(docker ps -aq --filter name=ide-dev-) 2>/dev/null || true"],
    { stdio: "ignore", env: sanitizedChildEnv() },
  );
  p.on("error", () => {});
}

/**
 * Resolves true if the `docker` CLI is invocable. Lets the daemon return a
 * clean error to the UI instead of crashing when Docker isn't installed.
 *
 * Cached for a short TTL (L6): this is polled on every hello + run, and spawning
 * `docker version` each time is wasteful. Docker rarely appears/disappears within
 * a running daemon, so a 30s cache is safe.
 */
let dockerCache: { ok: boolean; at: number } | null = null;
const DOCKER_CACHE_TTL_MS = 30_000;

export function dockerAvailable(): Promise<boolean> {
  if (dockerCache && Date.now() - dockerCache.at < DOCKER_CACHE_TTL_MS) {
    return Promise.resolve(dockerCache.ok);
  }
  return checkDocker().then((ok) => {
    dockerCache = { ok, at: Date.now() };
    return ok;
  });
}

function checkDocker(): Promise<boolean> {
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
      env: sanitizedChildEnv(),
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
