import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { storeGithubToken } from "../lib/githubAuth";

/**
 * One-time opt-in shown right after a "Continue with GitHub" sign-in: the
 * redirect already came back with a repo-scoped OAuth token, so enabling
 * project backups is instant — no second OAuth trip. Declining discards the
 * token; Settings → GitHub still offers the classic connect flow later.
 */
export function GithubBindModal({ token, onClose }: { token: string; onClose: () => void }) {
  function enable() {
    storeGithubToken(token);
    daemon.setGithubToken(token);
    // The GitHub token is part of the WS handshake — reconnect so the daemon
    // session picks it up (same pattern as Settings → Connect GitHub).
    daemon.disconnect();
    useStore.getState().requestConnect();
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dialog glass" onClick={(e) => e.stopPropagation()}>
        <h3>🐙 Back up your projects to GitHub?</h3>
        <p className="subtitle">
          You signed in with GitHub — Kryct can keep every project synced to private repos on your
          GitHub account, so your work survives anything and follows you across devices.
        </p>
        <p className="muted small">
          You can turn this on or off any time in Settings → GitHub.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="btn-primary" onClick={enable}>
            Enable backups
          </button>
        </div>
      </div>
    </div>
  );
}
