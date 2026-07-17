import { useState } from "react";
import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { makeZip, downloadBlob } from "../lib/zip";
import { FileExplorer } from "./FileExplorer";

/**
 * Right-side collapsible File Tree.
 *
 * Open  → a real grid column holding the file tree, with a "→" button to collapse.
 * Closed → a slim "←" handle pinned to the right edge that re-opens the column.
 * (The parent .ws-panels grid drops the third column when closed.)
 *
 * Header actions:
 *   📥 Download .zip → bundles every workspace text file into kryct-project.zip
 *   🚀 Deploy to Web → opens the Deployments tool (Free gets 30 days of
 *      publishing from the first deploy; the pane handles the upgrade nudge)
 */
export function FileDrawer() {
  const open = useStore((s) => s.fileDrawerOpen);
  const setOpen = useStore((s) => s.setFileDrawerOpen);
  const [zipping, setZipping] = useState(false);

  function openDeployTool() {
    const s = useStore.getState();
    s.openTool("deploy");
    s.setMobilePane("center"); // on phones the tool pane lives in the Build tab
  }

  async function downloadZip() {
    setZipping(true);
    try {
      const files = await ws.collectFiles();
      const blob = makeZip(files.map((f) => ({ name: f.path, content: f.content })));
      downloadBlob(blob, "kryct-project.zip");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setZipping(false);
    }
  }

  if (!open) {
    return (
      <button
        className="ws-tree-handle"
        onClick={() => setOpen(true)}
        title="Show file tree"
        aria-label="Show file tree"
      >
        ←
      </button>
    );
  }

  return (
    <aside className="ws-tree">
      <div className="ws-tree-head">
        <span>📁 Files</span>
        <button className="icon-btn" onClick={() => setOpen(false)} title="Hide file tree">
          →
        </button>
      </div>

      <div className="ws-tree-actions">
        <button
          className="tree-action download"
          onClick={downloadZip}
          disabled={zipping}
          title="Bundle all workspace files into a .zip"
        >
          {zipping ? "Bundling…" : "📥 Download .zip"}
        </button>
        <button
          className="tree-action deploy"
          onClick={openDeployTool}
          title="Put this app on a public live URL"
        >
          🚀 Deploy to Web
        </button>
      </div>

      <div className="ws-tree-body">
        <FileExplorer />
      </div>
    </aside>
  );
}
