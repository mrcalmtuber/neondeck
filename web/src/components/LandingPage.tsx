import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_LABEL, PLATFORM_NAME, AGENT_NAME, SUPPORT_EMAIL } from "../lib/brand";
import { TEMPLATES } from "../lib/templates";
import {
  TIER_LIST,
  API_PRICE_LABEL,
  maxProjectsForTier,
  usd,
  yearlyPerMonthUsd,
  yearlyTotalUsd,
  type BillingInterval,
  type TierConfig,
} from "@ide/shared";

interface Props {
  /** Open the auth gateway in the given mode (top-right buttons + every CTA). */
  onAuth: (mode: "login" | "register") => void;
}

/** Key the Dashboard reads (and clears) to prefill "What are you building today?". */
const PENDING_IDEA_KEY = "kryct.pendingIdea";

/* ------------------------------------------------------------------ */
/* Hero demo content — real text, hand-tokenized (no highlighter lib). */
/* ------------------------------------------------------------------ */

type Tok = { t: "kw" | "str" | "cmt" | "fn" | "pln"; s: string };

const DEMO_CODE: Tok[][] = [
  [{ t: "cmt", s: "// app.js — kanban board" }],
  [
    { t: "kw", s: "const" },
    { t: "pln", s: " columns = [" },
    { t: "str", s: '"To do"' },
    { t: "pln", s: ", " },
    { t: "str", s: '"In progress"' },
    { t: "pln", s: ", " },
    { t: "str", s: '"Done"' },
    { t: "pln", s: "];" },
  ],
  [],
  [
    { t: "kw", s: "function" },
    { t: "fn", s: " createCard" },
    { t: "pln", s: "(title) {" },
  ],
  [
    { t: "pln", s: "  " },
    { t: "kw", s: "const" },
    { t: "pln", s: " card = document." },
    { t: "fn", s: "createElement" },
    { t: "pln", s: "(" },
    { t: "str", s: '"div"' },
    { t: "pln", s: ");" },
  ],
  [
    { t: "pln", s: "  card.className = " },
    { t: "str", s: '"card"' },
    { t: "pln", s: ";" },
  ],
  [{ t: "pln", s: "  card.textContent = title;" }],
  [
    { t: "pln", s: "  card.draggable = " },
    { t: "kw", s: "true" },
    { t: "pln", s: ";" },
  ],
  [
    { t: "pln", s: "  " },
    { t: "kw", s: "return" },
    { t: "pln", s: " card;" },
  ],
  [{ t: "pln", s: "}" }],
  [],
  [
    { t: "pln", s: "columns." },
    { t: "fn", s: "forEach" },
    { t: "pln", s: "(renderColumn);" },
  ],
];

const DEMO_BOARD: Array<{ title: string; cards: string[] }> = [
  { title: "To do", cards: ["Add dark mode", "Ship it 🚀"] },
  { title: "In progress", cards: ["Wire up drag & drop"] },
  { title: "Done", cards: ["Design the board", "Scaffold app"] },
];
const TOTAL_CARDS = DEMO_BOARD.reduce((n, c) => n + c.cards.length, 0);
/** Flat pop-in index of card i in column c. */
function cardIndex(c: number, i: number): number {
  let n = 0;
  for (let k = 0; k < c; k++) n += DEMO_BOARD[k].cards.length;
  return n + i;
}

const AGENT_REPLY =
  "Scaffolding your board — creating index.html, styles.css and app.js, then starting the dev server…";

/** "Meet the agent" blocks — one full-width row per capability, Replit-style. */
const AGENT_BLOCKS = [
  {
    id: "build",
    label: "Build",
    heading: "Ask for an app. Get an app.",
    blurb:
      "Describe the thing you want in a sentence. The agent plans it, writes every file, installs what it needs, and runs it.",
    user: "Build a habit tracker with streaks",
    agent:
      "On it — scaffolding the app, wiring streaks up to localStorage, and starting the dev server.",
    artifact: "build",
  },
  {
    id: "fix",
    label: "Fix",
    heading: "Bugs don't survive long.",
    blurb:
      "Paste an error or just say what's broken. The agent finds the cause, patches it, and re-runs your app to prove the fix.",
    user: "It crashes when I add the same habit twice",
    agent:
      "Found it — a duplicate insert in app.js. Patched the handler and re-ran the app; all good now.",
    artifact: "fix",
  },
  {
    id: "explain",
    label: "Explain",
    heading: "Understand any line of code.",
    blurb:
      "Select code anywhere in the editor and ask. Clear, plain-English explanations, right where you're reading.",
    user: "What does this function do?",
    agent:
      "It debounces saves — waiting two seconds after your last keystroke before writing the file, so the disk isn't hit on every character.",
    artifact: "explain",
  },
  {
    id: "ship",
    label: "Ship",
    heading: "From prompt to public URL.",
    blurb:
      "When it works, put it online: a permanent link, synced to GitHub, ready to send to anyone.",
    user: "Publish it so I can send it to my friends",
    agent: "Deployed. Your app is live — the link is permanent and synced to GitHub.",
    artifact: "ship",
  },
] as const;

