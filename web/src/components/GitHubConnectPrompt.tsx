import { useState } from "react";
import { connectGitHub } from "../lib/githubAuth";
import { daemon } from "../lib/daemonClient";
import { useStore } from "../lib/store";

/** localStorage flag so the optional GitHub prompt only auto-shows once. */
export const GH_PROMPT_SEEN_KEY = "neondeck:gh-prompt:v1";

/**
 * Optional, one-time "Connect GitHub" card shown before the first-run tour.
 * Framed purely as convenience — it links the user's GitHub so things stay handy
 * across devices/sessions. `onDone` runs whether they connect or skip, so the
 * caller can then start the tour.
 */
export function GitHubConnectPrompt({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  function markSeen() {
    try {
      localStorage.setItem(GH_PROMPT_SEEN_KEY, "done");
    } catch {
      /* private mode — fine */
    }
  }

  function skip() {
    markSeen();
    onDone();
  }

  async function connect() {
    setBusy(true);
    const token = await connectGitHub();
    setBusy(false);
    markSeen();
    if (token) {
      // Reconnect so the daemon picks up the token on the next hello.
      daemon.setGithubToken(token);
      daemon.disconnect();
      useStore.getState().requestConnect();
    }
    onDone();
  }

  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="Connect GitHub">
      <div className="tour-card glass tour-at-center">
        <div className="tour-emoji" aria-hidden="true">
          🐙
        </div>
        <h2 className="tour-title">Connect GitHub?</h2>
        <p className="tour-body">
          Link your GitHub to keep everything handy across your devices — it's totally optional,
          and you can always do it later from Settings.
        </p>
        <div className="tour-actions tour-actions-center">
          <button className="btn-neon" onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : "Connect GitHub"}
          </button>
        </div>
        <button className="tour-skip-tiny" onClick={skip} disabled={busy}>
          Maybe later
        </button>
      </div>
    </div>
  );
}
