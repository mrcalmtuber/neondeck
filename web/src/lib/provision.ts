import { daemon } from "./daemonClient";
import { useStore } from "./store";
import { sendPrompt } from "./agent";
import { saveProjectRecord } from "./projectsService";
import { recordLocalProject } from "./projectsLocal";
import type { Template } from "./templates";

/** Record a freshly provisioned project so it shows in the Projects tab. Always
 *  writes the local-first index (works even if Firestore is blocked) and, for a
 *  real signed-in user, mirrors it to Firestore. Best-effort, never blocks. */
function recordProject(name: string, opts: { idea?: string; template?: string }): void {
  const s = useStore.getState();
  recordLocalProject({
    name,
    idea: opts.idea,
    template: opts.template ?? null,
    transport: s.transport,
  });
  s.bumpProjects();
  const userId = s.session?.userId;
  if (userId) void saveProjectRecord({ userId, name, idea: opts.idea, template: opts.template ?? null });
}

/**
 * Workspace provisioning — the bridge between the Dashboard portal and the IDE.
 *
 * Two entry points are exposed, both daemon-only (the daemon is the sole
 * transport — there is no in-browser fallback):
 *   • provisionBlankProject(idea) — the giant "Create Project" prompt. Picks a
 *     unique name, scaffolds a blank project on the daemon, seeds a starter page,
 *     and opens it in the IDE.
 *   • provisionTemplate(t)        — a one-click template card. Seeds the template
 *     files into a daemon project (one per template id) and opens it.
 *
 * On any daemon failure these THROW — the caller surfaces the error and stays on
 * the dashboard. They never silently degrade into a stale workspace.
 */

/** Turn a free-text idea into a filesystem-safe, readable project slug. */
function slugify(idea: string): string {
  const base = idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || `kryct-${Date.now().toString(36)}`;
}

/** Pick a project name that doesn't collide with an existing one: base, base-2,
 *  base-3, … (Replit-style). Falls back to a timestamped name if listing fails. */
async function uniqueProjectName(base: string): Promise<string> {
  try {
    const taken = new Set((await daemon.listProjects()).map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
  } catch {
    /* listing failed — fall through to a guaranteed-unique timestamped name */
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** A tiny, self-rendering blank scaffold so a new project is never empty and is
 *  immediately runnable (the built-in static "Run" needs an index.html). */
function blankFiles(): Record<string, string> {
  // Neutral starter — the user's idea drives the AGENT, not this page's heading.
  const title = "My Kryct Project";
  return {
    "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<main class="card">
<h1>◆ <span class="glow">${title}</span></h1>
<p>Blank slate provisioned. Open <span class="pink">main.js</span> or ask
Kryct Agent to scaffold your stack.</p>
<button id="ping">It works →</button>
</main>
<script src="main.js"></script>
</body>
</html>
`,
    "styles.css": `:root{--bg:#0b0f19;--pink:#ff007f;--cyan:#00f0ff;--text:#e8f0ff;}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;
font-family:'Segoe UI',system-ui,sans-serif;color:var(--text);text-align:center;
background:radial-gradient(circle at 50% 0%,#161c2e,#070a12)}
h1{margin:0 0 12px;font-size:30px;text-shadow:0 0 18px var(--cyan)}
.glow{color:var(--cyan)}.pink{color:var(--pink)}
.card{background:rgba(18,24,38,.7);border:1px solid #20304d;border-radius:16px;
padding:28px;backdrop-filter:blur(8px);box-shadow:0 0 30px rgba(255,0,127,.14)}
button{margin-top:16px;cursor:pointer;border:1px solid var(--cyan);background:transparent;
color:var(--cyan);padding:10px 18px;border-radius:10px;font-weight:700;
box-shadow:0 0 14px rgba(0,240,255,.35);transition:.15s}
button:hover{background:var(--cyan);color:#06121a;box-shadow:0 0 22px var(--cyan)}
`,
    "main.js": `// ${title}
// Your blank Kryct workspace — start building here.
document.getElementById("ping").addEventListener("click", (e) => {
  e.target.textContent = "🚀 building...";
});
console.log("Kryct workspace ready");
`,
  };
}

/** Drop the store into the IDE showing the daemon workspace `name` with `root`. */
function enterIde(name: string, root: import("@ide/shared").FileNode): void {
  const s = useStore.getState();
  s.setActiveProject(name);
  s.setTree(root);
  s.setOpenFile("", ""); // open with the agent (not the editor) in the left pane
  s.setPreview(null, null); // clear any prior project's running preview
  s.loadChatForProject(name);
  s.setView("ide");
}

/** Seed one of the Kryct templates on the daemon and open it in the IDE. */
export async function provisionTemplate(t: Template): Promise<void> {
  if (!daemon.connected) {
    throw new Error("Not connected to the workspace daemon — reconnect and try again.");
  }
  // Templates are one-per-id: create if new, otherwise re-seed the existing one.
  try {
    await daemon.createProject(t.id, "blank");
  } catch {
    /* a project with this id already exists — re-seed it below */
  }
  await daemon.openProject(t.id);
  for (const [path, content] of Object.entries(t.files)) {
    await daemon.manualUpdate(path, content);
  }
  const root = await daemon.listTree();
  enterIde(t.id, root);
  recordProject(t.id, { idea: t.title, template: t.id });
}

/** Provision an empty project from the giant home prompt and open it. */
export async function provisionBlankProject(idea: string): Promise<void> {
  if (!daemon.connected) {
    throw new Error("Not connected to the workspace daemon — reconnect and try again.");
  }
  const name = await uniqueProjectName(slugify(idea));
  await daemon.createProject(name, "blank");
  await daemon.openProject(name);
  // Seed a neutral starter page so the project is runnable immediately.
  for (const [path, content] of Object.entries(blankFiles())) {
    await daemon.manualUpdate(path, content);
  }
  const root = await daemon.listTree();
  enterIde(name, root);
  recordProject(name, { idea });

  // Pre-fire the idea to the agent so the workspace opens with the build already
  // underway — instead of the idea just sitting as static text in the preview.
  const task = idea.trim();
  if (task && useStore.getState().agentReady) {
    sendPrompt(task);
  }
}
