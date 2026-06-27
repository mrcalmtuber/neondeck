import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { termBus } from "../lib/termBus";

/**
 * The Live View window. Hosts a responsive iframe pointed at the daemon's preview
 * gateway (/previews/<slot>/), which routes to the user's running app. When the
 * daemon detects a build-success / HMR string in the dev-server logs it pushes
 * `preview_reload`, and we soft-refresh the iframe for sub-second visual updates.
 */
export function LiveView() {
  const previewUrl = useStore((s) => s.previewUrl);
  const previewSlot = useStore((s) => s.previewSlot);
  const setPreview = useStore((s) => s.setPreview);
  // Zero-config Run: the daemon auto-detects how to start the project (npm for
  // Node, a built-in static server otherwise) and allocates the preview port, so
  // these are fixed defaults with no UI to tweak.
  const port = 3000;
  const image = "node:20-alpine";
  const cmd = "npm install && npm run dev";
  const [nonce, setNonce] = useState(0); // bumping the key remounts the iframe
  const [booting, setBooting] = useState(false); // app port not reachable yet
  const slotRef = useRef<string | null>(null);
  slotRef.current = previewSlot;
  const bootingRef = useRef(false);
  bootingRef.current = booting;
  const bootTimerRef = useRef<number | null>(null);

  // Soft-refresh on HMR / build-success broadcasts for our active slot.
  useEffect(() => {
    return daemon.onMessage((m) => {
      if (m.type === "preview_reload" && m.slot === slotRef.current) {
        setBooting(false); // the app port is live now — drop the boot overlay
        if (bootTimerRef.current) {
          clearTimeout(bootTimerRef.current);
          bootTimerRef.current = null;
        }
        setNonce((n) => n + 1);
      }
    });
  }, []);

  async function boot() {
    try {
      setBooting(true);
      const { proxyUrl, slot } = await daemon.startContainer(image, cmd, port);
      setPreview(proxyUrl, slot);
      // Safety: if no "ready" reload arrives in 2 min, lift the overlay and point
      // the user at the terminal instead of leaving them on a silent spinner.
      if (bootTimerRef.current) clearTimeout(bootTimerRef.current);
      bootTimerRef.current = window.setTimeout(() => {
        if (!bootingRef.current) return; // already became ready
        setBooting(false);
        termBus.write(
          `\r\n\x1b[33m⚠️ App didn't start within 2 min — check the terminal output above (build error or wrong start command?).\x1b[0m\r\n`,
        );
      }, 120_000);
    } catch (err) {
      setBooting(false);
      const msg = err instanceof Error ? err.message : String(err);
      termBus.write(`\r\n\x1b[31m✖ ${msg}\x1b[0m\r\n`);
    }
  }

  return (
    <div className="liveview">
      <div className="liveview-toolbar">
        <span className="liveview-title">▶ Preview</span>
        <button className="btn-primary sm" onClick={boot} title="Start the dev server">
          ⏵ Run
        </button>
        <button className="btn-ghost sm" onClick={() => setNonce((n) => n + 1)} title="Reload">
          ⟳
        </button>
      </div>

      <div className="iframe-canvas">
        {previewUrl ? (
          <iframe
            key={nonce}
            title="App Preview"
            src={previewUrl}
            // Allow interaction + scripts from the user's own app.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          />
        ) : (
          <div className="muted iframe-empty">Start the dev server to preview your app here.</div>
        )}
        {booting && (
          <div className="iframe-booting">
            <span className="spinner" />
            <span>Starting your app… first build can take a moment.</span>
          </div>
        )}
      </div>
    </div>
  );
}
