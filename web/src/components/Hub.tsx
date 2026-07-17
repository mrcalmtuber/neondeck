import { useEffect, useState } from "react";
import { type Blueprint, type ProjectInfo, type Tier, getTier, maxProjectsForTier } from "@ide/shared";
import { daemon } from "../lib/daemonClient";
import { useStore } from "../lib/store";
import { PromptDialog } from "./PromptDialog";
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
  const tier = (useStore((s) => s.usage?.tier) ?? 0) as Tier;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Per-tier project SLOT cap (Free 5 / Pro 10 / Max 15). At the cap, creation is
  // blocked client-side (the daemon also enforces it) until one is deleted.
  const maxProjects = maxProjectsForTier(tier);
  const atCap = projects.length >= maxProjects;

  useEffect(() => {
    daemon.listProjects().then(setProjects).catch(console.error);
  }, [setProjects]);

  async function deleteProject(name: string) {
    if (!window.confirm(`Delete "${name}"? This permanently removes it and can't be undone.`)) return;
    setBusy(name);
    try {
      await daemon.deleteProject(name);
      setProjects(await daemon.listProjects());
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function openProject(name: string) {
    setBusy(name);
    try {
      const { root } = await daemon.openProject(name);
      useStore.getState().setActiveProject(name);
      useStore.getState().setTree(root);
      useStore.getState().setOpenFile("", "");
      useStore.getState().loadChatForProject(name);
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
          <button
            className="btn-primary"
            disabled={atCap}
            title={atCap ? `You've reached your ${getTier(tier).name} plan's ${maxProjects}-project limit` : undefined}
            onClick={() => setDialog({ kind: "name", blueprint: "blank", title: "Create Brand New Blank Project" })}
          >
            ➕ Create Brand New Blank Project
          </button>
          <AccountBar />
        </div>
      </header>

      <div className="hub-body">
        <section className="hub-section">
          <h2>
            📁 My Local Projects{" "}
            <span className="muted small">· {projectsRootName || "workspace"}</span>
            <span className={`project-slots${atCap ? " full" : ""}`}>
              {projects.length} / {maxProjects} projects
            </span>
          </h2>
          {atCap && (
            <p className="cap-note">
              You've reached your {getTier(tier).name} plan's {maxProjects}-project limit — delete one
              to make room, or upgrade for more.
            </p>
          )}
          {projects.length === 0 ? (
            <p className="muted">No projects yet — spin one up from a blueprint below.</p>
          ) : (
            <div className="card-grid">
              {projects.map((p) => (
                <ProjectCard
                  key={p.name}
                  project={p}
                  busy={busy === p.name}
                  onOpen={() => openProject(p.name)}
                  onDelete={() => deleteProject(p.name)}
                />
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
                disabled={atCap}
                title={atCap ? `Project limit reached (${maxProjects})` : undefined}
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
                  disabled={atCap}
                  title={atCap ? `Project limit reached (${maxProjects})` : undefined}
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

function ProjectCard({
  project,
  busy,
  onOpen,
  onDelete,
}: {
  project: ProjectInfo;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="project-card-wrap">
      <button className="project-card" onClick={onOpen} disabled={busy}>
        <span className="bp-emoji">📦</span>
        <span className="bp-title">{project.name}</span>
        <span className="muted small">{project.entryCount} items · {relTime(project.lastModifiedMs)}</span>
        <span className="open-hint">{busy ? "Opening…" : "Open →"}</span>
      </button>
      <button
        className="project-del"
        onClick={onDelete}
        disabled={busy}
        title="Delete project"
        aria-label={`Delete ${project.name}`}
      >
        🗑
      </button>
    </div>
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
