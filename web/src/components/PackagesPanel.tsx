import { useState } from "react";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { ws } from "../lib/workspaceService";

/** A handful of beginner-friendly suggestions for the empty state. */
const SUGGESTIONS = ["express", "react", "lodash", "axios", "zod", "dayjs", "chalk", "nanoid"];

interface Result {
  ok: boolean;
  message: string;
}

/**
 * Feature 1 — Visual npm Package Manager.
 *
 * Search a package name and hit Install. The request goes to the daemon, which
 * runs `npm install <name>` natively in the active project; output streams to
 * the terminal panel and the file tree refreshes on completion.
 */
export function PackagesPanel() {
  const transport = useStore((s) => s.transport);
  const setTree = useStore((s) => s.setTree);
  const [query, setQuery] = useState("");
  const [dev, setDev] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const name = query.trim();
  const disabled = transport !== "daemon" || !name || installing !== null;

  async function install(pkg: string) {
    if (transport !== "daemon" || !pkg || installing) return;
    setInstalling(pkg);
    setResult(null);
    try {
      const res = await daemon.installPackage(pkg, dev);
      setResult(res);
      if (res.ok) {
        setQuery("");
        // package.json changed — refresh the tree immediately.
        try {
          setTree(await ws.listTree());
        } catch {
          /* watcher will catch up */
        }
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="packages">
      <div className="explorer-header">
        <span>PACKAGES</span>
      </div>

      {transport !== "daemon" ? (
        <div className="muted pkg-note">Package install needs an active workspace connection.</div>
      ) : (
        <>
          <div className="pkg-search">
            <input
              value={query}
              placeholder="Search npm… e.g. express"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") install(name);
              }}
            />
          </div>

          {name && (
            <div className="pkg-card">
              <div className="pkg-card-main">
                <span className="pkg-name">📦 {name}</span>
                <a
                  className="pkg-link"
                  href={`https://www.npmjs.com/package/${encodeURIComponent(name)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  view on npm ↗
                </a>
              </div>
              <button className="btn-install" disabled={disabled} onClick={() => install(name)}>
                {installing === name ? "Installing…" : "⚡ Install Package"}
              </button>
            </div>
          )}

          <label className="pkg-dev">
            <input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} />
            install as devDependency (--save-dev)
          </label>

          {installing && (
            <div className="pkg-progress">
              <span className="spinner" /> running <code>npm install {installing}</code> — see the
              terminal for live output.
            </div>
          )}

          {result && (
            <div className={`pkg-result ${result.ok ? "ok" : "err"}`}>
              {result.ok ? "✓ " : "⚠️ "}
              {result.message}
            </div>
          )}

          {!name && (
            <div className="pkg-suggestions">
              <div className="muted pkg-note">Popular packages</div>
              <div className="pkg-chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="pkg-chip" onClick={() => setQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
