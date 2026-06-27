import { ConnectionStatus } from "./ConnectionStatus";
import { ThemeMenu } from "./ThemeMenu";
import { AccountBar } from "./AccountBar";
import { ErrorWatcher } from "./ErrorWatcher";
import { ApprenticeAlert } from "./ApprenticeAlert";
import { Workspace } from "./Workspace";
import { TemplateHub } from "./TemplateHub";
import { ProjectTour, TOUR_SEEN_KEY } from "./ProjectTour";
import { GitHubConnectPrompt, GH_PROMPT_SEEN_KEY } from "./GitHubConnectPrompt";
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { githubAvailable, getStoredGithubToken } from "../lib/githubAuth";
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
  const [ghPromptOpen, setGhPromptOpen] = useState(false);

  // Real-time file tree: redraw on any workspace change.
  useEffect(() => ws.onTreeChange(setTree), [setTree, transport]);

  // First time inside a project: optionally offer to connect GitHub (convenience),
  // THEN run the friendly walkthrough. If GitHub isn't available / already linked /
  // already offered, go straight to the tour.
  useEffect(() => {
    const flag = (k: string) => {
      try {
        return localStorage.getItem(k) === "done";
      } catch {
        return false;
      }
    };
    if (flag(TOUR_SEEN_KEY)) return; // returning user — nothing to show
    let cancelled = false;
    (async () => {
      const offerGitHub =
        !flag(GH_PROMPT_SEEN_KEY) && !getStoredGithubToken() && (await githubAvailable());
      if (cancelled) return;
      if (offerGitHub) setGhPromptOpen(true);
      else useStore.getState().setTourOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

      {/* Optional first-run GitHub connect (convenience), shown before the tour. */}
      {ghPromptOpen && (
        <GitHubConnectPrompt
          onDone={() => {
            setGhPromptOpen(false);
            useStore.getState().setTourOpen(true);
          }}
        />
      )}

      {/* First-run interactive walkthrough (replayable from Settings). */}
      <ProjectTour />

      {/* Friendly floating build-error alert (the only error surface now). */}
      <ApprenticeAlert />
    </div>
  );
}
