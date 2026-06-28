import { useEffect, useState } from "react";
import { formatTokens, getTier, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { listLocalProjects, recordLocalProject, removeLocalProject } from "../lib/projectsLocal";
import { TEMPLATES, type Template } from "../lib/templates";
import { provisionBlankProject, provisionTemplate } from "../lib/provision";
import { ThemeMenu } from "./ThemeMenu";
import { AccountBar } from "./AccountBar";
import { PlanCards } from "./PlanCards";
import { BRAND_MARK, BRAND_LABEL } from "../lib/brand";

/**
 * Replit-style home portal — the default landing surface.
 *
 *   ┌────┬───────────────────────────────────────────────┐
 *   │ 🏠 │   What are you building today?  [Create]       │
 *   │ 📁 │                                                │
 *   │ 🔥 │   ▢ ▢ ▢ ▢   12 glowing template cards          │
 *   │ 💳 │   ▢ ▢ ▢ ▢                                       │
 *   └────┴───────────────────────────────────────────────┘
 *
 * Pure front-end: every action provisions a workspace (daemon proxy when one is
 * connected, in-browser mock otherwise) and transitions into the IDE.
 */

type Tab = "home" | "projects" | "templates" | "billing";

const NAV: { id: Tab; icon: string; label: string }[] = [
  { id: "home", icon: "🏠", label: "Home" },
  { id: "projects", icon: "📁", label: "My Projects" },
  { id: "templates", icon: "🔥", label: "Templates" },
  { id: "billing", icon: "💳", label: "Billing" },
];

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("home");

  return (
    <div className="dashboard">
      <aside className="dash-sidebar">
        <div className="dash-brand" title={BRAND_LABEL}>
          {BRAND_MARK}
        </div>
        <nav className="dash-nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`dash-tab ${tab === n.id ? "active" : ""}`}
              onClick={() => setTab(n.id)}
              title={n.label}
            >
              <span className="dash-tab-icon">{n.icon}</span>
              <span className="dash-tab-label">{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="dash-main">
        <div className="dash-glow" aria-hidden="true" />
        <header className="dash-header">
          <span className="dash-title">{NAV.find((n) => n.id === tab)?.label}</span>
          <div className="dash-header-right">
            <ThemeMenu />
            <AccountBar />
          </div>
        </header>

        <div className="dash-content">
          {tab === "home" && <HomePanel onSeeAll={() => setTab("templates")} />}
          {tab === "projects" && <ProjectsPanel onCreate={() => setTab("home")} />}
          {tab === "templates" && <TemplatesPanel />}
          {tab === "billing" && <BillingPanel />}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------ Home ------------------------------ */

function HomePanel({ onSeeAll }: { onSeeAll: () => void }) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await provisionBlankProject(idea);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dash-home">
      <section className="hero">
        <h1 className="hero-title">What are you building today?</h1>

        <div className="prompt-box">
          <textarea
            className="prompt-input"
            placeholder="Describe your idea… e.g. “a neon to-do app with drag-and-drop columns”"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") create();
            }}
            rows={3}
          />
          <button className="create-project-btn" onClick={create} disabled={busy}>
            {busy ? "Provisioning isolated environment…" : "Create Project →"}
          </button>
        </div>
        {error && <div className="auth-error dash-provision-error">⚠️ {error}</div>}

        <p className="hero-subtext">
          Type your idea from a blank slate—NeonDeck will provision an isolated
          environment and scaffold your stack using Neon Agent.
        </p>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>🔥 Or start from a template</h2>
          <button className="btn-ghost sm" onClick={onSeeAll}>
            View all →
          </button>
        </div>
        <TemplateGrid />
      </section>
    </div>
  );
}

/* --------------------------- Template grid --------------------------- */

