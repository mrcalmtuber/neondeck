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
  effortAllowedForTier,
  tokenMultiplierForEffort,
  isNearLimit,
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
  const pendingApproval = useStore((s) => s.pendingApproval);
  const session = useStore((s) => s.session);
  const connError = useStore((s) => s.connError);
  const usage = useStore((s) => s.usage);
  const tier = (useStore((s) => s.usage?.tier) ?? 0) as Tier;
  const agentEffort = useStore((s) => s.agentEffort);
  const setAgentEffort = useStore((s) => s.setAgentEffort);
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const messageCount = useStore((s) => s.messages.length);
  const clearActiveChat = useStore((s) => s.clearActiveChat);
  const [input, setInput] = useState("");
  const [effortOpen, setEffortOpen] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Shown effort = the user's pick (or tier default), clamped to the tier ceiling
  // so a stale "high" after a downgrade self-corrects to medium.
  const effectiveEffort = clampEffortForTier(tier, agentEffort ?? effortForTier(tier));

  // Near the (hidden, dynamic) limit → nudge a lower effort to stretch Sparks,
  // instead of revealing how little is left. Dismissible until reload.
  const nearLimit = !!usage && isNearLimit(usage.tokensUsed, usage.tokensLimit);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  /** Pick an effort. High reasoning is a Max-plan perk — for lower tiers that row
   *  opens the upgrade modal instead of selecting it. */
  function pickEffort(level: AgentEffort) {
    setEffortOpen(false);
    if (!effortAllowedForTier(tier, level)) {
      setSubscriptionModalOpen(true);
      return;
    }
    setAgentEffort(level);
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
        {messageCount > 0 && !agentRunning && (
          <button
            className="btn-ghost sm agent-clear"
            onClick={() => {
              if (confirm("Clear this project's chat history? This can't be undone.")) clearActiveChat();
            }}
            title="Clear this project's saved conversation"
          >
            🗑 Clear chat
          </button>
        )}
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

      {nearLimit && !nudgeDismissed && (
        <div className="near-limit-nudge">
          <span>
            ⚡ You're nearing your limit — want to switch effort levels? Lower effort stretches your
            Sparks further.
          </span>
          <div className="near-limit-actions">
            {effectiveEffort !== "low" && (
              <button
                className="btn-ghost sm"
                onClick={() => {
                  setAgentEffort("low");
                  setNudgeDismissed(true);
                }}
              >
                Use Low effort
              </button>
            )}
            <button className="near-limit-x" onClick={() => setNudgeDismissed(true)} title="Dismiss">
              ✕
            </button>
          </div>
        </div>
      )}

      {tokenMultiplierForEffort(tier, effectiveEffort) > 1 && (
        <div className="effort-2x-warn">
          ⚠ Medium effort doubles your Spark usage — your limit burns 2× as fast.
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
                  {EFFORT_LEVELS.map((level) => {
                    const locked = !effortAllowedForTier(tier, level);
                    return (
                      <button
                        key={level}
                        className={`effort-row ${effectiveEffort === level ? "active" : ""}${locked ? " locked" : ""}`}
                        onClick={() => pickEffort(level)}
                        title={locked ? "High reasoning is a Max-plan feature — upgrade to use it" : undefined}
                      >
                        <span>{EFFORT_LABELS[level]}</span>
                        {locked ? (
                          <span className="effort-lock">🔒 Max</span>
                        ) : (
                          effectiveEffort === level && <span className="effort-check">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
