import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { sendPrompt } from "../lib/agent";

/**
 * Friendly build-error interceptor. Instead of a raw red "Code Construction
 * Paused" banner, a compile/build error surfaces as a calm floating alert with
 * one-click "Ask AI to Fix" and a "View Code" shortcut (opens the selected file
 * in the editor). This is the only error surface in the single-layout workspace.
 */
export function ApprenticeAlert() {
  const errorBanner = useStore((s) => s.errorBanner);
  const setErrorBanner = useStore((s) => s.setErrorBanner);
  const agentRunning = useStore((s) => s.agentRunning);

  if (!errorBanner) return null;

  function askAiToFix() {
    const line = errorBanner?.line ? ` near line ${errorBanner.line}` : "";
    setErrorBanner(null);
    if (!agentRunning) {
      sendPrompt(
        `My project has a build/compile error${line}. Please find the typo or mistake and fix the file.`,
      );
    }
  }

  async function viewCode() {
    // Surface the editor (in the agent pane) on the currently selected file so
    // they can see where it broke. With no selection there's nothing to open.
    setErrorBanner(null);
    const sel = useStore.getState().selectedPath;
    if (!sel || sel === ".") return;
    try {
      const content = await ws.read(sel);
      useStore.getState().setOpenFile(sel, content);
    } catch {
      /* selected entry isn't a readable file — just dismiss */
    }
  }

  return (
    <div className="apprentice-alert glass" role="alert">
      <button className="apprentice-alert-x" onClick={() => setErrorBanner(null)} title="Dismiss">
        ✕
      </button>
      <div className="apprentice-alert-body">
        <span className="apprentice-alert-emoji">💡</span>
        <p>
          Oops! There's a little typo in your file. Click <strong>Ask AI to Fix</strong>, or open
          the code to see where it broke.
        </p>
      </div>
      <div className="apprentice-alert-actions">
        <button className="btn-primary" onClick={askAiToFix}>
          🛠️ Ask AI to Fix
        </button>
        <button className="btn-ghost" onClick={viewCode}>
          ‹/› View Code
        </button>
      </div>
    </div>
  );
}
