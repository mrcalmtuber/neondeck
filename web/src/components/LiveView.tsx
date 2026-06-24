import { useEffect, useRef, useState } from "react";
import { canPublish, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon, DAEMON_HTTP } from "../lib/daemonClient";
import { termBus } from "../lib/termBus";

/**
 * The Live View window. Hosts a responsive iframe pointed at the daemon's stable
 * proxy gateway (e.g. http://localhost:9000/previews/app-1), which routes to the
 * user's running container. When the daemon detects a build-success / HMR string
 * in the dev server logs it pushes `preview_reload`, and we soft-refresh the
 * iframe for sub-second visual updates.
 */
export function LiveView() {
  const previewUrl = useStore((s) => s.previewUrl);
  const previewSlot = useStore((s) => s.previewSlot);
  const setPreview = useStore((s) => s.setPreview);
  // Zero-config Run: the daemon auto-detects how to actually start the project
  // (npm for Node, a built-in static server otherwise), so these are fixed
  // defaults with no UI to tweak — the old "Advanced" panel is gone.
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

  const transport = useStore((s) => s.transport);
  const tunnel = useStore((s) => s.tunnel);
  const setTunnel = useStore((s) => s.setTunnel);
  const tier = (useStore((s) => s.usage?.tier) ?? 0) as Tier;
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const canShare = canPublish(tier);
  const [copied, setCopied] = useState(false);

  // Soft-refresh on HMR / build-success broadcasts for our active slot, and keep
  // tunnel state in sync with late "closed"/broadcast updates.
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
      if (m.type === "tunnel_status" && m.id === "broadcast") {
        setTunnel({ state: m.state, url: m.url, message: m.message });
      }
    });
  }, [setTunnel]);

  async function share() {
    if (transport !== "daemon") return;
    // Public sharing is a paid feature — nudge free users to upgrade instead.
    if (!canShare) {
      setSubscriptionModalOpen(true);
      return;
    }
    setCopied(false);
    setTunnel({ state: "starting", message: "Opening a public link…" });
    try {
      const res = await daemon.startTunnel();
      setTunnel({ state: res.state, url: res.url, message: res.message });
    } catch (err) {
      setTunnel({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function stopSharing() {
    daemon.stopTunnel();
    setTunnel({ state: "idle" });
  }

  async function copyLink() {
    if (!tunnel.url) return;
    try {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  async function boot() {
    try {
      setBooting(true);
      const { proxyUrl, slot } = await daemon.startContainer(image, cmd, port);
      setPreview(proxyUrl, slot);
      // Safety: if no "ready" reload arrives in 2 min, lift the overlay and tell
      // the user where to look instead of leaving them on a silent spinner.
      if (bootTimerRef.current) clearTimeout(bootTimerRef.current);
      bootTimerRef.current = window.setTimeout(() => {
        if (!bootingRef.current) return; // already became ready
        setBooting(false);
        termBus.write(
          `\r\n\x1b[33m⚠️ App didn't respond on port ${port} within 2 min — check the terminal output above (wrong port or start command?).\x1b[0m\r\n`,
        );
      }, 120_000);
    } catch (err) {
      setBooting(false);
      const msg = err instanceof Error ? err.message : String(err);
      termBus.write(`\r\n\x1b[31m✖ ${msg}\x1b[0m\r\n`);
    }
  }

  // Until a preview is running, "Open in new tab" points at the daemon base.
  const openTarget = previewUrl ?? DAEMON_HTTP;

  return (
    <div className="liveview">
      <div className="liveview-linkbar">
        <a className="open-app-link" href={openTarget} target="_blank" rel="noreferrer">
          🔗 Open App in New Tab ({openTarget})
        </a>
        {transport === "daemon" && (
          tunnel.state === "open" ? (
            <button className="share-btn sharing" onClick={stopSharing} title="Stop the public link">
              🌐 Sharing — Stop
            </button>
          ) : (
            <button
              className="share-btn"
              onClick={share}
              disabled={tunnel.state === "starting"}
              title={canShare ? "Get a public link to your running app" : "Public sharing is a Pro feature — click to upgrade"}
            >
              {tunnel.state === "starting"
                ? "🌐 Connecting…"
                : canShare
                  ? "🌐 Share Live Preview"
                  : "🔒 Share Live Preview (Pro)"}
            </button>
          )
        )}
      </div>

      {transport === "daemon" && tunnel.state !== "idle" && (
        <div className={`tunnel-box ${tunnel.state}`}>
          {tunnel.state === "open" && tunnel.url ? (
            <>
              <span className="tunnel-label">Public link (live):</span>
              <input className="tunnel-url" readOnly value={tunnel.url} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-ghost sm" onClick={copyLink}>
                {copied ? "✓ Copied" : "📋 Copy"}
              </button>
              <a className="tunnel-open" href={tunnel.url} target="_blank" rel="noreferrer">
                open ↗
              </a>
            </>
          ) : tunnel.state === "starting" ? (
            <span className="muted">
              <span className="spinner" /> {tunnel.message || "Opening a public link…"}
            </span>
          ) : tunnel.state === "error" ? (
            <span className="tunnel-err">⚠️ {tunnel.message}</span>
          ) : (
            <span className="muted">Tunnel closed.</span>
          )}
        </div>
      )}
      <div className="liveview-toolbar">
        <span className="liveview-title">▶ Preview</span>
        <button className="btn-primary sm" onClick={boot} title="Start dev container">
          ⏵ Run
        </button>
        <button className="btn-ghost sm" onClick={() => setNonce((n) => n + 1)} title="Reload">
          ⟳
        </button>
        <input
          className="addr"
          value={previewUrl ?? `proxy gateway → /previews/<slot> (port ${port})`}
          onChange={(e) => setPreview(e.target.value, previewSlot)}
          spellCheck={false}
        />
      </div>

      <div className="iframe-canvas">
        {previewUrl ? (
          <iframe
            key={nonce}
            title="App Preview"
            src={previewUrl}
            // Allow interaction + scripts from the user's own local app.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          />
        ) : (
          <div className="muted iframe-empty">
            Start a dev container to preview your app here.
          </div>
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
