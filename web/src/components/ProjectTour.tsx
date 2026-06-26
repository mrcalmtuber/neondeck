import { useEffect, useState } from "react";
import { useStore, type MobilePane } from "../lib/store";
import { AGENT_NAME } from "../lib/brand";

/** localStorage flag so the tour auto-shows only once (replayable from Settings). */
export const TOUR_SEEN_KEY = "neondeck:tour:v1";

interface Step {
  emoji: string;
  title: string;
  body: string;
  /** On phones, switch to this pane so the tour points at the real thing. */
  pane?: MobilePane;
}

const STEPS: Step[] = [
  {
    emoji: "👋",
    title: "Welcome to your project!",
    body: "This quick tour takes about 30 seconds. By the end you'll know how to build and run your very own app. Tap Next to start!",
  },
  {
    emoji: "🤖",
    title: `Meet ${AGENT_NAME}`,
    body: "Just type what you want in plain words — like “make a button that says hello” — and the agent writes the code for you. No experience needed.",
    pane: "agent",
  },
  {
    emoji: "▶️",
    title: "Run it & watch it live",
    body: "Press the Run button, and your app comes alive in the Preview window right here. Change something? It updates in seconds.",
    pane: "center",
  },
  {
    emoji: "📁",
    title: "Your files live here",
    body: "Every file in your project is in this list. Curious? Double-click any file to peek at the code — or let the agent handle it.",
    pane: "files",
  },
  {
    emoji: "🌐",
    title: "Share it with the world",
    body: "When you're proud of it, get a public link so friends and family can open your app on their phones. (Sharing is a Pro feature.)",
    pane: "center",
  },
  {
    emoji: "🚀",
    title: "You're ready!",
    body: "That's the whole tour. Start by telling the agent your idea — anything you can imagine. Have fun building!",
    pane: "agent",
  },
];

/**
 * Friendly first-run walkthrough (for ages 9 to 90). A centered, mobile-safe card
 * that steps through the IDE; on phones each step also switches to the pane it's
 * describing so the explanation lines up with the real UI. Shows once (persisted
 * in localStorage); replayable from Settings via the store's tourOpen flag.
 */
export function ProjectTour() {
  const open = useStore((s) => s.tourOpen);
  const setOpen = useStore((s) => s.setTourOpen);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const [i, setI] = useState(0);

  // Reset to the first step every time the tour (re)opens.
  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  // Point the phone at the pane this step is about.
  useEffect(() => {
    if (!open) return;
    const pane = STEPS[i]?.pane;
    if (pane) setMobilePane(pane);
  }, [open, i, setMobilePane]);

  if (!open) return null;

  const step = STEPS[i];
  const isLast = i === STEPS.length - 1;

  function finish() {
    try {
      localStorage.setItem(TOUR_SEEN_KEY, "done");
    } catch {
      /* private mode — fine, it just may show again */
    }
    setOpen(false);
  }

  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="Getting started tour">
      <div className="tour-card glass">
        <button className="tour-skip" onClick={finish} title="Skip the tour" aria-label="Skip">
          ✕
        </button>

        <div className="tour-emoji" aria-hidden="true">
          {step.emoji}
        </div>
        <h2 className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>

        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((_, idx) => (
            <span key={idx} className={`tour-dot ${idx === i ? "active" : ""}`} />
          ))}
        </div>

        <div className="tour-actions">
          {i > 0 ? (
            <button className="btn-ghost" onClick={() => setI((n) => n - 1)}>
              ← Back
            </button>
          ) : (
            <button className="btn-ghost" onClick={finish}>
              Skip
            </button>
          )}
          {isLast ? (
            <button className="btn-neon" onClick={finish}>
              Let's go! 🚀
            </button>
          ) : (
            <button className="btn-neon" onClick={() => setI((n) => n + 1)}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