/** Plan-comparison rows: string cells or ✓/— booleans, derived from tier config. */
const COMPARE_ROWS: Array<{ label: string; value: (t: TierConfig) => string | boolean }> = [
  { label: "Monthly usage", value: (t) => t.tokenLabel },
  { label: "Project slots", value: (t) => String(maxProjectsForTier(t.id)) },
  { label: "Full AI agent — every effort level", value: () => true },
  { label: "Real cloud workspaces (editor, shell, live preview)", value: () => true },
  { label: "GitHub sync & project backups", value: () => true },
  { label: "Publish & share public live URLs", value: (t) => t.canPublish || "First 30 days" },
  { label: "Permanent live preview links", value: (t) => t.canPublish },
  { label: "Priority resources", value: (t) => t.id === 2 },
];

/* ------------------------------------------------------------------ */
/* Developers section — typed curl + fake SSE stream (JS typewriter,   */
/* same state-machine pattern as the hero demo loop).                  */
/* ------------------------------------------------------------------ */

const DEV_CURL = `curl https://kryct.com/api/v1/runs \\
  -H "Authorization: Bearer ndk_a1b2c3d4e5f6…" \\
  -d '{ "project": "my-app", "prompt": "Add a dark mode toggle" }'`;
const DEV_RESPONSE = `{ "runId": "run_9f2c41", "status": "running" }`;
const DEV_SSE = [
  "event: step   Created src/theme.js",
  "event: step   Patched app.js — wired the toggle",
  'event: done   { "status": "completed", "filesChanged": 2 }',
];

/**
 * Demo phases: 0 reset · 1 user msg · 2 agent reply types · 3 code cascades ·
 * 4 preview builds · 5 live (hold) · 6 fade-out before the loop restarts.
 */
interface DemoState {
  phase: number;
  typed: number; // chars of AGENT_REPLY shown
  lines: number; // editor lines shown
  cards: number; // preview cards shown
}
/**
 * Public landing page — what a signed-out visitor sees first (replit.com-style
 * showcase). Pure presentation: the only actions hand off to the AuthGateway via
 * onAuth. It is its own scroll container (html/body are height:100%), so the
 * sticky nav, scroll-reveals, hero parallax and the demo loop all key off this
 * element.
 */
