import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ServerMessage, AgentMode, AgentEffort } from "@ide/shared";
import { MAX_RESPONSE_TOKENS } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import { writeFile } from "./workspace.js";
import type { Meter } from "./usage.js";

/**
 * Server-side "Vibe Coding" agent. The API key lives only here (host env via
 * config) and never touches the browser. The browser sends prompt text; this
 * loop runs the model + tools locally and streams results back over the socket.
 */

/**
 * CONTEXT-CACHE ANCHOR: the global operating parameters, tool list, and sandbox
 * constraints are a single static block pinned at message index 0 and never
 * mutated. Keeping this prefix byte-identical across turns lets DeepSeek serve
 * it from its server-side context cache.
 */
const SYSTEM_PROMPT = `You are a coding agent embedded in a local-first web IDE.
You operate exclusively on the user's machine through a sandboxed Docker container.

Tools:
- write_to_file(filePath, content): create or modify a file in the project workspace.
  You have explicit permission to create brand-new files and folders.
- run_terminal_command(command): run a shell command inside the sandbox container.

Sandbox constraints (immutable): non-root user 1000:1000, all Linux capabilities
dropped, read-only root filesystem, 256MB RAM, 0.5 vCPU, only /workspace is writable.

Operating rules:
1. Work in small, verifiable steps. After writing code, run it or its tests.
2. Prefer editing existing files over creating duplicates.
3. Read command output before deciding the next step; fix errors you cause.
4. When the task is complete and verified, stop and summarize what you did.`;

export const TOOL_DEFS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "write_to_file",
      description:
        "Create or overwrite a file in the sandboxed project workspace. Use for all code additions and modifications. Creating new files/folders is allowed.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Workspace-relative path, e.g. 'src/index.ts'." },
          content: { type: "string", description: "The full file contents to write." },
        },
        required: ["filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description:
        "Run a shell command inside the sandboxed Docker container (install deps, run tests, build). Returns combined stdout/stderr and exit code.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to execute." } },
        required: ["command"],
      },
    },
  },
];

/** Per-connection agent state held by the server. */
export interface AgentState {
  history: ChatCompletionMessageParam[];
  stopRequested: boolean;
  abort: AbortController | null;
  /** Resolver for an in-flight Copilot approval (resolved by approve_tool). */
  pendingApproval: ((approve: boolean) => void) | null;
}

export function newAgentState(): AgentState {
  return { history: [], stopRequested: false, abort: null, pendingApproval: null };
}

export interface AgentDeps {
  config: DaemonConfig;
  /** Active project directory (the agent's file jail). */
  workspaceDir: string;
  /** Copilot gates structural tools behind approval; autopilot runs autonomously. */
  mode: AgentMode;
  /** Reasoning effort for this run, derived from the user's plan tier. */
  effort: AgentEffort;
  /** Whether this plan may run shell commands (Pro+). Free = false: the agent can
   *  reason and write files but not execute commands. */
  canRunCommands: boolean;
  state: AgentState;
  send: (m: ServerMessage) => void;
  /** Runs a command in the sandbox, streaming output to the terminal panel. */
  runShell: (command: string, agentId: string) => Promise<{ output: string; exitCode: number | null }>;
  /**
   * Ask the human to approve a gated tool call (Copilot mode). Emits an
   * agent_approval event and resolves when the user clicks Approve / Reject.
   */
  requestApproval: (toolName: string, summary: string, detail: string) => Promise<boolean>;
  /** Token meter — charges usage per step and signals when the pool is spent. */
  meter: Meter;
}

// Upper bound on agent turns. The token meter (monthly pool + hidden daily cap)
// is the REAL stop condition; this is just a runaway guard set high enough that a
// legitimate multi-file build is never cut off midway.
const MAX_STEPS = 150;

