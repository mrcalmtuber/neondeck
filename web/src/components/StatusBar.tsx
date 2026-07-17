import { getTier } from "@ide/shared";
import { useStore } from "../lib/store";
import { getStoredGithubToken } from "../lib/githubAuth";
import { SettingsMenu } from "./SettingsMenu";

/**
 * Replit-style bottom status bar for the IDE. Every segment is live store
 * state; the clickable ones jump to the matching tool tab or Settings.
 *
 *  ● Connected · Node · my-app   ⟳ agent status…   app.js ● · Preview ● · Share · GitHub ✓ · Pro
 */
export function StatusBar() {
  const conn = useStore((s) => s.conn);
  const runtimeMode = useStore((s) => s.runtimeMode);
  const activeProject = useStore((s) => s.activeProject);
  const agentRunning = useStore((s) => s.agentRunning);
  const agentStatus = useStore((s) => s.agentStatus);
  const openFile = useStore((s) => s.openFile);
  const dirty = useStore((s) => s.dirty);
  const previewSlot = useStore((s) => s.previewSlot);
  const tunnel = useStore((s) => s.tunnel);
  const tier = useStore((s) => s.tier());
  const openTool = useStore((s) => s.openTool);
  const setView = useStore((s) => s.setView);
  const ghConnected = !!getStoredGithubToken();

  const connLabel =
    conn === "connected" ? "Connected" : conn === "reconnecting" ? "Reconnecting…" : "Offline";
  const runtimeLabel =
    runtimeMode === "DOCKER" ? "Docker" : runtimeMode === "LOCAL_NODE" ? "Node" : "Browser";

  return (
    <footer className="statusbar" aria-label="Workspace status">
      {/* Bottom-left account / settings launcher — opens "a bunch of stuff". */}
      <SettingsMenu />
      <span className="statusbar-seg">
        <span className={`status-dot ${conn}`} />
        {connLabel}
      </span>
      <span className="statusbar-seg">{runtimeLabel}</span>
      {activeProject && <span className="statusbar-seg statusbar-project">{activeProject}</span>}

      <span className="statusbar-mid">
        {agentRunning && (
          <span className="statusbar-seg statusbar-agent">
            <span className="spinner" /> {agentStatus || "Agent working…"}
          </span>
        )}
      </span>

      {openFile && (
        <span className="statusbar-seg statusbar-file" title={openFile}>
          {openFile}
          {dirty ? " ●" : ""}
        </span>
      )}
      <button
        className="statusbar-seg statusbar-btn"
        onClick={() => openTool("webview")}
        title="Open the Webview tab"
      >
        <span className={`status-dot ${previewSlot ? "connected" : "off"}`} />
        Preview
      </button>
      <button
        className="statusbar-seg statusbar-btn"
        onClick={() => openTool("deploy")}
        title="Open the Deployments tab"
      >
        <span className={`status-dot ${tunnel.state === "open" ? "connected" : "off"}`} />
        Share
      </button>
      <button
        className="statusbar-seg statusbar-btn"
        onClick={() => setView("settings")}
        title={ghConnected ? "GitHub connected" : "Connect GitHub in Settings"}
      >
        GitHub {ghConnected ? "✓" : "–"}
      </button>
      <span className="statusbar-seg statusbar-tier">{getTier(tier).name}</span>
    </footer>
  );
}
