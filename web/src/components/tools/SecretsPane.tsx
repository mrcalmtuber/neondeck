import { useEffect, useState } from "react";
import { daemon } from "../../lib/daemonClient";

type Line =
  | { kind: "kv"; key: string; value: string }
  | { kind: "raw"; text: string }; // comments/blank lines, preserved verbatim on save

const ENV_FILE = ".env";

function parse(content: string): Line[] {
  return content.split(/\r?\n/).map((text): Line => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
    return m ? { kind: "kv", key: m[1], value: m[2] } : { kind: "raw", text };
  });
}

function serialize(lines: Line[]): string {
  return lines
    .map((l) => (l.kind === "kv" ? `${l.key}=${l.value}` : l.text))
    .join("\n")
    .replace(/\n+$/, "")
    .concat("\n");
}

/**
 * Secrets — the project's `.env`, edited as key/value rows (Replit's Secrets).
 * Backed entirely by the existing file RPCs; values are masked in the UI but
 * live in the workspace file, readable by your running app via process.env.
 */
export function SecretsPane() {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    daemon
      .readFile(ENV_FILE)
      .then((c) => setLines(parse(c)))
      .catch(() => setLines([])); // no .env yet — start empty
  }, []);

  function update(i: number, patch: { key?: string; value?: string }) {
    setLines((ls) =>
      (ls ?? []).map((l, j) =>
        j === i && l.kind === "kv" ? { ...l, ...patch } : l,
      ),
    );
    setDirty(true);
    setNote(null);
  }

  function addRow() {
    setLines((ls) => [...(ls ?? []), { kind: "kv", key: "", value: "" }]);
    setDirty(true);
  }

  function removeRow(i: number) {
    setLines((ls) => (ls ?? []).filter((_, j) => j !== i));
    setDirty(true);
    setNote(null);
  }

  async function save() {
    if (!lines || busy) return;
    const bad = lines.find((l) => l.kind === "kv" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(l.key));
    if (bad && bad.kind === "kv") {
      setNote(`"${bad.key || "(empty)"}" isn't a valid variable name.`);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await daemon.manualUpdate(ENV_FILE, serialize(lines.filter((l) => l.kind !== "kv" || l.key)));
      setDirty(false);
      setNote("Saved to .env ✓ — restart your app to pick up changes.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const kvRows = (lines ?? []).map((l, i) => [l, i] as const).filter(([l]) => l.kind === "kv");

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🔑 Secrets</span>
        <div className="tool-head-actions">
          <button className="btn-ghost sm" onClick={addRow} disabled={lines === null}>
            + New secret
          </button>
          <button className="btn-primary sm" onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="tool-scroll">
        <p className="muted small tool-note">
          Environment variables for your app (stored in the project's <code>.env</code> file and
          exposed as <code>process.env.*</code>).
        </p>
        {note && <div className="auth-notice">{note}</div>}
        {lines === null ? (
          <p className="muted small">
            <span className="spinner" /> Loading…
          </p>
        ) : kvRows.length === 0 ? (
          <p className="muted small">No secrets yet — add one above.</p>
        ) : (
          <div className="secrets-list">
            {kvRows.map(([l, i]) =>
              l.kind === "kv" ? (
                <div key={i} className="secrets-row">
                  <input
                    className="secrets-key"
                    value={l.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                  />
                  <input
                    className="secrets-value"
                    type={revealed.has(i) ? "text" : "password"}
                    value={l.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder="value"
                    spellCheck={false}
                  />
                  <button
                    className="btn-ghost sm"
                    onClick={() =>
                      setRevealed((r) => {
                        const next = new Set(r);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                    title={revealed.has(i) ? "Hide value" : "Show value"}
                  >
                    {revealed.has(i) ? "🙈" : "👁"}
                  </button>
                  <button className="btn-ghost sm" onClick={() => removeRow(i)} title="Delete">
                    ✕
                  </button>
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