export function LandingPage({ onAuth }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mockWrapRef = useRef<HTMLDivElement>(null);
  const mockRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  // Phone-width nav: the links collapse behind a burger (desktop hides it).
  const [menuOpen, setMenuOpen] = useState(false);

  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Plan-comparison modal: the tier key of the clicked pricing card (highlighted
  // column), or null when closed.
  const [compareTier, setCompareTier] = useState<string | null>(null);
  // Pricing display period (checkout itself is chosen after sign-up).
  const [priceInterval, setPriceInterval] = useState<BillingInterval>("month");
  const perMonthLabel = (t: TierConfig) =>
    t.priceUsd > 0 && priceInterval === "year" ? usd(yearlyPerMonthUsd(t.priceUsd)) : t.priceLabel;

  // ---- hero demo loop ----
  const [demo, setDemo] = useState<DemoState>({ phase: 0, typed: 0, lines: 0, cards: 0 });
  const [heroVisible, setHeroVisible] = useState(true);

  // Run the loop only while the mock is actually on screen (saves timers/CPU).
  useEffect(() => {
    const el = mockWrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setHeroVisible(e.isIntersecting), {
      threshold: 0.1,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The demo is CONTENT (an autoplaying product tour, like a video) — it plays
  // even under prefers-reduced-motion; only parallax and scroll reveals honor it.
  useEffect(() => {
    if (!heroVisible) return;
    let alive = true;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(window.setTimeout(r, ms)));
    const set = (patch: Partial<DemoState>) =>
      alive && setDemo((d) => ({ ...d, ...patch }));
    (async () => {
      while (alive) {
        set({ phase: 0, typed: 0, lines: 0, cards: 0 });
        await wait(500);
        if (!alive) return;
        set({ phase: 1 }); // user prompt appears
        await wait(800);
        set({ phase: 2 }); // agent reply types out
        for (let i = 1; i <= AGENT_REPLY.length && alive; i += 2) {
          set({ typed: Math.min(i + 1, AGENT_REPLY.length) });
          await wait(32);
        }
        if (!alive) return;
        await wait(350);
        set({ phase: 3 }); // code cascades into the editor
        for (let i = 1; i <= DEMO_CODE.length && alive; i++) {
          set({ lines: i });
          await wait(120);
        }
        if (!alive) return;
        await wait(300);
        set({ phase: 4 }); // preview builds itself
        for (let i = 1; i <= TOTAL_CARDS && alive; i++) {
          set({ cards: i });
          await wait(150);
        }
        if (!alive) return;
        set({ phase: 5 }); // live — hold the finished frame
        await wait(3400);
        set({ phase: 6 }); // fade out, then loop
        await wait(500);
      }
    })();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [heroVisible]);

  const show = demo;

  // ---- Developers section: typed curl + streamed SSE steps ----
  const devTermRef = useRef<HTMLDivElement>(null);
  const [devVisible, setDevVisible] = useState(false);
  const [dev, setDev] = useState({ phase: 0, typed: 0, sse: 0 });

  useEffect(() => {
    const el = devTermRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setDevVisible(e.isIntersecting), {
      threshold: 0.2,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Unlike the hero tour (content, plays regardless), this one HONORS reduced
  // motion: it renders the finished frame statically instead of looping.
  useEffect(() => {
    if (reducedMotion) {
      setDev({ phase: 4, typed: DEV_CURL.length, sse: DEV_SSE.length });
      return;
    }
    if (!devVisible) return;
    let alive = true;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(window.setTimeout(r, ms)));
    const set = (patch: Partial<{ phase: number; typed: number; sse: number }>) =>
      alive && setDev((d) => ({ ...d, ...patch }));
    (async () => {
      while (alive) {
        set({ phase: 0, typed: 0, sse: 0 });
        await wait(600);
        if (!alive) return;
        set({ phase: 1 }); // the curl types out
        for (let i = 1; i <= DEV_CURL.length && alive; i += 2) {
          set({ typed: Math.min(i + 1, DEV_CURL.length) });
          await wait(18);
        }
        if (!alive) return;
        await wait(350);
        set({ phase: 2 }); // run created
        await wait(600);
        set({ phase: 3 }); // SSE steps stream in
        for (let i = 1; i <= DEV_SSE.length && alive; i++) {
          set({ sse: i });
          await wait(550);
        }
        if (!alive) return;
        set({ phase: 4 }); // hold the finished frame
        await wait(3500);
        set({ phase: 5 }); // fade, then loop
        await wait(450);
      }
    })();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [devVisible, reducedMotion]);

  // ---- scroll-reveal: one IntersectionObserver adds .in to every .reveal once ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".reveal"));
    if (reducedMotion) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [reducedMotion]);

  // ---- nav border + subtle hero parallax (two layers, different rates) ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = root.scrollTop;
        setScrolled(y > 8);
        // Parallax is desktop-only: on phones the chat sits in normal flow
        // above the mock, so translating it just fights the layout.
        if (!reducedMotion && window.matchMedia("(min-width: 901px)").matches) {
          if (mockRef.current) mockRef.current.style.transform = `translateY(${y * -0.05}px)`;
          if (chatRef.current) chatRef.current.style.transform = `translateY(${y * -0.11}px)`;
        }
      });
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  // ---- highlight the nav link for the section currently in view ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActiveSection(e.target.id);
      },
      { root, rootMargin: "-35% 0px -55% 0px" },
    );
    for (const id of ["features", "templates", "agent", "pricing", "developers", "faq"]) {
      const el = root.querySelector(`#${id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  // Close the comparison modal with Escape.
  useEffect(() => {
    if (!compareTier) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCompareTier(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compareTier]);

  // Smooth-scroll the nav anchor links inside this container.
  function jumpTo(id: string) {
    rootRef.current
      ?.querySelector(`#${id}`)
      ?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  // Hero prompt → stash the idea for the Dashboard, then open sign-up.
  function startBuilding() {
    const text = idea.trim();
    if (text) sessionStorage.setItem(PENDING_IDEA_KEY, text);
    onAuth("register");
  }

  function navLink(id: string, label: string) {
    return (
      <button
        className={`landing-navlink${activeSection === id ? " active" : ""}`}
        onClick={() => jumpTo(id)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="landing" ref={rootRef}>
      <header className={`landing-nav${scrolled ? " scrolled" : ""}`}>
        <div className="landing-nav-inner">
          <span className="wordmark landing-logo">{BRAND_LABEL}</span>
          <nav className="landing-nav-links" aria-label="Sections">
            {navLink("features", "Features")}
            {navLink("templates", "Templates")}
            {navLink("agent", "Agent")}
            {navLink("pricing", "Pricing")}
            {navLink("developers", "Developers")}
            {navLink("faq", "FAQ")}
          </nav>
          <div className="landing-nav-cta">
            <button className="btn-ghost" onClick={() => onAuth("login")}>Sign in</button>
            <button className="btn-primary" onClick={() => onAuth("register")}>Get started</button>
          </div>
          <button
            className="landing-nav-burger"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
        </div>
        {menuOpen && (
          <div className="landing-nav-menu">
            {(
              [
                ["features", "Features"],
                ["templates", "Templates"],
                ["agent", "Agent"],
                ["pricing", "Pricing"],
                ["developers", "Developers"],
                ["faq", "FAQ"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className="landing-navlink"
                onClick={() => {
                  setMenuOpen(false);
                  jumpTo(id);
                }}
              >
                {label}
              </button>
            ))}
            <div className="landing-nav-menu-cta">
              <button className="btn-ghost" onClick={() => onAuth("login")}>Sign in</button>
              <button className="btn-primary" onClick={() => onAuth("register")}>Get started</button>
            </div>
          </div>
        )}
      </header>

      {/* ---------- hero ---------- */}
      <section className="landing-hero">
        <div className="landing-hero-copy reveal">
          <h1>Build, run, and ship apps with an AI agent.</h1>
          <p className="landing-lede">
            Describe what you want. {AGENT_NAME} writes the code, runs it in a real cloud
            workspace, and hands you a live preview — right in your browser.
          </p>
          <div className="landing-prompt">
            <input
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") startBuilding();
              }}
              placeholder="Describe what you want to build… e.g. “a habit tracker with streaks”"
              aria-label="Describe what you want to build"
            />
            <button className="btn-primary" onClick={startBuilding}>
              Start building →
            </button>
          </div>
          <p className="landing-hero-note muted">
            Free plan · no card required ·{" "}
            <button className="linklike" onClick={() => onAuth("login")}>
              Sign in
            </button>
          </p>
        </div>

        {/* CSS-built IDE demo; decorative only. */}
        <div className="landing-mock-wrap reveal" aria-hidden="true" ref={mockWrapRef}>
          <div className={`landing-mock${show.phase === 6 ? " out" : ""}`} ref={mockRef}>
            <div className="mock-titlebar">
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-title">my-app — {PLATFORM_NAME}</span>
            </div>
            <div className="mock-body">
              <div className="mock-files">
                {["index.html", "styles.css", "app.js", "server.js", "package.json"].map((f) => (
                  <span
                    key={f}
                    className={`mock-file${f === "app.js" && show.lines > 0 ? " active" : ""}`}
                  >
                    {f}
                  </span>
                ))}
              </div>
              <div className="mock-editor">
                {DEMO_CODE.map((line, i) => (
                  <div key={i} className={`code-line${i < show.lines ? " on" : ""}`}>
                    <span className="code-ln">{i + 1}</span>
                    <span className="code-src">
                      {line.map((tok, j) => (
                        <span key={j} className={`tok-${tok.t}`}>
                          {tok.s}
                        </span>
                      ))}
                      {show.phase === 3 && i === show.lines - 1 && (
                        <span className="mock-caret" />
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mock-preview">
                <div className="mock-preview-bar">
                  <span className={`mock-live-dot${show.phase >= 5 ? " on" : ""}`} />
                  <span>Live preview</span>
                  <span className="mock-url">localhost:3000</span>
                </div>
                <div className="mock-preview-body">
                  {DEMO_BOARD.map((col, c) => (
                    <div key={col.title} className={`mock-col${show.phase >= 4 ? " on" : ""}`}>
                      <div className="mock-col-title">{col.title}</div>
                      {col.cards.map((label, i) => (
                        <div
                          key={label}
                          className={`mock-card${cardIndex(c, i) < show.cards ? " on" : ""}`}
                        >
                          {label}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div
            className={`landing-mock-chat${show.phase === 6 ? " out" : ""}`}
            ref={chatRef}
          >
            <div className="mock-chat-head">{AGENT_NAME}</div>
            <div className="mock-chat-body">
              <div className={`mock-msg user${show.phase >= 1 ? " on" : ""}`}>
                Build me a kanban board with drag &amp; drop
              </div>
              <div className={`mock-msg agent${show.phase >= 2 ? " on" : ""}`}>
                {AGENT_REPLY.slice(0, show.typed)}
                {show.phase === 2 && <span className="mock-caret" />}
              </div>
              <div className="mock-chat-steps">
                <span className={`mock-chat-step${show.phase >= 3 ? " on" : ""}`}>
                  <span className="mock-check">✓</span> Created app.js
                </span>
                <span className={`mock-chat-step${show.phase >= 4 ? " on" : ""}`}>
                  <span className="mock-check">✓</span> Started dev server
                </span>
              </div>
              <div className="mock-chat-status">
                <span className={`mock-status-dot${show.phase >= 5 ? " live" : ""}`} />
                {show.phase >= 5 ? "Running · preview ready" : "Working…"}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="landing-section landing-how">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">How it works</div>
          <div className="landing-steps">
            {(
              [
                ["1", "Describe it", "Type what you want to build, in plain English."],
                [
                  "2",
                  "Watch it build",
                  `${AGENT_NAME} writes the code and runs it live in a cloud workspace.`,
                ],
                ["3", "Ship it", "Publish a live URL and share it — or keep iterating."],
              ] as const
            ).map(([n, h, p], i) => (
              <div
                key={n}
                className="landing-step reveal"
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                <span className="landing-step-num">{n}</span>
                <h3>{h}</h3>
                <p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section className="landing-section" id="features">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">Why {PLATFORM_NAME}</div>
          <h2 className="reveal">From prompt to production, in one place.</h2>

          <div className="landing-feature reveal">
            <div className="landing-feature-copy">
              <h3>An agent that does the work.</h3>
              <p>
                Tell {AGENT_NAME} what to build. It plans, writes files, installs packages,
                runs your app, and fixes its own errors — while you watch every step happen
                live in your workspace.
              </p>
            </div>
            <div className="landing-feature-visual">
              <div className="mock-steps">
                {[
                  "Created app.js",
                  "Installed dependencies",
                  "Fixed a TypeError in app.js",
                  "Started the dev server",
                ].map((s, i) => (
                  <div key={s} className="mock-step" style={{ transitionDelay: `${i * 120}ms` }}>
                    <span className="mock-check">✓</span> {s}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="landing-feature flip reveal">
            <div className="landing-feature-copy">
              <h3>A real cloud workspace.</h3>
              <p>
                Every project gets a private, isolated workspace with a file tree, editor,
                shell, and an instant live preview. Nothing to install, nothing to configure —
                open the browser and it's ready.
              </p>
            </div>
            <div className="landing-feature-visual">
              <div className="mock-term">
                <div className="mock-term-line"><span className="mock-prompt">$</span> npm install</div>
                <div className="mock-term-line dim">added 42 packages in 1.8s</div>
                <div className="mock-term-line"><span className="mock-prompt">$</span> node server.js</div>
                <div className="mock-term-line ok">▸ Server running on port 3000</div>
                <div className="mock-term-line">
                  <span className="mock-prompt">$</span> <span className="mock-caret" />
                </div>
              </div>
            </div>
          </div>

          <div className="landing-feature reveal">
            <div className="landing-feature-copy">
              <h3>Ship and share in one click.</h3>
              <p>
                Sync to GitHub, publish a live URL, and share what you built. Your projects
                are saved in the cloud and waiting whenever you come back.
              </p>
            </div>
            <div className="landing-feature-visual">
              <div className="mock-deploy">
                <div className="mock-deploy-row">
                  <span className="mock-chip">Deploy</span>
                  <span className="mock-deploy-url">your-app.live</span>
                  <span className="mock-chip live">● Live</span>
                </div>
                <div className="mock-deploy-row dim">
                  <span className="mock-check">✓</span> Synced to GitHub
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- templates ---------- */}
      <section className="landing-section alt" id="templates">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">Start faster</div>
          <h2 className="reveal">Templates for every idea.</h2>
          <p className="landing-lede reveal">
            Spin up a working starter in one click — then let the agent take it from there.
          </p>
          <div className="landing-templates">
            {TEMPLATES.slice(0, 8).map((t, i) => (
              <button
                key={t.id}
                className="landing-template reveal"
                style={{ transitionDelay: `${i * 40}ms` }}
                onClick={() => onAuth("register")}
              >
                <span className="landing-template-emoji">{t.emoji}</span>
                <span className="landing-template-title">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- meet the agent ---------- */}
      <section className="landing-section" id="agent">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">Meet {AGENT_NAME}</div>
          <h2 className="reveal">One agent. Every step of the job.</h2>
          <p className="landing-lede reveal">
            {AGENT_NAME} doesn't just autocomplete — it plans, builds, debugs, explains, and
            ships, inside a real workspace.
          </p>
          {AGENT_BLOCKS.map((b, i) => (
            <div key={b.id} className={`agent-block reveal${i % 2 ? " flip" : ""}`}>
              <div className="agent-block-copy">
                <div className="landing-kicker">{b.label}</div>
                <h3>{b.heading}</h3>
                <p>{b.blurb}</p>
                <div className="mock-msg user on agent-ask">{b.user}</div>
              </div>
              <div className="agent-block-visual">
                <div className="mock-msg agent on">{b.agent}</div>
                {b.artifact === "build" && (
                  <div className="mock-term">
                    <div className="mock-term-line"><span className="mock-prompt">$</span> node server.js</div>
                    <div className="mock-term-line dim">4 files created · 2 packages installed</div>
                    <div className="mock-term-line ok">▸ Habit tracker running on port 3000</div>
                  </div>
                )}
                {b.artifact === "fix" && (
                  <div className="agent-diff">
                    <span className="dim">app.js · addHabit()</span>
                    <span className="del">- habits.push(name);</span>
                    <span className="add">+ if (!habits.includes(name)) habits.push(name);</span>
                    <span className="ok">✓ Re-ran the app — no errors</span>
                  </div>
                )}
                {b.artifact === "explain" && (
                  <div className="agent-explain">
                    <code>const save = debounce(write, 2000);</code>
                    <p>
                      💡 Waits 2s after the last keystroke before saving, so the file isn't
                      written on every character you type.
                    </p>
                  </div>
                )}
                {b.artifact === "ship" && (
                  <div className="mock-deploy">
                    <div className="mock-deploy-row">
                      <span className="mock-chip">Deploy</span>
                      <span className="mock-deploy-url">habit-tracker.live</span>
                      <span className="mock-chip live">● Live</span>
                    </div>
                    <div className="mock-deploy-row dim">
                      <span className="mock-check">✓</span> Synced to GitHub
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- pricing ---------- */}
      <section className="landing-section" id="pricing">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">Pricing</div>
          <h2 className="reveal">Start free. Upgrade when you're shipping.</h2>
          <div className="interval-toggle landing-interval reveal" role="tablist" aria-label="Billing period">
            <button
              role="tab"
              aria-selected={priceInterval === "month"}
              className={priceInterval === "month" ? "active" : ""}
              onClick={() => setPriceInterval("month")}
            >
              Monthly
            </button>
            <button
              role="tab"
              aria-selected={priceInterval === "year"}
              className={priceInterval === "year" ? "active" : ""}
              onClick={() => setPriceInterval("year")}
            >
              Yearly <span className="interval-save">−16%</span>
            </button>
          </div>
          <div className="landing-pricing">
            {TIER_LIST.map((t, i) => (
              <div
                key={t.key}
                className={`landing-plan reveal${t.key === "pro" ? " featured" : ""}`}
                style={{ transitionDelay: `${i * 60}ms` }}
                role="button"
                tabIndex={0}
                aria-label={`Compare the ${t.name} plan`}
                onClick={() => setCompareTier(t.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setCompareTier(t.key);
                  }
                }}
              >
                {t.key === "pro" && <span className="landing-plan-pop">Most popular</span>}
                <div className="landing-plan-name">{t.name}</div>
                <div className="landing-plan-price">
                  {perMonthLabel(t)}
                  <small>/mo</small>
                </div>
                {priceInterval === "year" && t.priceUsd > 0 && (
                  <div className="muted landing-plan-billed">
                    billed yearly · {usd(yearlyTotalUsd(t.priceUsd))}/yr
                  </div>
                )}
                <div className="landing-plan-tagline muted">{t.tagline}</div>
                <ul>
                  {t.perks.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <button
                  className={t.key === "free" ? "btn-primary wide" : "btn-ghost wide"}
                  onClick={(e) => {
                    e.stopPropagation(); // straight to sign-up, not the comparison
                    onAuth("register");
                  }}
                >
                  {t.key === "free" ? "Get started" : `Start with ${t.name}`}
                </button>
              </div>
            ))}
          </div>
          <div className="landing-compare-open">
            <button className="linklike" onClick={() => setCompareTier("pro")}>
              Compare all plans →
            </button>
          </div>
        </div>
      </section>

      {/* ---------- developers ---------- */}
      <section className="landing-section alt" id="developers">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">Developers</div>
          <h2 className="reveal">Build on {PLATFORM_NAME}.</h2>
          <p className="landing-lede reveal">
            The same agent that powers the IDE, callable from your own code — plus automatic
            GitHub backup for every project.
          </p>

          {/* API: copy left, animated terminal right */}
          <div className="landing-feature reveal">
            <div className="landing-feature-copy">
              <h3>One POST. A full agent run.</h3>
              <p>
                Create a run with a single request, then follow every step as the agent plans,
                writes files, and executes — inside your project's real cloud workspace.
              </p>
              <ul className="landing-dev-bullets">
                <li>Up to 5 API keys per account</li>
                <li>Metered pricing — {API_PRICE_LABEL}</li>
                <li>No monthly minimum — pay only for the tokens you use</li>
                <li>Waitlist acceptance in about 48 hours</li>
                <li>Manage keys &amp; spend in Settings → Developer</li>
              </ul>
            </div>
            <div className="landing-feature-visual" ref={devTermRef} aria-hidden="true">
              <div className={`mock-term landing-dev-term${dev.phase === 5 ? " out" : ""}`}>
                <div className="dev-term-cmd">
                  <span className="mock-prompt">$</span> {DEV_CURL.slice(0, dev.typed)}
                  {dev.phase === 1 && <span className="mock-caret" />}
                </div>
                {dev.phase >= 2 && <div className="mock-term-line ok">{DEV_RESPONSE}</div>}
                {DEV_SSE.slice(0, dev.sse).map((l) => (
                  <div key={l} className="mock-term-line dim">
                    {l}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* GitHub sync: visual left (flip), copy right */}
          <div className="landing-feature flip reveal">
            <div className="landing-feature-copy">
              <h3>Your projects, on your GitHub.</h3>
              <p>
                Connect GitHub once and every project keeps itself backed up — pushed after each
                change, pulled onto any device you sign in from, and restorable after anything.
              </p>
              <ul className="landing-dev-bullets">
                <li>Automatic push after every change</li>
                <li>Pick up where you left off on any device</li>
                <li>Your code stays in a repo you own</li>
              </ul>
            </div>
            <div className="landing-feature-visual" aria-hidden="true">
              <div className="landing-ghsync">
                <div className="gh-node">
                  <span className="gh-node-icon">💻</span>
                  <span className="gh-node-label">This device</span>
                </div>
                <div className="gh-link">
                  <span className="gh-dot" />
                </div>
                <div className="gh-node repo">
                  <span className="gh-node-icon">🐙</span>
                  <span className="gh-node-label">github.com/you/my-app</span>
                </div>
                <div className="gh-link second">
                  <span className="gh-dot" />
                </div>
                <div className="gh-node">
                  <span className="gh-node-icon">🖥️</span>
                  <span className="gh-node-label">Any device</span>
                </div>
              </div>
            </div>
          </div>

          <div className="landing-devcta reveal">
            <button className="btn-primary lg" onClick={() => onAuth("register")}>
              Join the developer program
            </button>
            <p className="muted small">
              Already signed in? Open Settings → Developer to register.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="landing-section" id="faq">
        <div className="landing-section-inner">
          <div className="landing-kicker reveal">FAQ</div>
          <h2 className="reveal">Questions, answered.</h2>
          <div className="landing-faq">
            {(
              [
                [
                  "Is it free to start?",
                  "Yes — the Free plan includes real cloud workspaces and the full agent, no card required. Paid plans add more monthly usage and public publishing.",
                ],
                [
                  "What can the agent build?",
                  "Websites, games, dashboards, APIs, bots — anything that runs on HTML/CSS/JS or Node.js. It writes the files, installs packages, runs the app, and fixes its own errors.",
                ],
                [
                  "Do I need to install anything?",
                  "No. The editor, shell, and live preview all run in your browser against an isolated cloud workspace.",
                ],
                [
                  "What are Sparks?",
                  "Sparks measure your monthly agent usage. Usage fluctuates with how much the agent has to think, and your plan's allowance resets every month.",
                ],
                [
                  "Can I call it from my own code?",
                  `Yes — the developer program gives you API keys for programmatic agent runs, metered per token (${API_PRICE_LABEL}). See the Developers section above for details.`,
                ],
              ] as const
            ).map(([q, a]) => (
              <details key={q} className="landing-faq-item reveal">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- final CTA ---------- */}
      <section className="landing-section landing-cta-final">
        <div className="landing-section-inner reveal">
          <h2>Ready to build something?</h2>
          <p className="landing-lede">Your first project is one sentence away.</p>
          <button className="btn-primary lg" onClick={() => onAuth("register")}>
            Start building — it's free
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="wordmark">{BRAND_LABEL}</span>
            <span className="muted small">
              Build, run, and ship apps with an AI agent — in the cloud.
            </span>
          </div>
          <nav className="landing-footer-col" aria-label="Product">
            <h4>Product</h4>
            <button className="landing-navlink" onClick={() => jumpTo("features")}>Features</button>
            <button className="landing-navlink" onClick={() => jumpTo("templates")}>Templates</button>
            <button className="landing-navlink" onClick={() => jumpTo("agent")}>{AGENT_NAME}</button>
            <button className="landing-navlink" onClick={() => jumpTo("pricing")}>Pricing</button>
            <button className="landing-navlink" onClick={() => jumpTo("faq")}>FAQ</button>
          </nav>
          <nav className="landing-footer-col" aria-label="Account">
            <h4>Account</h4>
            <button className="landing-navlink" onClick={() => onAuth("login")}>Sign in</button>
            <button className="landing-navlink" onClick={() => onAuth("register")}>
              Create account
            </button>
            <button className="landing-navlink" onClick={() => jumpTo("developers")}>
              Developer API
            </button>
          </nav>
          <nav className="landing-footer-col" aria-label="Support">
            <h4>Support</h4>
            <a className="landing-navlink" href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
            <a className="landing-navlink" href={`mailto:${SUPPORT_EMAIL}?subject=Suspension%20appeal`}>
              Appeal a suspension
            </a>
            <a className="landing-navlink" href={`mailto:${SUPPORT_EMAIL}?subject=Security%20report`}>
              Report a security issue
            </a>
          </nav>
          <nav className="landing-footer-col" aria-label="Legal">
            <h4>Legal</h4>
            <a className="landing-navlink" href="/terms">Terms of Service</a>
            <a className="landing-navlink" href="/privacy">Privacy Policy</a>
            <a className="landing-navlink" href="/acceptable-use">Acceptable Use</a>
          </nav>
        </div>
        <span className="muted landing-footer-copy">
          © {new Date().getFullYear()} {PLATFORM_NAME} · <a href="/terms">Terms</a> ·{" "}
          <a href="/privacy">Privacy</a> · <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </span>
      </footer>

      {/* ---------- plan comparison modal ---------- */}
      {compareTier && (
        <div className="modal-backdrop" onClick={() => setCompareTier(null)}>
          <div
            className="modal landing-compare"
            role="dialog"
            aria-label="Compare plans"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="landing-compare-head">
              <h2>Compare plans</h2>
              <button className="btn-ghost sm" onClick={() => setCompareTier(null)}>
                ✕ Close
              </button>
            </div>
            <div className="landing-compare-scroll">
              <table className="landing-compare-table">
                <thead>
                  <tr>
                    <th />
                    {TIER_LIST.map((t) => (
                      <th key={t.key} className={t.key === compareTier ? "hl" : ""}>
                        <div className="landing-compare-plan">{t.name}</div>
                        <div className="landing-compare-price">
                          {perMonthLabel(t)}
                          <small>/mo</small>
                        </div>
                        {priceInterval === "year" && t.priceUsd > 0 && (
                          <div className="muted landing-compare-billed">billed yearly</div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      {TIER_LIST.map((t) => {
                        const v = row.value(t);
                        return (
                          <td key={t.key} className={t.key === compareTier ? "hl" : ""}>
                            {v === true ? (
                              <span className="landing-compare-check">✓</span>
                            ) : v === false ? (
                              <span className="landing-compare-no">—</span>
                            ) : (
                              v
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td />
                    {TIER_LIST.map((t) => (
                      <td key={t.key} className={t.key === compareTier ? "hl" : ""}>
                        <button
                          className={t.key === compareTier ? "btn-primary sm" : "btn-ghost sm"}
                          onClick={() => onAuth("register")}
                        >
                          {t.priceUsd === 0 ? "Start free" : `Start ${t.name}`}
                        </button>
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="muted landing-compare-note">
              Monthly usage fluctuates with how much the agent has to think. Every plan includes
              the full agent and real cloud workspaces.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
