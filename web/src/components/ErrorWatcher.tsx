import { useEffect } from "react";
import { daemon } from "../lib/daemonClient";
import { termBus } from "../lib/termBus";
import { useStore } from "../lib/store";
import { classifyLog } from "../lib/logParser";

/**
 * Headless build-error watcher. Subscribes to the daemon's terminal stream (and
 * the in-browser term bus) and classifies compile/build output into the store's
 * errorBanner. Mounted once at the IDE shell level so detection keeps working
 * even when the Terminal pane is hidden (Apprentice mode), where the friendly
 * floating alert renders instead of the engineering banner.
 */
export function ErrorWatcher() {
  const setErrorBanner = useStore((s) => s.setErrorBanner);

  useEffect(() => {
    const handle = (data: string) => {
      const verdict = classifyLog(data);
      if (verdict !== undefined) setErrorBanner(verdict); // ErrorBanner | null(clear)
    };
    const offBus = termBus.subscribe(handle);
    const offDaemon = daemon.onMessage((m) => {
      if (m.type === "terminal_output") handle(m.data);
    });
    return () => {
      offBus();
      offDaemon();
    };
  }, [setErrorBanner]);

  return null;
}
