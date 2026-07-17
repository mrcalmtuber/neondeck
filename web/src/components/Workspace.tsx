import { useStore } from "../lib/store";
import { AgentPanel } from "./AgentPanel";
import { ToolPane } from "./ToolPane";
import { Editor } from "./Editor";
import { FileDrawer } from "./FileDrawer";

/**
 * The single workspace layout:
 *
 *  ┌──────────────────┬───────────────────────┬───────────────┐
 *  │  AI AGENT / CODE │  ▶ Webview 🖥 Console ＋│  ← File Tree  │
 *  │  (primary)       │  (tabbed tool pane)   │  (collapsible)│
 *  └──────────────────┴───────────────────────┴───────────────┘
 *
 * Center hosts the tabbed TOOL PANE (Replit-style workspace tools: Webview,
 * Console, Shell, Packages, Database, … — added via the ＋ picker). The code
 * editor opens in the LEFT (agent) pane when a file is double-clicked in the
 * tree, replacing the agent chat until it's closed; the AgentPanel stays
 * mounted so its stream survives.
 */
export function Workspace() {
  const treeOpen = useStore((s) => s.fileDrawerOpen);
  const openFile = useStore((s) => s.openFile);
  const mobilePane = useStore((s) => s.mobilePane);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const setFileDrawerOpen = useStore((s) => s.setFileDrawerOpen);

  return (
    <div
      className={`ws-panels ${treeOpen ? "tree-open" : "tree-closed"}`}
      data-mobile-pane={mobilePane}
    >
      <section className="ws-agent">
        {/* AgentPanel stays mounted (chat stream survives); hidden while editing. */}
        <div className="ws-agent-host" style={{ display: openFile ? "none" : "flex" }}>
          <AgentPanel />
        </div>
        {openFile && <Editor />}
      </section>

      <section className="ws-center">
        <div className="ws-center-body">
          <div className="ws-pane">
            <ToolPane />
          </div>
        </div>
      </section>

      {/* Right collapsible file tree (column when open, "←" handle when closed). */}
      <FileDrawer />

      {/* Phone-only pane switcher (hidden on desktop via CSS). */}
      <nav className="ws-mobile-tabs">
        <button
          className={mobilePane === "agent" ? "active" : ""}
          onClick={() => setMobilePane("agent")}
        >
          ✦ Agent
        </button>
        <button
          className={mobilePane === "center" ? "active" : ""}
          onClick={() => setMobilePane("center")}
        >
          ▶ Build
        </button>
        <button
          className={mobilePane === "files" ? "active" : ""}
          onClick={() => {
            setFileDrawerOpen(true);
            setMobilePane("files");
          }}
        >
          ☰ Files
        </button>
      </nav>
    </div>
  );
}
