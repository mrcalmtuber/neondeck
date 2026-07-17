import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { LiveView } from "./LiveView";
import { PackagesPanel } from "./PackagesPanel";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { ConsolePane } from "./tools/ConsolePane";
import { ShellPane } from "./tools/ShellPane";
import { SecretsPane } from "./tools/SecretsPane";
import { GitPane } from "./tools/GitPane";
import { PortsPane } from "./tools/PortsPane";
import { DeployPane } from "./tools/DeployPane";
import { SearchPane } from "./tools/SearchPane";

interface ToolModule {
  id: string;
  icon: string;
  label: string;
  desc: string;
  /** Extra search terms for the picker. */
  keywords: string;
  render: () => ReactNode;
}

/**
 * The workspace tool registry (Replit-style modules). Single source of truth
 * for the tab bar, the searchable picker, and what each tab renders.
 */
const TOOL_MODULES: ToolModule[] = [
  {
    id: "webview",
    icon: "▶",
    label: "Webview",
    desc: "Your running app, live",
    keywords: "webview preview browser app run",
    render: () => <LiveView />,
  },
  {
    id: "console",
    icon: "🖥️",
    label: "Console",
    desc: "Output from runs, installs and the agent",
    keywords: "console log output stdout stderr",
    render: () => <ConsolePane />,
  },
  {
    id: "shell",
    icon: "⌨️",
    label: "Shell",
    desc: "Run commands in your workspace",
    keywords: "shell terminal bash command cli",
    render: () => <ShellPane />,
  },
  {
    id: "packages",
    icon: "📦",
    label: "Packages",
    desc: "Search and install npm dependencies",
    keywords: "packages npm dependencies install node modules",
    render: () => <PackagesPanel />,
  },
  {
    id: "database",
    icon: "🗄️",
    label: "Database",
    desc: "Browse and edit your project's SQLite data",
    keywords: "database sqlite sql tables rows storage",
    render: () => <DatabaseExplorer />,
  },
  {
    id: "secrets",
    icon: "🔑",
    label: "Secrets",
    desc: "Environment variables for your app (.env)",
    keywords: "secrets env environment variables keys config",
    render: () => <SecretsPane />,
  },
  {
    id: "git",
    icon: "🌿",
    label: "Git",
    desc: "Commit history + push to GitHub",
    keywords: "git github version control commit push history",
    render: () => <GitPane />,
  },
  {
    id: "ports",
    icon: "🔌",
    label: "Ports",
    desc: "Running processes and their ports",
    keywords: "ports networking processes pid kill",
    render: () => <PortsPane />,
  },
  {
    id: "deploy",
    icon: "🚀",
    label: "Deployments",
    desc: "Share your app on a public URL",
    keywords: "deploy deployments publish share tunnel live url hosting",
    render: () => <DeployPane />,
  },
  {
    id: "search",
    icon: "🔎",
    label: "Search",
    desc: "Find text across every file in the project",
    keywords: "search find grep files text",
    render: () => <SearchPane />,
  },
];

/** Replit tools with no Kryct counterpart yet — listed honestly, not faked. */
const UNAVAILABLE = "SSH · Object storage · Auth · Extensions";

/**
 * The center pane: tabs at the top (Replit-style workspace tools) + a
 * searchable module picker behind the ＋ button. Every OPEN tab stays mounted
 * (hidden with display:none) so the Webview iframe never reloads on tab switch
 * and Shell/Console keep their buffers.
 */
export function ToolPane() {
  const tabs = useStore((s) => s.toolTabs);
  const activeStored = useStore((s) => s.activeTool);
  const openTool = useStore((s) => s.openTool);
  const closeTool = useStore((s) => s.closeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Drop ids an older localStorage may hold that no longer exist.
  const openModules = tabs
    .map((id) => TOOL_MODULES.find((m) => m.id === id))
    .filter((m): m is ToolModule => Boolean(m));
  const fallback = openModules[0]?.id ?? "webview";
  const active = openModules.some((m) => m.id === activeStored) ? activeStored : fallback;

  useEffect(() => {
    if (pickerOpen) {
      setQuery("");
      searchRef.current?.focus();
    }
  }, [pickerOpen]);

  const q = query.trim().toLowerCase();
  const filtered = TOOL_MODULES.filter(
    (m) =>
      !q ||
      m.label.toLowerCase().includes(q) ||
      m.desc.toLowerCase().includes(q) ||
      m.keywords.includes(q),
  );

  function pick(id: string) {
    openTool(id);
    setPickerOpen(false);
  }

  return (
    <div className="toolpane">
      <div className="toolpane-tabs" role="tablist" aria-label="Workspace tools">
        {openModules.map((m) => (
          <div
            key={m.id}
            role="tab"
            aria-selected={m.id === active}
            tabIndex={0}
            className={`toolpane-tab${m.id === active ? " active" : ""}`}
            onClick={() => setActiveTool(m.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveTool(m.id);
              }
            }}
          >
            <span className="toolpane-tab-icon">{m.icon}</span>
            <span className="toolpane-tab-label">{m.label}</span>
            {openModules.length > 1 && (
              <button
                className="toolpane-tab-x"
                aria-label={`Close ${m.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTool(m.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          className="toolpane-add"
          onClick={() => setPickerOpen((v) => !v)}
          title="Add a tool"
          aria-label="Add a tool"
        >
          ＋
        </button>
      </div>

      {pickerOpen && (
        <>
          <div className="module-picker-backdrop" onClick={() => setPickerOpen(false)} />
          <div className="module-picker" role="dialog" aria-label="Add a tool">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPickerOpen(false);
                else if (e.key === "Enter" && filtered.length > 0) pick(filtered[0].id);
              }}
            />
            <div className="module-picker-list">
              {filtered.map((m) => (
                <button key={m.id} className="module-picker-row" onClick={() => pick(m.id)}>
                  <span className="module-picker-icon">{m.icon}</span>
                  <span className="module-picker-meta">
                    <span className="module-picker-name">{m.label}</span>
                    <span className="muted small">{m.desc}</span>
                  </span>
                  {tabs.includes(m.id) && <span className="module-picker-open">open</span>}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="muted small module-picker-none">No tools match “{query.trim()}”.</p>
              )}
            </div>
            <p className="muted module-picker-foot">Not available yet: {UNAVAILABLE}</p>
          </div>
        </>
      )}

      <div className="toolpane-body">
        {openModules.map((m) => (
          <div
            key={m.id}
            className="toolpane-view"
            style={{ display: m.id === active ? "flex" : "none" }}
          >
            {m.render()}
          </div>
        ))}
      </div>
    </div>
  );
}
