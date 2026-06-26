# Fix Plan v2 (post-audit) — home-prompt→agent, wrong-project-on-open, broken templates

Reconciled after a no-mercy Haiku audit + my own URL verification. Corrections from v1 are
called out. No code written yet — awaiting approval.

## Bug 1 — Home "big box" prompt never reaches the agent (becomes preview text)
**Root cause (CONFIRMED):** `web/src/lib/provision.ts → provisionBlankProject(idea)` slugifies the
idea into a name, bakes it into the starter page heading via `blankFiles(idea)`, opens the IDE, and
NEVER sends it to the agent → it renders as static preview text.

**Fix:**
- After `enterIde(name, root)`, when `idea.trim()` is non-empty, call `sendPrompt(idea)`.
- `sendPrompt` (agent.ts) ALREADY awaits a project re-open before dispatching (lines 38–46), and the
  project was just opened, so `daemon.openedProject === name` → no race. (Audit claimed it doesn't
  await — that's WRONG; the await is on line 39 before agentPrompt on line 46.)
- Guard: only auto-fire when `daemon.agentReady`; otherwise prefill the agent input box with the
  idea so it's never lost.
- Make `blankFiles` neutral (generic title, not the user's idea) so the preview isn't mistaken for
  "the idea was printed."
- UX note: entering the IDE also auto-opens the first-run tour — suppress the tour on this auto-build
  path (or let the agent run behind it). Decide during impl.

## Bug 2 — Opening a project opens the wrong / empty one
**Confirmed facts:**
- `open_project` (server.ts ~481) → `resolveProject` (validates NAME only, no existence check) →
  `buildTree(dir)`; `buildTree` does `fs.stat` first (workspace.ts:34) → **throws ENOENT on a
  missing dir** → request rejects with a generic error. So opening a phantom ERRORS (it does not
  silently open a random one).
- The "My Projects" list (Dashboard.ProjectsPanel ~216–236) merges THREE sources: the
  **browser-global** localStorage index (`projectsLocal.ts` key `"neondeck.projects"`, NOT scoped by
  user), the daemon's real on-disk list, and Firestore. Local + Firestore persist across deploys,
  but Render free wipes `/data` on every redeploy/sleep → the list shows phantom projects.
- **Reconnect race (CONFIRMED by audit):** App.tsx ~105 re-opens `s.activeProject` on every
  (re)connect. ProjectsPanel.open awaits `daemon.openProject(name)` BEFORE `setActiveProject(name)`,
  so a reconnect firing mid-click re-opens the PREVIOUS project — a real "wrong project" path.

**Exact "random project" mechanism:** still needs ONE live reproduction to confirm which path the
user hits (phantom-open-error vs reconnect-race vs stale persisted activeProject). The fixes below
close ALL of them, so we fix regardless — but we reproduce first to confirm before/after.

**Fix:**
1. `open_project`: add an explicit `fs.existsSync(dir)` check → return a precise
   `project_not_found` error (don't let buildTree throw a generic one).
2. Client: on `project_not_found`, prune that name from the local index (`removeLocalProject`) and
   show a clear toast — but ONLY after confirming it's absent from the daemon (don't nuke a record
   the daemon just hasn't listed yet).
3. Make the daemon the **source of truth** for the list: render the daemon's real projects; show
   local/Firestore-only names as "not on this server" (greyed / "recreate"), not as plain openable
   rows.
4. Bind the IDE to the RETURNED `workspaceName` from `project_opened` (assert it equals the request).
5. Kill the reconnect race: while a click-open is in flight, don't let the App reconnect effect
   re-open a different `activeProject` (e.g., set `activeProject` optimistically before the await, or
   guard the reconnect re-open with an "opening" flag).
6. Scope the localStorage index per-user (prefix key with `userId`) or clear it on sign-out, so it
   can't leak another user's / another deploy's phantoms.

## Bug 3 — "Half the templates don't work"
**CORRECTION (v1 was wrong):** `threejs-cube` is NOT broken — I fetched
`https://unpkg.com/three@0.160.0/build/three.min.js` and it returns the real library (with a
"deprecated, removed in a future version" banner). So the CDN works at the pinned 0.160.0.

**Re-assessment:** All 12 templates are either pure static or CDN-based and SHOULD render via the
built-in static server (which serves `.jsx` as text/javascript, staticServer.ts:38). So the most
likely reason "half don't work" is **Bug 2** — launching a template lands you in the wrong/empty
project, so the template *looks* broken. Fixing Bug 2 likely fixes most of this.

**Still worth doing:**
- **Actually launch & eyeball all 12** (run the static server locally per template, open the preview,
  watch the JS console). This is the only way to know for real — no more guessing.
- Harden the two fragile ones:
  - `react-matrix`: external `<script type="text/babel" src="app.jsx">` can silently no-op if Babel
    isn't ready. Inline the JSX into index.html (most robust) or add explicit `data-presets`.
  - `threejs-cube`: works today but on a deprecated path — optionally migrate to an importmap +
    `three.module.js` to future-proof. Low priority.
- Drop the stray `README.md` the `blank` blueprint seeds (projects.ts:48) so template/blank projects
  aren't littered with it.

## Regression guards (standing rule)
- Don't change open/run/agent happy paths beyond the targeted fixes; no fragile fallbacks.
- localStorage pruning must be conservative (only after daemon confirms absence).
- Daemon-as-source-of-truth must not hide a freshly-created local project the daemon already has.
- Re-test end-to-end on a single-port local run before pushing.

## Verification checklist
1. `tsc --noEmit` clean (web + daemon); `npm run build` green.
2. Home: type idea → IDE opens → agent starts building it; preview is NOT just the idea text.
3. My Projects: list matches the daemon; open opens EXACTLY the clicked project, or a precise
   not-found; reproduce the original wrong-project bug and confirm it's gone.
4. Launch all 12 templates → each renders (console clean); react-matrix verified specifically.
5. Existing flows (Run, edit, agent, share gating, tour) still work.

## Audit scorecard (what was right/wrong)
- Reconnect race — audit CONFIRMED it; v1 only listed it as a hypothesis. ADOPTED.
- localStorage global (not per-user) — audit CONFIRMED. ADOPTED (scope per-user).
- `open_project` existence check location — audit specified it. ADOPTED.
- three.js "broken" — BOTH v1 (404) and audit reasoning were sloppy; I verified: file EXISTS at
  0.160.0. CORRECTED.
- sendPrompt "doesn't await re-open" — audit WRONG; it does (agent.ts:39). NOTED.
