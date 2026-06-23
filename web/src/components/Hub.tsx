import { useEffect, useState } from "react";
import type { Blueprint, ProjectInfo } from "@ide/shared";
import { daemon } from "../lib/daemonClient";
import { useStore } from "../lib/store";
import { PromptDialog } from "./PromptDialog";
import { ThemeMenu } from "./ThemeMenu";
import { AccountBar } from "./AccountBar";
import { BRAND_LABEL } from "../lib/brand";

interface BlueprintCard {
  blueprint: Blueprint;
  emoji: string;
  title: string;
  desc: string;
}
const BLUEPRINTS: BlueprintCard[] = [
  { blueprint: "react-vite", emoji: "🚀", title: "React + Vite Web App", desc: "Modern component app with hot reload." },
  { blueprint: "python", emoji: "🐍", title: "Python Automation Script", desc: "A runnable main.py starter." },
  { blueprint: "vanilla", emoji: "🎨", title: "Vanilla HTML/CSS Portfolio", desc: "Zero-build static site." },
];

// Mock marketplace — community templates that clone from a real blueprint.
const SHOWCASES: { emoji: string; title: string; author: string; blueprint: Blueprint }[] = [
  { emoji: "📊", title: "Analytics Dashboard", author: "@dataviz", blueprint: "react-vite" },
  { emoji: "🛒", title: "Storefront Landing", author: "@shopkit", blueprint: "vanilla" },
  { emoji: "🤖", title: "Discord Bot Starter", author: "@botlab", blueprint: "python" },
];

type Dialog = { kind: "name"; blueprint: Blueprint; title: string } | null;

/** Landing Hub: local projects, starter blueprints, and a community showcase. */
export function Hub() {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const projectsRootName = useStore((s) => s.projectsRootName);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    daemon.listProjects().then(setProjects).catch(console.error);
  }, [setProjects]);

  async function openProject(name: string) {
    setBusy(name);
    try {
      const { root } = await daemon.openProject(name);
      useStore.getState().setActiveProject(name);
      useStore.getState().setTree(root);
      useStore.getState().setOpenFile("", "");
      useStore.getState().resetChat();
      useStore.getState().setView("ide");
    } finally {
      setBusy(null);
    }
  }

  async function createAndOpen(name: string, blueprint: Blueprint) {
    setDialog(null);
    setBusy(name);
    try {
      await daemon.createProject(name, blueprint);
      await openProject(name);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div className="hub">
      <header className="hub-top">
        <span className="brand">{BRAND_LABEL}</span>
        <div className="hub-top-right">
          <button className="btn-primary" onClick={() => setDialog({ kind: "name", blueprint: "blank", title: "Create Brand New Blank Project" })}>
            ➕ Create Brand New Blank Project
          </button>
          <ThemeMenu />
          <AccountBar />
        </div>
      </header>

      <div className="hub-body">
        <section className="hub-section">
          <h2>📁 My Local Projects <span className="muted small">· {projectsRootName || "workspace"}</span></h2>
          {projects.length === 0 ? (
            <p className="muted">No projects yet — spin one up from a blueprint below.</p>
          ) : (
            <div className="card-grid">
              {projects.map((p) => (
                <ProjectCard key={p.name} project={p} busy={busy === p.name} onOpen={() => openProject(p.name)} />
              ))}
            </div>
          )}
        </section>

        <section className="hub-section">
          <h2>✨ Custom Starter Blueprints</h2>
          <div className="card-grid">
            {BLUEPRINTS.map((b) => (
              <button
                key={b.blueprint}
                className="blueprint-card"
                onClick={() => setDialog({ kind: "name", blueprint: b.blueprint, title: `New ${b.title}` })}
              >
                <span className="bp-emoji">{b.emoji}</span>
                <span className="bp-title">{b.title}</span>
                <span className="muted small">{b.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="hub-section">
          <h2>🌍 Community Project Showcases <span className="muted small">· preview & clone</span></h2>
          <div className="card-grid">
            {SHOWCASES.map((s) => (
              <div key={s.title} className="showcase-card">
                <span className="bp-emoji">{s.emoji}</span>
                <span className="bp-title">{s.title}</span>
                <span className="muted small">by {s.author}</span>
                <button
                  className="btn-ghost sm"
                  onClick={() => setDialog({ kind: "name", blueprint: s.blueprint, title: `Clone "${s.title}"` })}
                >
                  ⬇ Clone
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {dialog?.kind === "name" && (
        <PromptDialog
          title={dialog.title}
          label="Project name"
          placeholder="my-cool-app"
          confirmText="Create"
          onSubmit={(name) => createAndOpen(name, dialog.blueprint)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ProjectCard({ project, busy, onOpen }: { project: ProjectInfo; busy: boolean; onOpen: () => void }) {
  return (
    <button className="project-card" onClick={onOpen} disabled={busy}>
      <span className="bp-emoji">📦</span>
      <span className="bp-title">{project.name}</span>
      <span className="muted small">{project.entryCount} items · {relTime(project.lastModifiedMs)}</span>
      <span className="open-hint">{busy ? "Opening…" : "Open →"}</span>
    </button>
  );
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
