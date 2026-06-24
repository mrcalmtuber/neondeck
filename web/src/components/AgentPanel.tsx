import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { sendPrompt, stopAgent, resolveApproval } from "../lib/agent";
import { AGENT_NAME } from "../lib/brand";
import {
  EFFORT_LEVELS,
  EFFORT_LABELS,
  effortForTier,
  clampEffortForTier,
  type AgentEffort,
  type Tier,
} from "@ide/shared";

/** Re-arm App's connect effect to retry the daemon handshake (no reload). */
function reconnectDaemon() {
  daemon.disconnect();
  useStore.getState().requestConnect();
}

/** One-click beginner starter prompts. */
const RECIPES: { emoji: string; label: string; prompt: string }[] = [
  { emoji: "🚀", label: "Simple counter page", prompt: "Build a simple counter page with + and - buttons and a live count, then run it." },
  { emoji: "🎨", label: "Dark mode background", prompt: "Make the app background dark mode with light text and a subtle accent color." },
  { emoji: "📝", label: "To-do list", prompt: "Create a to-do list page where I can add and remove items, then run it." },
  { emoji: "🌐", label: "Express /health API", prompt: "Scaffold an Express server with a /health route that returns { ok: true } and run it." },
];

/**
 * The "Vibe Coding" agent tab: prompt input, streaming thoughts, a live status
 * ticker, and a prominent Stop Agent button. The model runs in the daemon; this
 * panel only sends prompt text and renders streamed events.
 */
export function AgentPanel() {
  const messages = useStore((s) => s.messages);
  const agentRunning = useStore((s) => s.agentRunning);
  const agentStatus = useStore((s) => s.agentStatus);
  const agentReady = useStore((s) => s.agentReady);
  const agentMode = useStore((s) => s.agentMode);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const pendingApproval = useStore((s) => s.pendingApproval);
  const session = useStore((s) => s.session);
  const connError = useStore((s) => s.connError);
  const tier = (useStore((s) => s.usage?.tier) ?? 0) as Tier;
  const agentEffort = useStore((s) => s.agentEffort);
  const setAgentEffort = useStore((s) => s.setAgentEffort);
  const [input, setInput] = useState("");
  const [effortOpen, setEffortOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Shown effort = the user's pick (or tier default), clamped to the tier ceiling
  // so a stale "high" after a downgrade self-corrects to medium.
  const effectiveEffort = clampEffortForTier(tier, agentEffort ?? effortForTier(tier));

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  /** Pick an effort — every level is available on every plan. */
  function pickEffort(level: AgentEffort) {
    setAgentEffort(level);
    setEffortOpen(false);
  }

  function submit() {
    const prompt = input.trim();
    if (!prompt || agentRunning) return;
    setInput("");
    sendPrompt(prompt);
  }

  function runRecipe(prompt: string) {
    if (agentRunning || !agentReady) {
      setInput(prompt); // can't run yet — just autofill
      return;
    }
    setInput("");
    sendPrompt(prompt);
  }

  return (
    <div className="agent">
      <div className="agent-header">
        <span>✦ Vibe Coding <em className="model-tag">{AGENT_NAME}</em></span>
        {!agentReady && (
          <span className="warn-pill" title={connError ?? "Not connected to your workspace"}>
            Agent offline · reconnecting to your workspace
          </span>
        )}
        {!agentReady && session && (
          <button className="btn-ghost sm" onClick={reconnectDaemon} title="Retry the daemon connection">
            ⚡ Reconnect
          </button>
        )}
      </div>

      {/* Feature 3 — Copilot vs Autopilot sliding toggle. */}
      <div
        className={`mode-toggle ${agentRunning ? "locked" : ""}`}
        data-mode={agentMode}
        role="group"
        aria-label="Agent autonomy mode"
      >
        <span className="mode-knob" />
        <button
          className={`mode-opt ${agentMode === "copilot" ? "on" : ""}`}
          onClick={() => !agentRunning && setAgentMode("copilot")}
          disabled={agentRunning}
          title="Passive assistant — every file write & command needs your approval"
        >
          Copilot 🔒
        </button>
        <button
          className={`mode-opt ${agentMode === "autopilot" ? "on" : ""}`}
          onClick={() => !agentRunning && setAgentMode("autopilot")}
          disabled={agentRunning}
          title="Full autonomy — writes files, installs packages, runs & self-corrects"
        >
          Autopilot 🚀
        </button>
      </div>
      <div className="mode-hint muted">
        {agentMode === "copilot"
          ? "Copilot proposes; nothing is written or run until you approve it."
          : "Autopilot acts on its own — chaining edits, installs, and test runs."}
      </div>

      <div className="agent-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="agent-empty">
            <div className="muted">
              Describe what you want to build, or pick a starter recipe. The agent edits files and
              runs commands in a secure isolated sandbox.
            </div>
            <div className="recipe-grid">
              {RECIPES.map((r) => (
                <button key={r.label} className="recipe" onClick={() => runRecipe(r.prompt)}>
                  <span className="recipe-emoji">{r.emoji}</span>
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === "tool" ? (
              <code className="tool-chip">{m.content}</code>
            ) : (
              <div className="msg-content">{m.content}</div>
            )}
          </div>
        ))}
      </div>

      {pendingApproval && (
        <div className="approval-card">
          <div className="approval-head">
            <span className="approval-badge">
              {pendingApproval.toolName === "write_to_file" ? "✏️ File write" : "⌨️ Command"} needs
              approval
            </span>
          </div>
          <div className="approval-summary">{pendingApproval.summary}</div>
          <pre className="approval-detail">{pendingApproval.detail}</pre>
          <div className="approval-actions">
            <button className="btn-primary" onClick={() => resolveApproval(true)}>
              ✅ Approve Edit
            </button>
            <button className="btn-stop" onClick={() => resolveApproval(false)}>
              ✋ Reject
            </button>
          </div>
        </div>
      )}

      {agentRunning && !pendingApproval && (
        <div className="status-ticker">
          <span className="spinner" />
          <span>{agentStatus || "Working…"}</span>
        </div>
      )}

      <div className="agent-input">
        <textarea
          value={input}
          placeholder="e.g. Scaffold an Express server with a /health route and run it"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
        <div className="agent-actions">
          {agentRunning ? (
            <button className="btn-stop" onClick={stopAgent}>
              ■ Stop Agent
            </button>
          ) : (
            <button className="btn-primary" onClick={submit} disabled={!input.trim() || !agentReady}>
              ➤ Send
            </button>
          )}
          {/* Reasoning-effort selector — sits to the right of Send (opens upward,
              right-anchored so it never clips off the edge of the window). */}
          <div className="effort-menu up">
            <button
              className="effort-trigger"
              disabled={agentRunning}
              onClick={() => setEffortOpen((o) => !o)}
              title="How hard the agent thinks before answering"
            >
              ⚡ {EFFORT_LABELS[effectiveEffort]} ▴
            </button>
            {effortOpen && (
              <>
                <div className="menu-scrim" onClick={() => setEffortOpen(false)} />
                <div className="effort-dropdown">
                  {EFFORT_LEVELS.map((level) => (
                    <button
                      key={level}
                      className={`effort-row ${effectiveEffort === level ? "active" : ""}`}
                      onClick={() => pickEffort(level)}
                    >
                      <span>{EFFORT_LABELS[level]}</span>
                      {effectiveEffort === level && <span className="effort-check">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
