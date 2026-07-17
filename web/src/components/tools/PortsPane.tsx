import { useEffect, useState } from "react";
import type { ProcessInfo } from "@ide/shared";
import { daemon } from "../../lib/daemonClient";
import { useStore } from "../../lib/store";

function uptime(startedAtMs: number): string {
  const s = Math.floor((Date.now() - startedAtMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Ports — running workspace processes and the ports they hold (Replit's
 * Networking pane). Polls listProcesses every 5s, but only while this tab is
 * the active one (keep-alive mounting would otherwise poll forever).
 */
export function PortsPane() {
  const active = useStore((s) => s.activeTool) === "ports";
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = async () => {
      try {
        const list = await daemon.listProcesses();
        if (alive) {
          setProcs(list);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  function kill(procId: string) {
    daemon.killProcess(procId);
    // The daemon reaps asynchronously — refresh shortly after.
    setTimeout(() => {
      daemon.listProcesses().then(setProcs).catch(() => {});
    }, 400);
  }

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🔌 Ports</span>
        <button
          className="btn-ghost sm"
          onClick={() => daemon.listProcesses().then(setProcs).catch(() => {})}
        >
          ⟳ Refresh
        </button>
      </div>
      <div className="tool-scroll">
        {error && <div className="auth-error">⚠️ {error}</div>}
        {procs === null ? (
          <p className="muted small">
            <span className="spinner" /> Loading processes…
          </p>
        ) : procs.length === 0 ? (
          <p className="muted small">
            Nothing running. Hit ⏵ Run in the Webview tab to start your app.
          </p>
        ) : (
          <table className="ports-table">
            <thead>
              <tr>
                <th>Process</th>
                <th>Port</th>
                <th>PID</th>
                <th>Uptime</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {procs.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="ports-label">{p.label}</div>
                    <div className="muted small ports-cmd">{p.command}</div>
                  </td>
                  <td>{p.port ?? "—"}</td>
                  <td>{p.pid ?? "—"}</td>
                  <td>{uptime(p.startedAtMs)}</td>
                  <td>
                    <button className="btn-ghost sm" onClick={() => kill(p.id)}>
                      ✕ Kill
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
