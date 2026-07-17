import { useRef, useState } from "react";
import { daemon } from "../../lib/daemonClient";

interface Entry {
  cmd: string;
  output: string;
  exit: number | null;
  running: boolean;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Shell — run one-off commands in the open workspace (Replit's Shell). Streams
 * output over the existing `run_command` protocol; same sandbox/timeouts as
 * agent-run commands, and the same Pro+ gate for arbitrary commands (the
 * server's error message is surfaced inline).
 */
export function ShellPane() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  function patchLast(patch: Partial<Entry>): void {
    setEntries((es) => es.map((e, i) => (i === es.length - 1 ? { ...e, ...patch } : e)));
  }

  async function run() {
    const command = cmd.trim();
    if (!command || busy) return;
    setCmd("");
    setBusy(true);
    setEntries((es) => [...es, { cmd: command, output: "", exit: null, running: true }]);
    try {
      const exit = await daemon.runCommand(command, (data) => {
        setEntries((es) =>
          es.map((e, i) => (i === es.length - 1 ? { ...e, output: e.output + stripAnsi(data) } : e)),
        );
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      patchLast({ exit, running: false });
    } catch (err) {
      patchLast({
        output:
          (entries[entries.length - 1]?.output ?? "") +
          `${err instanceof Error ? err.message : String(err)}\n`,
        running: false,
      });
    } finally {
      setBusy(false);
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">⌨️ Shell</span>
        <button className="btn-ghost sm" onClick={() => setEntries([])} disabled={busy}>
          Clear
        </button>
      </div>
      <div className="shell-scroll" ref={scrollRef}>
        {entries.length === 0 && (
          <p className="muted small shell-hint">
            Run a command in your workspace — try <code>ls</code> or <code>node -v</code>.
          </p>
        )}
        {entries.map((e, i) => (
          <div key={i} className="shell-entry">
            <div className="shell-cmd">
              <span className="shell-prompt">$</span> {e.cmd}
            </div>
            {e.output && <pre className="shell-output">{e.output}</pre>}
            {e.running ? (
              <div className="muted small">
                <span className="spinner" /> running…
              </div>
            ) : e.exit !== null && e.exit !== 0 ? (
              <div className="shell-exit">exit {e.exit}</div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="shell-input-row">
        <span className="shell-prompt">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder={busy ? "running…" : "type a command and press Enter"}
          disabled={busy}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
