import { ConnectionStatus } from "./ConnectionStatus";
import { ThemeMenu } from "./ThemeMenu";
import { AccountBar } from "./AccountBar";
import { ErrorWatcher } from "./ErrorWatcher";
import { ApprenticeAlert } from "./ApprenticeAlert";
import { Workspace } from "./Workspace";
import { TemplateHub } from "./TemplateHub";
import { useEffect } from "react";
import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { BRAND_LABEL } from "../lib/brand";

/**
 * IDE shell — one layout, no mode/runtime/settings toggles.
 *
 *   topbar: brand · ← Hub · project · status · theme · account
 *   body:   Agent | Live Preview ⇄ Code | collapsible File Tree
 *
 * The headless ErrorWatcher keeps build errors flowing into the store; build
 * failures surface as the friendly floating ApprenticeAlert.
 */
export function Layout() {
  const setTree = useStore((s) => s.setTree);
  const transport = useStore((s) => s.transport);
  const activeProject = useStore((s) => s.activeProject);
  const setView = useStore((s) => s.setView);

  // Real-time file tree: redraw on any workspace change.
  useEffect(() => ws.onTreeChange(setTree), [setTree, transport]);

  return (
    <div className="ide">
      <ErrorWatcher />

      <header className="topbar">
        {/* Home button — returns to the dashboard home menu. */}
        <button
          className="home-btn"
          onClick={() => setView("dashboard")}
          title="Back to Home"
        >
          🏠 Home
        </button>
        <span className="brand">{BRAND_LABEL}</span>
        <span className="active-project">{activeProject ?? "neondeck-workspace"}</span>
        <ConnectionStatus />
        <span className="topbar-spacer" />
        <ThemeMenu />
        <AccountBar />
      </header>

      {/* Sliding NeonDeck Template Hub overlay. */}
      <TemplateHub />

      <Workspace />

      {/* Friendly floating build-error alert (the only error surface now). */}
      <ApprenticeAlert />
    </div>
  );
}
