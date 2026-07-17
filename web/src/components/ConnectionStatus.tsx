import { useStore } from "../lib/store";
import { DAEMON_WS } from "../lib/daemonClient";

/** Daemon connection status indicator for the topbar. */
export function ConnectionStatus() {
  const conn = useStore((s) => s.conn);
  const projectsRootName = useStore((s) => s.projectsRootName);

  const label =
    conn === "connected"
      ? `Connected · ${projectsRootName}`
      : conn === "connecting"
        ? "Connecting…"
        : "Disconnected";

  return (
    <div className={`conn-status conn-${conn}`} title={DAEMON_WS}>
      <span className="dot" />
      <span className="conn-label">{label}</span>
    </div>
  );
}