export async function runAgent(promptId: string, prompt: string, deps: AgentDeps): Promise<void> {
  const { config, state, send } = deps;

  if (!config.deepseekApiKey) {
    send({
      type: "error",
      id: promptId,
      message: "Neon Agent isn't configured on the daemon.",
    });
    send({ type: "agent_done", id: promptId, reason: "completed" });
    return;
  }

  // Metering gate: refuse to start if the pool is already spent (monthly OR the
  // hidden daily cap). The message is generic "usage-based pricing" for the daily
  // throttle so the limit is never revealed.
  if (deps.meter.isOver()) {
    const snap = deps.meter.record(0);
    send({
      type: "paywall",
      id: promptId,
      usage: snap,
      message: deps.meter.paywallMessage(),
    });
    send({ type: "agent_done", id: promptId, reason: "stopped" });
    return;
  }

  const client = new OpenAI({ apiKey: config.deepseekApiKey, baseURL: config.deepseekBaseUrl });

  state.stopRequested = false;
  state.abort = new AbortController();

  // Mode + effort directives live AFTER the cached anchor so switching either one
  // never invalidates the index-0 prefix that DeepSeek serves from its context
  // cache. Both ride on the single index-1 system note (the finally block slices
  // history from index 2, so this stays a per-turn directive that never persists).
  const modeText =
    deps.mode === "copilot"
      ? "MODE: COPILOT. You are a passive pair-programmer. Explain, review, and propose. " +
        "Every write_to_file and run_terminal_command requires explicit human approval before it runs — " +
        "prefer proposing concrete diffs/commands and let the user approve. Do not assume an action ran until you see its result."
      : "MODE: AUTOPILOT. You have full autonomy. Chain file writes, install missing packages " +
        "(npm install via run_terminal_command), run tests/build, read the output, and self-correct until the task is verified complete.";
  const effortText =
    deps.effort === "low"
      ? "EFFORT: LOW. Respond directly and efficiently. Minimize internal deliberation — for simple tasks, act immediately with concise output and don't over-plan."
      : deps.effort === "medium"
        ? "EFFORT: MEDIUM. Engage balanced internal reasoning: think through the logic, edge cases, and design before acting; plan multi-step changes deliberately."
        : "EFFORT: HIGH. Use maximum step-by-step reasoning. Decompose the problem, weigh alternatives, and VERIFY your work (run/test, re-read output) before declaring done. Prioritize correctness over speed.";
  // Free plan: the run_terminal_command tool is refused at execution time, so tell
  // the model up front to avoid wasting steps on commands it can't run.
  const execText = deps.canRunCommands
    ? ""
    : "\n\nNOTE: Shell/terminal command execution is NOT available on this plan. " +
      "Use write_to_file only; do not call run_terminal_command. If a task needs " +
      "running code or installing packages, write the files and tell the user to upgrade to Pro to run them.";
  const modeNote: ChatCompletionMessageParam = {
    role: "system",
    content: `${modeText}\n\n${effortText}${execText}`,
  };

  // Static system block pinned at index 0; mode note + history follow.
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    modeNote,
    ...state.history,
    { role: "user", content: prompt },
  ];

  // Surface the active effort + its token budget in the status ticker so the user
  // can see the selection actually reached the model call (not just a UI toggle).
  const effortLabel = deps.effort.charAt(0).toUpperCase() + deps.effort.slice(1);
  const budgetK = Math.round(MAX_RESPONSE_TOKENS[deps.effort] / 1024);
  const effortTag = `${effortLabel} effort (${budgetK}K budget)`;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (state.stopRequested) break;
      send({
        type: "agent_status",
        id: promptId,
        status: `Step ${step + 1} · ${effortTag} · contacting model…`,
      });

      const stream = await client.chat.completions.create(
        {
          model: config.agentModels[deps.effort],
          messages,
          tools: TOOL_DEFS,
          stream: true,
          stream_options: { include_usage: true },
          // Per-response budget scales with effort (Low/High/Max); the monthly
          // pool is enforced separately by deps.meter.
          max_tokens: MAX_RESPONSE_TOKENS[deps.effort],
        },
        { signal: state.abort.signal },
      );

      let assistantText = "";
      let stepTokens = 0;
      const toolCalls: Record<number, { id: string; name: string; args: string }> = {};

      for await (const chunk of stream) {
        if (state.stopRequested) break;
        if (chunk.usage) stepTokens = chunk.usage.total_tokens;
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          send({ type: "agent_delta", id: promptId, text: delta.content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }

      // Safety net: if the provider didn't report usage for this request, estimate
      // it (full prompt + output at ~4 chars/token) so consumption is never charged
      // as 0 — keeps metering honest against real provider billing.
      if (stepTokens === 0) {
        const inChars = messages.reduce(
          (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
          0,
        );
        stepTokens = Math.ceil((inChars + assistantText.length) / 4);
      }
      // Charge this step's tokens; halt if the pool is now spent (monthly OR the
      // hidden daily cap — isOver() covers both).
      const snap = deps.meter.record(stepTokens);
      if (deps.meter.isOver()) {
        send({
          type: "paywall",
          id: promptId,
          usage: snap,
          message: deps.meter.paywallMessage(),
        });
        send({ type: "agent_done", id: promptId, reason: "stopped" });
        break;
      }

      const calls = Object.values(toolCalls);
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.length
          ? calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.args },
            }))
          : undefined,
      });

      if (calls.length === 0) {
        send({ type: "agent_done", id: promptId, reason: "completed" });
        break;
      }

      for (const call of calls) {
        if (state.stopRequested) break;
        const result = await executeTool(call.name, call.args, promptId, deps);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      if (step === MAX_STEPS - 1) {
        send({ type: "agent_done", id: promptId, reason: "max_steps" });
      }
    }

    if (state.stopRequested) {
      send({ type: "agent_done", id: promptId, reason: "stopped" });
    }
  } catch (err) {
    if (state.stopRequested) {
      send({ type: "agent_done", id: promptId, reason: "stopped" });
    } else {
      send({ type: "error", id: promptId, message: (err as Error).message });
      send({ type: "agent_done", id: promptId, reason: "completed" });
    }
  } finally {
    // Persist conversation minus the static anchor (idx 0) and the per-turn mode
    // note (idx 1) so neither accumulates across turns.
    state.history = messages.slice(2);
    state.abort = null;
    state.pendingApproval = null;
  }
}

