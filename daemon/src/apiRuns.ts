import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  apiCostUsd,
  canUseDaemonExecution,
  clampEffortForTier,
  effortForTier,
  type AgentEffort,
  type ServerMessage,
  type Tier,
} from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";
import type { DevStore } from "./devProgram.js";
import { runAgent, newAgentState, type AgentState } from "./agent.js";
import { ProcRegistry } from "./procs.js";
import { execCapture } from "./shellRun.js";
import { detectMode } from "./executor.js";
import { userRoot, userStorageKey } from "./auth.js";
import { resolveProject, projectExists, listProjects } from "./projects.js";
import {
  snapshotEnabled,
  snapshotProject,
  restoreProject,
  listSnapshotProjects,
} from "./firestoreFs.js";
import { reportApiUsage } from "./billing.js";

/**
 * Public-API agent runs (`/api/v1/runs`) — the session-less adapter around
 * runAgent. Each run fabricates the context a WS session normally provides:
 * the project workspace (restored from a Firestore snapshot after a diskless
 * wipe — API callers hold no GitHub token), a no-limit meter that accumulates
 * RAW input/output tokens for Stripe metered billing, and a `send` that
 * appends to an in-memory event log (replayed to pollers and SSE streams).
 *
 * Runs live in MEMORY ONLY: if the host sleeps or redeploys mid-run the run
 * dies and its id 404s after restart. Tokens burned before completion are NOT
 * billed (the meter events fire once, at run end) — under-billing, never over.
 */

/** An error with the HTTP status the API route should answer with. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RunEvent {
  t: number;
  type: "status" | "delta" | "tool" | "terminal" | "done" | "error";
  text: string;
}

interface RunRecord {
  runId: string;
  userId: string;
  keyId: string;
  project: string;
  status: "running" | "completed" | "stopped" | "error";
  createdAt: number;
  finishedAt?: number;
  inputTokens: number;
  outputTokens: number;
  events: RunEvent[];
  eventBytes: number;
  /** Best-effort: base filenames from write_to_file tool summaries. */
  filesChanged: Set<string>;
  doneReason: string | null;
  state: AgentState;
  procs: ProcRegistry;
  running: Map<string, () => void>;
  sse: Set<ServerResponse>;
}

const MAX_EVENTS = 2000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_GLOBAL_ACTIVE = 3;
const FINISHED_TTL_MS = 30 * 60_000;
const MAX_RECORDS = 200;
const MAX_PROMPT_CHARS = 32_000;

