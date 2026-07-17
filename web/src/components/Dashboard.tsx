import { useEffect, useState } from "react";
import { getTier, maxProjectsForTier, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon, downloadProjectZip } from "../lib/daemonClient";
import { getIdToken } from "../lib/firebaseClient";
import {
  listLocalProjects,
  recordLocalProject,
  removeLocalProject,
  type LocalProject,
} from "../lib/projectsLocal";
import { TEMPLATES, type Template } from "../lib/templates";
import { provisionBlankProject, provisionTemplate } from "../lib/provision";
import { AccountBar } from "./AccountBar";
import { SettingsMenu } from "./SettingsMenu";
import { IntervalToggle, PlanCards } from "./PlanCards";
import { CheckoutOverlay } from "./CheckoutOverlay";
import type { BillingInterval } from "@ide/shared";
import { PLATFORM_NAME, BRAND_LABEL } from "../lib/brand";

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
          {PLATFORM_NAME[0]}
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
        {/* Bottom-of-rail account launcher (Replit-style). Same pop-up menu as
            the IDE's bottom-left; opens "a bunch of stuff". */}
        <SettingsMenu variant="rail" />
      </aside>

      <main className="dash-main">
        <header className="dash-header">
          <span className="dash-title">{NAV.find((n) => n.id === tab)?.label}</span>
          <div className="dash-header-right">
            <AccountBar />
          </div>
        </header>

        <div className="dash-content">
          {tab === "home" && <HomePanel go={setTab} />}
          {tab === "projects" && <ProjectsPanel onCreate={() => setTab("home")} />}
          {tab === "templates" && <TemplatesPanel />}
          {tab === "billing" && <BillingPanel />}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------ Home ------------------------------ */

/** "3h ago"-style label for the recent-projects rail. */
function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Whole days/hours remaining until a lifecycle deadline (floor of 1 so the
 *  UI never shows "0d" while the action is still possible). */
const daysLeft = (ms?: number) => Math.max(1, Math.ceil(((ms ?? 0) - Date.now()) / 86_400_000));
const hoursLeft = (ms?: number) => Math.max(1, Math.ceil(((ms ?? 0) - Date.now()) / 3_600_000));

/**
 * Open an existing project by name and enter the IDE. Shared by the Home
 * recent-projects rail and the My Projects tab. Returns an error message on
 * failure (pruning phantom projects the server no longer has), null on success.
 */
async function openExistingProject(name: string): Promise<string | null> {
  const s = useStore.getState();
  // Optimistic: set the target NOW so a concurrent reconnect re-opens THIS
  // project, not whatever was open before (the old "wrong project" race).
  s.setActiveProject(name);
  try {
    if (!daemon.connected)
      throw new Error("Not connected to the workspace daemon — reconnect and try again.");
    // Bind to the workspace the daemon ACTUALLY opened, not the requested name.
    const { workspaceName, root } = await daemon.openProject(name);
    recordLocalProject({ name: workspaceName, transport: "daemon" });
    s.setActiveProject(workspaceName);
    s.setTree(root);
    s.setOpenFile("", "");
    s.setPreview(null, null); // clear any prior project's running preview
    s.loadChatForProject(workspaceName);
    s.setView("ide");
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PROJECT_ARCHIVED")) {
      // Still exists (archived) — do NOT prune the local index.
      return `"${name}" is archived — restore it (or download a .zip) from My Projects first.`;
    }
    if (msg.includes("PROJECT_NOT_FOUND")) {
      // The server no longer has it (diskless redeploy) — prune the phantom so
      // it stops showing, and refresh the list.
      removeLocalProject(name);
      s.bumpProjects();
      return `"${name}" no longer exists on the server — removed it from your list.`;
    }
    return `Couldn't open "${name}": ${msg}`;
  }
}

