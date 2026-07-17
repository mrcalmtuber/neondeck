import { daemon } from "./daemonClient";
import { useStore } from "./store";
import { clampEffortForTier, effortForTier, type Tier } from "@ide/shared";

/**
 * Thin browser-side controller for the daemon-hosted agent.
 *
 * The actual model call + tool execution happen in the daemon (which holds the
 * API key in its env). Here we just send the prompt text and translate the
 * streamed `agent_*` events into chat/store updates. No API key, no model
 * client, nothing secret lives in the browser.
 */

let activeId: string | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Subscribe to a run's streamed events and render them into the chat. Used both by
 * sendPrompt (new run) and by App on reconnect to REATTACH to a run that survived a
 * brief drop (e.g. after a full reload). Idempotent: re-attaching to the same run is
 * a no-op, so it's safe to call from the connect effect.
 */
export function attachToRun(promptId: string): void {
  if (activeId === promptId && unsubscribe) return; // already streaming this run
  activeId = promptId;
  // A fresh assistant bubble that streamed text appends into.
  let assistantOpen = false;
  const ensureAssistant = () => {
    if (!assistantOpen) {
      useStore.getState().addMessage({ role: "assistant", content: "" });
      assistantOpen = true;
    }
  };

  unsubscribe?.();
  unsubscribe = daemon.onMessage((m) => {
    if (m.id !== activeId) return;
    const s = useStore.getState();
    switch (m.type) {
      case "agent_delta":
        ensureAssistant();
        s.appendToLast(m.text);
        break;
      case "agent_status":
        s.setAgentStatus(m.status);
        break;
      case "agent_tool":
        // A tool call interrupts the current text bubble; show a chip.
        assistantOpen = false;
        s.addMessage({ role: "tool", content: `⚙️ ${m.summary}`, toolName: m.toolName });
        break;
      case "agent_approval":
        // Copilot mode: the agent is paused waiting on a human decision.
        assistantOpen = false;
        s.setAgentStatus("Waiting for your approval…");
        s.setPendingApproval({
          promptId: m.id,
          toolName: m.toolName,
          summary: m.summary,
          detail: m.detail,
        });
        break;
      case "error":
        assistantOpen = false;
        s.addMessage({ role: "assistant", content: `⚠️ ${m.message}` });
        break;
      case "agent_done":
        s.setAgentRunning(false, m.reason === "stopped" ? "Stopped by user" : "Done");
        s.setPendingApproval(null);
        unsubscribe?.();
        unsubscribe = null;
        activeId = null;
        break;
    }
  });
}

/**
 * Drop a stale run subscription. Called when a reconnect finds NO live run on
 * the daemon (grace window expired / daemon restarted) while the UI still
 * thinks one is streaming — without this the panel stays stuck on "working…".
 */
export function abandonRun(): void {
  unsubscribe?.();
  unsubscribe = null;
  activeId = null;
}

export function sendPrompt(prompt: string): void {
  const store = useStore.getState();
  if (store.agentRunning) return;

  store.addMessage({ role: "user", content: prompt });
  store.setAgentRunning(true, "Thinking…");

  void (async () => {
    let id: string;
    try {
      // The daemon tracks the open workspace per-connection. If we reconnected
      // since opening the project, this socket has no workspace — re-open it so
      // the agent doesn't reject with "Open a project from the Hub first."
      const s0 = useStore.getState();
      if (s0.transport === "daemon" && s0.activeProject && daemon.openedProject !== s0.activeProject) {
        const { root } = await daemon.openProject(s0.activeProject);
        useStore.getState().setTree(root);
      }
      const st = useStore.getState();
      const tier = (st.usage?.tier ?? 0) as Tier;
      const effort = clampEffortForTier(tier, st.agentEffort ?? effortForTier(tier));
      id = daemon.agentPrompt(prompt, st.agentMode, effort);
    } catch (e) {
      const s = useStore.getState();
      s.addMessage({ role: "assistant", content: `⚠️ ${e instanceof Error ? e.message : String(e)}` });
      s.setAgentRunning(false, "");
      return;
    }
    attachToRun(id);
  })();
}

/** Copilot "Approve Edit" / "Reject": answer the parked tool call and resume. */
export function resolveApproval(approve: boolean): void {
  const s = useStore.getState();
  const pending = s.pendingApproval;
  if (!pending) return;
  daemon.approveTool(pending.promptId, approve);
  s.setPendingApproval(null);
  s.setAgentStatus(approve ? "Approved — continuing…" : "Rejected — continuing…");
  if (!approve) {
    s.addMessage({ role: "tool", content: `🚫 You rejected: ${pending.summary}` });
  }
}

/** Stop Agent button → instant daemon-side interrupt. */
export function stopAgent(): void {
  daemon.stopAgent();
  const s = useStore.getState();
  s.setPendingApproval(null);
  s.setAgentRunning(false, "Stopping…");
}
