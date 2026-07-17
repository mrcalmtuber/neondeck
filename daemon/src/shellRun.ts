import { randomUUID } from "node:crypto";
import type { ServerMessage, RuntimeMode } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { ProcRegistry } from "./procs.js";
import { exec } from "./executor.js";
import { redactError } from "./redact.js";

/**
 * Hard ceiling on the captured output buffer (H5). A command like `yes` or
 * `cat /dev/zero` in LOCAL_NODE emits output forever; without a cap `combined`
 * grows until the daemon OOMs. We keep only the most-recent slice — the agent
 * already looks at the tail (output.slice(-8000)) and a human scrolling the
 * terminal cares about the end too. Chunks still stream live to the terminal;
 * only the retained copy is bounded.
 */
const MAX_CAPTURE_BYTES = 256 * 1024;

/** Append to a rolling buffer, trimming the front so it never exceeds the cap. */
function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
}

/**
 * Headless "run a command and capture its output" used by the agent — both the
 * WS session path (server.ts runShell delegates here) and the public-API run
 * path (apiRuns.ts), which has no Session. The dev-server timeout logic is the
 * whole reason this lives in one place: an agent awaiting a command that never
 * exits (vite, npm run dev, watchers…) would hang forever, so server-style
 * commands get a 10s startup window and everything else a 300s ceiling.
 */

export interface ExecCaptureCtx {
  runtimeMode: RuntimeMode;
  procs: ProcRegistry;
  /** id -> killer map the owner uses to tear down leftovers. */
  running: Map<string, () => void>;
  config: DaemonConfig;
  send: (m: ServerMessage) => void;
}

export function execCapture(
  command: string,
  agentId: string,
  workspaceDir: string,
  ctx: ExecCaptureCtx,
): Promise<{ output: string; exitCode: number | null }> {
  const { config, procs, running, send } = ctx;
  return new Promise((resolve) => {
    const procId = `${agentId}:${randomUUID().slice(0, 6)}`;
    let combined = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    send({ type: "terminal_output", id: agentId, stream: "stdout", data: `\r\n$ ${command}\r\n` });

    const handle = exec({ mode: ctx.runtimeMode, workspaceDir, command, image: config.defaultImage, network: config.containerNetwork });
    procs.add(
      {
        id: procId,
        label: "Agent command",
        command,
        pid: handle.child.pid ?? null,
        port: null,
        runtime: ctx.runtimeMode,
        ramKB: null,
        startedAtMs: Date.now(),
      },
      handle.kill,
    );
    running.set(procId, handle.kill);
    send({ type: "processes", id: "broadcast", processes: procs.list() });

    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(procId);
      procs.remove(procId);
      send({ type: "processes", id: "broadcast", processes: procs.list() });
      resolve({ output: combined, exitCode });
    };

    // The agent loop AWAITS this promise, so a command that never exits — a dev
    // server (`npm run dev`, `vite`…) or a file watcher — would hang the whole
    // agent ("stuck on step N"). Guard it: server-style commands get a short
    // startup window (capture the boot output, then hand control back); everything
    // else gets a hard ceiling. Both kill the process so it can't squat the box.
    const isServer =
      /\b(npm (run )?(dev|start)|yarn (dev|start)|pnpm (dev|start)|vite|next (dev|start)|nuxt dev|react-scripts start|nodemon|flask run|uvicorn|gunicorn|python -m http\.server|http-server|serve|rails server|php -S)\b/i.test(
        command,
      ) || /\bnode\b[^|&;]*\bserver\b/i.test(command);
    const limitMs = isServer ? 10_000 : 300_000;
    timer = setTimeout(() => {
      const note = isServer
        ? `[kryct] The server is up and running. It doesn't exit on its own, so it was stopped here — the user previews the app with the Run button, not the agent. Do NOT re-run blocking server commands; continue the task.`
        : `[kryct] Command exceeded ${Math.round(limitMs / 1000)}s with no exit and was stopped. Avoid running long-lived processes from the agent.`;
      combined = appendCapped(combined, `\n${note}`);
      send({ type: "terminal_output", id: agentId, stream: "stdout", data: `\r\n${note}\r\n` });
      handle.kill();
      finish(isServer ? 0 : null);
    }, limitMs);

    handle.child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      combined = appendCapped(combined, s);
      send({ type: "terminal_output", id: agentId, stream: "stdout", data: s });
    });
    handle.child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      combined = appendCapped(combined, s);
      send({ type: "terminal_output", id: agentId, stream: "stderr", data: s });
    });
    handle.child.on("error", (err) => finishWith(err));
    handle.child.on("close", (code) => finish(code));

    function finishWith(err: unknown) {
      combined = appendCapped(combined, `spawn error: ${redactError(err)}`);
      finish(1);
    }
  });
}
