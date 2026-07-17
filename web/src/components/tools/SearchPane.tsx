import { useEffect, useRef, useState } from "react";
import type { SearchMatch } from "@ide/shared";
import { daemon } from "../../lib/daemonClient";
import { useStore } from "../../lib/store";

/**
 * Search — project-wide find-in-files over the existing searchFiles RPC.
 * Clicking a hit opens the file in the editor (left pane) and jumps to the line
 * via the store's existing gotoLine mechanism.
 */
export function SearchPane() {
  const setOpenFile = useStore((s) => s.setOpenFile);
  const setGotoLine = useStore((s) => s.setGotoLine);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ matches: SearchMatch[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live search.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setResult(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        setResult(await daemon.searchFiles(q, { caseSensitive }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, caseSensitive]);

  async function jump(m: SearchMatch) {
    try {
      const content = await daemon.readFile(m.path);
      setOpenFile(m.path, content);
      setGotoLine(m.line);
      setMobilePane("agent"); // the editor lives in the left pane on phones
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Group hits by file for a compact tree-like listing.
  const groups = new Map<string, SearchMatch[]>();
  for (const m of result?.matches ?? []) {
    const g = groups.get(m.path) ?? [];
    g.push(m);
    groups.set(m.path, g);
  }

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🔎 Search</span>
        <label className="muted small search-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />{" "}
          Aa
        </label>
      </div>
      <div className="search-input-row">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in files…"
          spellCheck={false}
          autoFocus
        />
        {busy && <span className="spinner" />}
      </div>
      <div className="tool-scroll">
        {error && <div className="auth-error">⚠️ {error}</div>}
        {result === null ? (
          <p className="muted small tool-note">Type at least two characters to search the project.</p>
        ) : result.matches.length === 0 ? (
          <p className="muted small tool-note">No matches for “{query.trim()}”.</p>
        ) : (
          <>
            {result.truncated && (
              <p className="muted small tool-note">Showing the first matches — narrow the query for more.</p>
            )}
            {[...groups.entries()].map(([path, hits]) => (
              <div key={path} className="search-group">
                <div className="search-file">
                  {path} <span className="muted small">({hits.length})</span>
                </div>
                {hits.map((m, i) => (
                  <button key={`${m.line}:${m.col}:${i}`} className="search-hit" onClick={() => jump(m)}>
                    <span className="search-line">{m.line}</span>
                    <span className="search-preview">{m.preview.trim()}</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
