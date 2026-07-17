import { useEffect, useState } from "react";
import type { GitCommit } from "@ide/shared";
import { daemon } from "../../lib/daemonClient";
import { getStoredGithubToken } from "../../lib/githubAuth";
import { useStore } from "../../lib/store";

/**
 * Git — commit history + "commit & push" over the existing gitLog/gitPublish
 * RPCs (Replit's Git pane). GitHub connection state comes from the browser-held
 * OAuth token; connecting happens in Settings.
 */
export function GitPane() {
  const setView = useStore((s) => s.setView);
  const [history, setHistory] = useState<{ isRepo: boolean; commits: GitCommit[] } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const ghConnected = !!getStoredGithubToken();

  async function refresh() {
    try {
      setHistory(await daemon.gitLog());
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function publish() {
    const msg = message.trim() || "Update from Kryct";
    setBusy(true);
    setNote(null);
    try {
      const res = await daemon.gitPublish(msg);
      setNote({ ok: res.ok, text: res.message });
      if (res.ok) {
        setMessage("");
        refresh();
      }
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🌿 Git</span>
        <button className="btn-ghost sm" onClick={refresh}>
          ⟳ Refresh
        </button>
      </div>
      <div className="tool-scroll">
        {!ghConnected && (
          <p className="muted small tool-note">
            GitHub isn't connected — commits stay local.{" "}
            <button className="linklike" onClick={() => setView("settings")}>
              Connect in Settings →
            </button>
          </p>
        )}

        <div className="git-publish">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") publish();
            }}
            placeholder="Commit message…"
            disabled={busy}
          />
          <button className="btn-primary sm" onClick={publish} disabled={busy}>
            {busy ? "Publishing…" : "Commit & push"}
          </button>
        </div>
        {note && <div className={note.ok ? "auth-notice" : "auth-error"}>{note.text}</div>}

        {history === null ? (
          <p className="muted small">
            <span className="spinner" /> Loading history…
          </p>
        ) : !history.isRepo ? (
          <p className="muted small">
            No git history yet — your first commit &amp; push initializes the repository.
          </p>
        ) : history.commits.length === 0 ? (
          <p className="muted small">No commits yet.</p>
        ) : (
          <div className="git-log">
            {history.commits.map((c) => (
              <div key={c.hash} className="git-commit">
                <code className="git-hash">{c.hash.slice(0, 7)}</code>
                <span className="git-subject">{c.subject}</span>
                <span className="muted small git-when">{c.relativeDate}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