export function createApiRunManager(config: DaemonConfig, store: UsageStore, devStore: DevStore) {
  const runs = new Map<string, RunRecord>();
  const activeByUser = new Map<string, string>();

  function activeCount(): number {
    let n = 0;
    for (const r of runs.values()) if (r.status === "running") n++;
    return n;
  }

  /** JSON view returned by POST /runs and GET /runs/:id. */
  function toPublic(run: RunRecord) {
    return {
      runId: run.runId,
      project: run.project,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        estimatedCostUsd: apiCostUsd(run.inputTokens, run.outputTokens),
      },
      events: run.events,
      filesChanged: [...run.filesChanged],
    };
  }

  function appendEvent(run: RunRecord, m: ServerMessage): void {
    const ev = mapEvent(m);
    if (!ev) return;
    run.events.push(ev);
    run.eventBytes += ev.text.length;
    while (run.events.length > MAX_EVENTS || run.eventBytes > MAX_EVENT_BYTES) {
      const dropped = run.events.shift();
      if (!dropped) break;
      run.eventBytes -= dropped.text.length;
    }
    if (m.type === "agent_tool" && m.toolName === "write_to_file") {
      // The summary ends with the touched file's base name ("… — App.tsx").
      const base = m.summary.split("—").pop()?.trim();
      if (base) run.filesChanged.add(base);
    }
    for (const res of run.sse) {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        run.sse.delete(res);
      }
    }
  }

  function mapEvent(m: ServerMessage): RunEvent | null {
    const t = Date.now();
    switch (m.type) {
      case "agent_status":
        return { t, type: "status", text: m.status };
      case "agent_delta":
        return { t, type: "delta", text: m.text };
      case "agent_tool":
        return { t, type: "tool", text: `${m.toolName}: ${m.summary}` };
      case "terminal_output":
        return { t, type: "terminal", text: m.data };
      case "agent_done":
        return { t, type: "done", text: m.reason };
      case "error":
        return { t, type: "error", text: m.message };
      default:
        return null; // usage_update / processes / approval — not part of the log
    }
  }

  function endSse(run: RunRecord): void {
    for (const res of run.sse) {
      try {
        res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
        res.end();
      } catch {
        /* already gone */
      }
    }
    run.sse.clear();
  }

  function prune(): void {
    if (runs.size <= MAX_RECORDS) return;
    const finished = [...runs.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const r of finished) {
      if (runs.size <= MAX_RECORDS) break;
      runs.delete(r.runId);
    }
  }

  async function createRun(
    userId: string,
    keyId: string,
    opts: { project: string; prompt: string; effort?: AgentEffort },
  ): Promise<ReturnType<typeof toPublic>> {
    if (!opts.project || typeof opts.project !== "string") {
      throw new ApiError(400, "`project` is required.");
    }
    if (!opts.prompt || typeof opts.prompt !== "string") {
      throw new ApiError(400, "`prompt` is required.");
    }
    if (opts.prompt.length > MAX_PROMPT_CHARS) {
      throw new ApiError(413, `Prompt too large (max ${MAX_PROMPT_CHARS} chars).`);
    }
    if (activeByUser.has(userId)) {
      throw new ApiError(409, "You already have a run in progress. Wait for it or cancel it.");
    }
    if (activeCount() >= MAX_GLOBAL_ACTIVE) {
      throw new ApiError(503, "The server is at capacity for API runs. Retry shortly.");
    }

    // Fabricate the per-tenant identity the WS path gets from its session. Only
    // userId + mode matter for the FS jail (see userRoot/userStorageKey).
    const identity = { userId, email: null, emailVerified: true, mode: "firebase" as const };
    const root = userRoot(config, identity);
    let dir: string;
    try {
      dir = resolveProject(root, opts.project);
    } catch {
      throw new ApiError(400, "Invalid project name.");
    }
    if (!projectExists(root, opts.project)) {
      // Diskless wipe? Restore the durable snapshot (API callers have no GitHub
      // token — it's browser-held — so Firestore is the only durable copy here).
      const restored = await restoreProject(config, userStorageKey(identity), opts.project, dir);
      if (!restored || !projectExists(root, opts.project)) {
        throw new ApiError(404, `Project "${opts.project}" not found.`);
      }
    }

    const tier = store.tierFor(userId) as Tier;
    const runtimeMode = await detectMode("auto");
    // Same execution gates as the IDE: Free writes files but can't run shell
    // commands; IDE_REQUIRE_SANDBOX refuses Docker-less execution (C2).
    const canRunCommands =
      canUseDaemonExecution(tier) && (!config.requireSandbox || runtimeMode === "DOCKER");
    const effort = clampEffortForTier(tier, opts.effort ?? effortForTier(tier));

    const run: RunRecord = {
      runId: `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      userId,
      keyId,
      project: opts.project,
      status: "running",
      createdAt: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      events: [],
      eventBytes: 0,
      filesChanged: new Set(),
      doneReason: null,
      state: newAgentState(),
      procs: new ProcRegistry(),
      running: new Map(),
      sse: new Set(),
    };
    runs.set(run.runId, run);
    activeByUser.set(userId, run.runId);
    prune();

    const send = (m: ServerMessage) => {
      if (m.type === "agent_done") run.doneReason = m.reason;
      appendEvent(run, m);
    };

    const finalize = (errored: boolean) => {
      run.finishedAt = Date.now();
      run.status = errored
        ? "error"
        : run.state.stopRequested || run.doneReason === "stopped"
          ? "stopped"
          : "completed";
      activeByUser.delete(userId);
      for (const kill of run.running.values()) kill(); // no leftover processes
      run.procs.killAll();
      endSse(run);
      devStore.touchLastUsed(userId, keyId);
      // Bill the run: one input + one output meter event, idempotent by run id.
      void reportApiUsage(
        config,
        devStore.customerIdFor(userId),
        { input: run.inputTokens, output: run.outputTokens },
        run.runId,
      );
      // Accumulate a running usage/cost total for the developer's dashboard.
      devStore.recordUsage(userId, run.inputTokens, run.outputTokens);
      // Persist what the agent built — API callers have no session to debounce a
      // sync for, so snapshot the workspace now (best-effort, never throws).
      if (snapshotEnabled(config)) {
        void snapshotProject(config, userStorageKey(identity), opts.project, dir);
      }
      const ttl = setTimeout(() => runs.delete(run.runId), FINISHED_TTL_MS);
      ttl.unref?.();
    };

    void runAgent(run.runId, opts.prompt, {
      config,
      workspaceDir: dir,
      mode: "autopilot", // no human in the loop to approve copilot gates
      effort,
      canRunCommands,
      state: run.state,
      send,
      meter: {
        tier,
        // No Sparks limits — metered billing. Suspension still locks the key out
        // (also enforced at the route), and record() keeps RAW token counts.
        isOver: () => store.isSuspended(userId),
        paywallMessage: () => store.suspendMessageFor(userId) || "Your account is suspended.",
        record: (tokens, split) => {
          if (tokens > 0) {
            run.inputTokens += Math.max(0, split ? split.input : tokens);
            run.outputTokens += Math.max(0, split ? split.output : 0);
          }
          return store.snapshot(userId, tier);
        },
      },
      runShell: (command, agentId) =>
        execCapture(command, agentId, dir, {
          runtimeMode,
          procs: run.procs,
          running: run.running,
          config,
          send,
        }),
      requestApproval: async () => true, // autopilot never asks
    })
      .then(() => finalize(false))
      .catch((err) => {
        appendEvent(run, { type: "error", id: run.runId, message: String((err as Error).message) });
        finalize(true);
      });

    return toPublic(run);
  }

  function getRun(userId: string, runId: string) {
    const run = runs.get(runId);
    if (!run || run.userId !== userId) return null; // cross-user ids look absent
    return toPublic(run);
  }

  function cancelRun(userId: string, runId: string): { status: string } {
    const run = runs.get(runId);
    if (!run || run.userId !== userId) throw new ApiError(404, "No such run.");
    if (run.status !== "running") throw new ApiError(409, `Run already ${run.status}.`);
    run.state.stopRequested = true;
    run.state.abort?.abort();
    return { status: "stopping" };
  }

  /** SSE: replay the buffered events, then stream live ones until done. */
  function attachSse(userId: string, runId: string, res: ServerResponse): void {
    const run = runs.get(runId);
    if (!run || run.userId !== userId) throw new ApiError(404, "No such run.");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.status !== "running") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      res.end();
      return;
    }
    run.sse.add(res);
    // Heartbeat comment every 25s: Render's proxy kills streams with no bytes
    // for ~100s, and a run can sit quiet that long (model think-time, slow
    // shell steps). Cleared when the response closes (endSse() → res.end()
    // fires "close" too, so completion is covered).
    const ka = setInterval(() => {
      try {
        res.write(": ka\n\n");
      } catch {
        clearInterval(ka);
      }
    }, 25_000);
    ka.unref?.();
    res.on("close", () => {
      clearInterval(ka);
      run.sse.delete(res);
    });
  }

  /** The caller's projects: local dirs ∪ durable snapshots. */
  async function listProjectsFor(
    userId: string,
  ): Promise<Array<{ name: string; lastModifiedMs: number }>> {
    const identity = { userId, email: null, emailVerified: true, mode: "firebase" as const };
    const root = userRoot(config, identity);
    const out = new Map<string, number>();
    for (const p of listProjects(root)) out.set(p.name, p.lastModifiedMs);
    for (const name of await listSnapshotProjects(config, userStorageKey(identity))) {
      if (!out.has(name)) out.set(name, 0);
    }
    return [...out].map(([name, lastModifiedMs]) => ({ name, lastModifiedMs }));
  }

  return { createRun, getRun, cancelRun, attachSse, listProjectsFor };
}

export type ApiRunManager = ReturnType<typeof createApiRunManager>;