function HomePanel({ go }: { go: (tab: Tab) => void }) {
  // Prefill with an idea typed on the public landing page before sign-up (the
  // stash is cleared in an effect, not the initializer — StrictMode double-
  // invokes initializers, which would eat the value).
  const [idea, setIdea] = useState(() => sessionStorage.getItem("kryct.pendingIdea") ?? "");
  useEffect(() => {
    sessionStorage.removeItem("kryct.pendingIdea");
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = useStore((s) => s.session?.email ?? null);
  const tier = useStore((s) => s.tier());
  const setView = useStore((s) => s.setView);
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const projectsVersion = useStore((s) => s.projectsVersion);

  // Recent projects (local index, newest first). Opening prunes phantoms.
  const [recent, setRecent] = useState<LocalProject[]>([]);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    setRecent(
      [...listLocalProjects()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 4),
    );
  }, [projectsVersion]);

  async function openRecent(name: string) {
    if (openingName) return;
    setOpeningName(name);
    setOpenError(null);
    const err = await openExistingProject(name);
    if (err) {
      setOpenError(err);
      setRecent([...listLocalProjects()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 4));
      setOpeningName(null);
    }
  }

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

  const hour = new Date().getHours();
  const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = email ? email.split("@")[0] : null;
  const cfg = getTier(tier);

  return (
    <div className="dash-home">
      <section className="hero">
        <p className="dash-greeting muted">
          Good {daypart}
          {firstName ? `, ${firstName}` : ""} 👋
        </p>
        <h1 className="hero-title">What are you building today?</h1>

        <div className="prompt-box">
          <textarea
            className="prompt-input"
            placeholder="Describe your idea… e.g. “a kanban board with drag-and-drop columns”"
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
          Type your idea from a blank slate—Kryct will provision an isolated
          environment and scaffold your stack using Kryct Agent.
        </p>
      </section>

      {/* quick actions */}
      <section className="dash-quick">
        {(
          [
            ["📁", "My Projects", "Open something you've built", () => go("projects")],
            ["🔥", "Templates", "12 one-click starters", () => go("templates")],
            ["💳", "Billing & plans", "Manage your subscription", () => go("billing")],
            ["⚙️", "Settings", "Account, GitHub sync & Dev API", () => setView("settings")],
          ] as const
        ).map(([emoji, title, desc, action]) => (
          <button key={title} className="dash-quick-card glass" onClick={action}>
            <span className="dash-quick-emoji">{emoji}</span>
            <span className="dash-quick-title">{title}</span>
            <span className="muted small">{desc}</span>
          </button>
        ))}
      </section>

      {/* recent projects + plan/usage side by side */}
      <div className="dash-home-row">
        <section className="dash-card glass dash-recent">
          <div className="dash-card-head">
            <h2>🕘 Recent projects</h2>
            <button className="btn-ghost sm" onClick={() => go("projects")}>
              View all →
            </button>
          </div>
          {openError && <div className="auth-error dash-provision-error">⚠️ {openError}</div>}
          {recent.length === 0 ? (
            <p className="muted small dash-card-empty">
              Nothing yet — describe an idea above or launch a template, and your projects
              will show up here.
            </p>
          ) : (
            <div className="dash-recent-list">
              {recent.map((p) => (
                <button
                  key={p.name}
                  className="dash-recent-row"
                  onClick={() => openRecent(p.name)}
                  disabled={openingName !== null}
                >
                  <span className="dash-recent-emoji">📦</span>
                  <span className="dash-recent-meta">
                    <span className="dash-recent-name">{p.name}</span>
                    <span className="muted small">
                      {p.template ? `🔥 ${p.template}` : p.idea || "Blank project"}
                    </span>
                  </span>
                  <span className="muted small dash-recent-time">{timeAgo(p.createdAtMs)}</span>
                  <span className="open-hint">
                    {openingName === p.name ? "Opening…" : "Open →"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="dash-card glass dash-plan-card">
          <div className="dash-card-head">
            <h2>⚡ Your plan</h2>
            <span className={`tier-badge tier-${cfg.key}`}>{cfg.name}</span>
          </div>
          <ul className="dash-plan-facts">
            <li>{cfg.tokenLabel} of agent usage each month</li>
            <li>Up to {maxProjectsForTier(tier)} project slots</li>
            <li>Full AI agent — every effort level</li>
            <li>
              {cfg.canPublish
                ? "Publish & share public live URLs"
                : "Publish publicly — first 30 days included"}
            </li>
          </ul>
          <div className="dash-card-actions">
            <button className="btn-ghost sm" onClick={() => go("billing")}>
              Manage plan
            </button>
            {tier < 2 && (
              <button className="btn-neon sm" onClick={() => setSubscriptionModalOpen(true)}>
                ⚡ Upgrade
              </button>
            )}
          </div>
        </section>
      </div>

      {/* explore the platform */}
      <section className="dash-section">
        <div className="dash-section-head">
          <h2>✨ Explore</h2>
        </div>
        <div className="dash-explore">
          <button className="dash-explore-card glass" onClick={() => setView("settings")}>
            <span className="dash-explore-emoji">🧩</span>
            <span className="dash-explore-title">Developer API</span>
            <span className="muted small">
              Run the agent from your own code — pay-per-use API keys in Settings → Dev.
            </span>
          </button>
          <button className="dash-explore-card glass" onClick={() => setView("settings")}>
            <span className="dash-explore-emoji">🐙</span>
            <span className="dash-explore-title">GitHub sync</span>
            <span className="muted small">
              Back up every project to your own GitHub, automatically, on every run.
            </span>
          </button>
          <button className="dash-explore-card glass" onClick={() => go("projects")}>
            <span className="dash-explore-emoji">🌐</span>
            <span className="dash-explore-title">Publish & share</span>
            <span className="muted small">
              {cfg.canPublish
                ? "Put an app on a public live URL — open a project and hit Share."
                : "Put an app on a public live URL — free for your first 30 days."}
            </span>
          </button>
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>🔥 Or start from a template</h2>
          <button className="btn-ghost sm" onClick={() => go("templates")}>
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
  /** Snapshot inactivity lifecycle (absent = active). */
  state?: "warned" | "archived";
  archiveAtMs?: number;
  deleteAtMs?: number;
}

function ProjectsPanel({ onCreate }: { onCreate: () => void }) {
  const transport = useStore((s) => s.transport);
  const userId = useStore((s) => s.session?.userId ?? null);
  const token = useStore((s) => s.session?.token ?? null);
  const projectsVersion = useStore((s) => s.projectsVersion);
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

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
            state: x.state,
            archiveAtMs: x.archiveAtMs,
            deleteAtMs: x.deleteAtMs,
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
    const err = await openExistingProject(name);
    if (err) {
      setError(err);
      setOpeningName(null);
    }
  }

  async function restore(name: string) {
    if (busyAction) return;
    setBusyAction(`restore:${name}`);
    setError(null);
    try {
      await daemon.restoreProject(name);
      useStore.getState().bumpProjects(); // refresh — the card returns to normal
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function downloadZip(name: string) {
    if (busyAction) return;
    setBusyAction(`zip:${name}`);
    setError(null);
    try {
      const blob = await downloadProjectZip(name, await getIdToken());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
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
        {projects.map((p) =>
          p.state === "archived" ? (
            // Archived: not openable — only Restore or a .zip export remain.
            <div key={p.name} className="project-card archived">
              <span className="bp-emoji">🗄️</span>
              <span className="bp-title">{p.name}</span>
              <span className="muted small">
                Archived — deletes in ~{hoursLeft(p.deleteAtMs)}h
              </span>
              <span className="proj-card-actions">
                <button
                  className="proj-btn"
                  onClick={() => restore(p.name)}
                  disabled={busyAction !== null}
                >
                  {busyAction === `restore:${p.name}` ? "Restoring…" : "Restore"}
                </button>
                <button
                  className="proj-btn"
                  onClick={() => downloadZip(p.name)}
                  disabled={busyAction !== null}
                >
                  {busyAction === `zip:${p.name}` ? "Preparing…" : "Download .zip"}
                </button>
              </span>
            </div>
          ) : (
            <button
              key={p.name}
              className="project-card"
              onClick={() => open(p.name)}
              disabled={openingName !== null}
            >
              <span className="bp-emoji">📦</span>
              <span className="bp-title">
                {p.name}
                {p.state === "warned" && (
                  <span className="proj-pill warn">archives in {daysLeft(p.archiveAtMs)}d</span>
                )}
              </span>
              <span className="muted small">{p.subtitle}</span>
              <span className="open-hint">{openingName === p.name ? "Opening…" : "Open →"}</span>
            </button>
          ),
        )}
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
  const transport = useStore((s) => s.transport);
  const simulateUpgrade = useStore((s) => s.simulateUpgrade);
  const setUsage = useStore((s) => s.setUsage);
  const [busyTier, setBusyTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const [checkoutSession, setCheckoutSession] = useState<{
    tier: Tier;
    interval: BillingInterval;
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  // Real Stripe Checkout runs through our own daemon (POST /api/create-checkout-
  // session) — no Firebase Blaze extension. It's available whenever the daemon
  // is connected; the daemon derives the userId from the verified Firebase ID
  // token and maps the tier + interval to its configured Stripe price id.
  const daemonReady = transport === "daemon" && daemon.connected;

  async function choose(t: Tier) {
    setBusyTier(t);
    setError(null);
    // Daemon checkout: real Stripe returns a clientSecret for the in-page
    // embedded checkout; the mock fallback returns a URL we simply follow.
    if (daemonReady) {
      try {
        const start = await daemon.checkout(t, billingInterval);
        if (start.clientSecret && start.publishableKey) {
          setCheckoutSession({
            tier: t,
            interval: billingInterval,
            clientSecret: start.clientSecret,
            publishableKey: start.publishableKey,
          });
          setBusyTier(null);
        } else if (start.url) {
          window.location.href = start.url;
        }
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

  return (
    <div className="dash-billing">
      <div className="dash-billing-summary glass">
        <div className="dash-billing-plan">
          <span className="muted small">Current plan</span>
          <span className={`tier-badge tier-${cfg.key}`}>{cfg.name}</span>
        </div>
        <span className="muted small">
          Includes {cfg.tokenLabel} of agent usage each month · usage fluctuates
        </span>
      </div>

      {error && <div className="auth-error">⚠️ {error}</div>}

      <IntervalToggle value={billingInterval} onChange={setBillingInterval} />

      {checkoutSession && (
        <CheckoutOverlay
          tier={checkoutSession.tier}
          interval={checkoutSession.interval}
          clientSecret={checkoutSession.clientSecret}
          publishableKey={checkoutSession.publishableKey}
          onClose={() => setCheckoutSession(null)}
        />
      )}

      <PlanCards
        currentTier={tier}
        billingEnabled
        busyTier={busyTier}
        interval={billingInterval}
        onChoose={choose}
        onDowngrade={downgrade}
        simulated={!daemonReady}
      />
    </div>
  );
}