async function executeTool(
  name: string,
  rawArgs: string,
  promptId: string,
  deps: AgentDeps,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return "Error: tool arguments were not valid JSON.";
  }

  switch (name) {
    case "write_to_file": {
      const filePath = String(args.filePath ?? "");
      const content = String(args.content ?? "");
      const summary = stepSummary(name, args);
      // Copilot mode: the write is locked until the human approves it.
      if (deps.mode === "copilot") {
        const ok = await deps.requestApproval(name, summary, previewContent(filePath, content));
        if (!ok) return `The user DECLINED writing ${filePath}. Do not retry; propose an alternative or ask why.`;
      }
      deps.send({ type: "agent_tool", id: promptId, toolName: name, summary });
      await writeFile(deps.workspaceDir, filePath, content);
      // The fs watcher broadcasts WORKSPACE_CHANGED, refreshing the explorer.
      return `Wrote ${filePath}.`;
    }

    case "run_terminal_command": {
      const command = String(args.command ?? "");
      // Free plan: model calls are allowed but command execution is not.
      if (!deps.canRunCommands) {
        return "Shell command execution is not available on the user's current plan (Pro+ only). Do not retry; write the necessary files instead and suggest upgrading to Pro to run commands.";
      }
      const summary = stepSummary(name, args);
      if (deps.mode === "copilot") {
        const ok = await deps.requestApproval(name, summary, `$ ${command}`);
        if (!ok) return `The user DECLINED running \`${command}\`. Do not retry; suggest an alternative.`;
      }
      deps.send({ type: "agent_tool", id: promptId, toolName: name, summary });
      const { output, exitCode } = await deps.runShell(command, promptId);
      const trimmed = output.length > 8000 ? output.slice(-8000) : output;
      return `exit_code=${exitCode}\n${trimmed}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * A friendly, one-sentence description of a tool step (shown in the agent chat
 * instead of the raw command/path). Heuristic — no extra model call.
 */
function stepSummary(name: string, args: Record<string, unknown>): string {
  if (name === "write_to_file") {
    const fp = String(args.filePath ?? "file");
    const base = fp.split("/").pop() || fp;
    const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
    const what =
      ext === "html" ? "building the page" :
      ext === "css" ? "styling the look" :
      ext === "js" || ext === "jsx" || ext === "ts" || ext === "tsx" || ext === "py" ? "writing the code" :
      ext === "json" ? "setting up config" :
      ext === "md" ? "writing notes" :
      "creating the file";
    return `Writing ${base} — ${what}.`;
  }
  if (name === "run_terminal_command") {
    const c = String(args.command ?? "").trim().toLowerCase();
    if (/\b(npm (ci|install|i)|yarn (install|add)|pnpm (install|add)|pip install)\b/.test(c))
      return "Installing the project's dependencies.";
    if (/\b(npm run build|vite build|tsc|next build|webpack)\b/.test(c))
      return "Building the project.";
    if (/\b(npm (run )?(dev|start)|vite|next dev|node .*serve|flask run|uvicorn|python -m http)\b/.test(c))
      return "Starting the app's server.";
    if (/^git\b/.test(c)) return "Saving the changes to git.";
    if (/\b(mkdir|touch|cp |mv |rm |ls|cat )\b/.test(c)) return "Organizing the project files.";
    if (/\b(curl|wget)\b/.test(c)) return "Fetching a resource from the web.";
    if (/^(node|python|deno|bun)\b/.test(c)) return "Running the program.";
    return "Running a setup step.";
  }
  return "Working on the next step.";
}

/** Build a compact, readable preview of a file write for the approval card. */
function previewContent(filePath: string, content: string): string {
  const capped = content.length > 4000 ? content.slice(0, 4000) + "\n… (truncated)" : content;
  return `${filePath}\n\n${capped}`;
}