function TemplateGrid() {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function launch(t: Template) {
    if (busyId) return;
    setBusyId(t.id);
    setError(null);
    try {
      await provisionTemplate(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <div className="auth-error dash-provision-error">⚠️ {error}</div>}
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <TemplateCard key={t.id} template={t} busy={busyId === t.id} onLaunch={() => launch(t)} />
        ))}
      </div>
    </>
  );
}

function TemplateCard({
  template,
  busy,
  onLaunch,
}: {
  template: Template;
  busy: boolean;
  onLaunch: () => void;
}) {
  return (
    <button className="template-card glass" onClick={onLaunch} disabled={busy}>
      <span className="template-emoji">{template.emoji}</span>
      <span className="template-title">{template.title}</span>
      <span className="template-desc muted">{template.desc}</span>
      <span className="launch-btn">{busy ? "Launching…" : "Launch Sandbox →"}</span>
    </button>
  );
}

/* ---------------------------- My Projects ---------------------------- */

interface ProjectCard {
  name: string;
  subtitle: string;
}

function ProjectsPanel({ onCreate }: { onCreate: () => void }) {
  const transport = useStore((s) => s.transport);
  const userId = useStore((s) => s.session?.userId ?? null);
  const token = useStore((s) => s.session?.token ?? null);
  const projectsVersion = useStore((s) => s.projectsVersion);
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingName, setOpeningName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // The daemon is the SOURCE OF TRUTH: only projects that actually exist on
      // the server are shown (and therefore openable). We enrich their subtitles
      // from the local index (friendly idea/template names). This stops phantom
      // projects — names left in localStorage/Firestore after a diskless redeploy
      // wiped /data — from appearing as openable and sending you to the wrong one.
      const localByName = new Map(listLocalProjects().map((p) => [p.name, p]));
      const subtitleFor = (name: string, fallback: string) => {
        const l = localByName.get(name);
        return l ? (l.template ? `🔥 ${l.template}` : l.idea || fallback) : fallback;
      };

      if (transport === "daemon" && daemon.connected) {
        try {
          const list = await daemon.listProjects();
          const cards = list.map((x) => ({
            name: x.name,
            subtitle: subtitleFor(x.name, `${x.entryCount} items`),
          }));
          if (alive) setProjects(cards);
          return;
        } catch {
          /* fall through to the local index below */
        }
      }
      // Not connected: show the local history so the tab isn't empty (opening
      // one will prompt to reconnect).
      const local = listLocalProjects().map((p) => ({
        name: p.name,
        subtitle: p.template ? `🔥 ${p.template}` : p.idea || "Project",
      }));
      if (alive) setProjects(local);
    })();
    return () => {
      alive = false;
    };
  }, [transport, userId, token, projectsVersion]);

  async function open(name: string) {
    if (openingName) return;
    setOpeningName(name);
    setError(null);
    const s = useStore.getState();
    // Optimistic: set the target NOW so a concurrent reconnect re-opens THIS
    // project, not whatever was open before (the old "wrong project" race).
    s.setActiveProject(name);
    try {
      if (!daemon.connected) throw new Error("Not connected to the workspace daemon — reconnect and try again.");
      // Bind to the workspace the daemon ACTUALLY opened, not the requested name.
      const { workspaceName, root } = await daemon.openProject(name);
      recordLocalProject({ name: workspaceName, transport });
      s.setActiveProject(workspaceName);
      s.setTree(root);
      s.setOpenFile("", "");
      s.setPreview(null, null); // clear any prior project's running preview
      s.loadChatForProject(workspaceName);
      s.setView("ide");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("PROJECT_NOT_FOUND")) {
        // The server no longer has it (diskless redeploy) — prune the phantom so
        // it stops showing, and refresh the list.
        removeLocalProject(name);
        s.bumpProjects();
        setError(`"${name}" no longer exists on the server — removed it from your list.`);
      } else {
        setError(`Couldn't open "${name}": ${msg}`);
      }
      setOpeningName(null);
    }
  }

  if (projects === null) {
    return (
      <p className="muted dash-pad">
        <span className="spinner" /> Loading projects…
      </p>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="dash-empty glass">
        <span className="dash-empty-emoji">📁</span>
        <h3>No projects yet</h3>
        <p className="muted">Spin up your first project from the Home tab or pick a template.</p>
        <button className="create-project-btn slim" onClick={onCreate}>
          + New Project
        </button>
      </div>
    );
  }

  return (
    <>
      {error && <div className="auth-error dash-provision-error">⚠️ {error}</div>}
      <div className="card-grid">
        {projects.map((p) => (
          <button
            key={p.name}
            className="project-card"
            onClick={() => open(p.name)}
            disabled={openingName !== null}
          >
            <span className="bp-emoji">📦</span>
            <span className="bp-title">{p.name}</span>
            <span className="muted small">{p.subtitle}</span>
            <span className="open-hint">{openingName === p.name ? "Opening…" : "Open →"}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ----------------------------- Templates ----------------------------- */

function TemplatesPanel() {
  return (
    <div className="dash-section">
      <p className="muted dash-templates-intro">
        12 instant sandboxes — click any card to scaffold it and drop straight into the editor.
      </p>
      <TemplateGrid />
    </div>
  );
}

/* ------------------------------ Billing ------------------------------ */

function BillingPanel() {
  const tier = useStore((s) => s.tier());
  const usage = useStore((s) => s.usage);
  const transport = useStore((s) => s.transport);
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const setUsage = useStore((s) => s.setUsage);
  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Real Stripe Checkout runs through our own daemon (POST /api/create-checkout-
  // session) — no Firebase Blaze extension. It's available whenever the daemon
  // is connected; the daemon derives the userId from the verified Firebase ID
  // token and maps the tier to its configured Stripe price id.
  const daemonReady = transport === "daemon" && daemon.connected;

  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    // Daemon checkout: create the session server-side, then hand the browser off
    // to the returned hosted Stripe Checkout URL.
    if (daemonReady) {
      try {
        const url = await daemon.checkout(t);
        window.location.href = url; // redirect to Stripe Checkout
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyTier(null);
      }
      return;
    }
    // No daemon (in-browser session) → simulate the upgrade locally so billing
    // never dead-ends (mirrors the SubscriptionModal flow).
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
    }, 1400);
  }

  // Move to a LOWER tier (incl. Free). Daemon downgrades the real/mock
  // subscription server-side; in browser mode it adjusts the tier locally.
  async function downgrade(t: Tier) {
    if (t === 0 && !window.confirm("Switch to the Free plan? You'll lose paid features.")) return;
    setBusyTier(t);
    setError(null);
    if (daemonReady) {
      try {
        setUsage(await daemon.changeTier(t));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyTier(null);
      }
      return;
    }
    setTimeout(() => {
      simulateUpgrade(t);
      setBusyTier(null);
    }, 600);
  }

  const cfg = getTier(tier);
  const pct =
    usage && usage.tokensLimit > 0
      ? Math.min(100, Math.round((usage.tokensUsed / usage.tokensLimit) * 100))
      : 0;

  return (
    <div className="dash-billing">
      <div className="dash-billing-summary glass">
        <div className="dash-billing-plan">
          <span className="muted small">Current plan</span>
          <span className={`tier-badge tier-${cfg.key}`}>{cfg.name}</span>
        </div>
        {usage && (
          <div className="dash-usage">
            <div className="usage-meter-bar wide">
              <span className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">
              {formatTokens(usage.tokensUsed)} / {formatTokens(usage.tokensLimit)} agent tokens this month
            </span>
          </div>
        )}
      </div>

      {error && <div className="auth-error">⚠️ {error}</div>}

      <PlanCards
        currentTier={tier}
        billingEnabled
        busyTier={busyTier}
        onChoose={choose}
        onDowngrade={downgrade}
        simulated={!daemonReady}
      />
    </div>
  );
}
