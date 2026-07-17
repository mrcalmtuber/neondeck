import { useEffect, useReducer, useRef } from "react";
import { daemon } from "../../lib/daemonClient";
import { termBus } from "../../lib/termBus";

/** Strip ANSI color codes — the console is a flat text log, not a terminal. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Module-level ring buffer, wired ONCE: output from agent runs, installs and
 * previews is captured even while the Console tab is closed, and survives tab
 * switches. ~2000 lines cap keeps memory flat on long sessions.
 */
const MAX_LINES = 2000;
let buffer: string[] = [];
const listeners = new Set<() => void>();
let wired = false;

function push(text: string): void {
  buffer.push(stripAnsi(text));
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES);
  listeners.forEach((fn) => fn());
}

function wire(): void {
  if (wired) return;
  wired = true;
  daemon.onMessage((m) => {
    if (m.type === "terminal_output") push(m.data);
    else if (m.type === "command_exit" && m.exitCode !== null && m.exitCode !== 0)
      push(`\n[process exited with code ${m.exitCode}]\n`);
  });
  termBus.subscribe(push); // LiveView status lines (run started, errors)
}

/** Console — read-only stream of everything the workspace runs (Replit's Console). */
export function ConsolePane() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    wire();
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);

  // Follow the tail as output streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🖥️ Console</span>
        <button
          className="btn-ghost sm"
          onClick={() => {
            buffer = [];
            force();
          }}
        >
          Clear
        </button>
      </div>
      <pre className="console-log" ref={logRef}>
        {buffer.length > 0 ? buffer.join("") : "Run your app or ask the agent to build — output shows up here.\n"}
      </pre>
    </div>
  );
}
