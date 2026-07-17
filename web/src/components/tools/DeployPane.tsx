import { useState } from "react";
import { getTier } from "@ide/shared";
import { daemon } from "../../lib/daemonClient";
import { useStore } from "../../lib/store";

/**
 * Deployments — put the running app on a public URL (Replit's Deployments).
 * Backed by the existing share tunnel (start/stop + live tunnel_status pushes
 * already land in the store). Paid plans publish without limits; Free gets 30
 * days from its FIRST publish (daemon-enforced), after which the CTA flips to
 * the upgrade modal instead of dead-ending.
 */
export function DeployPane() {
  const tunnel = useStore((s) => s.tunnel);
  const setTunnel = useStore((s) => s.setTunnel);
  const tier = useStore((s) => s.tier());
  const usage = useStore((s) => s.usage);
  const previewUrl = useStore((s) => s.previewUrl);
  const setSubscriptionModalOpen = useStore((s) => s.setSubscriptionModalOpen);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const cfg = getTier(tier);

  // Free-tier 30-day publish window (daemon-enforced; this mirrors it in the UI).
  const endsAt = usage?.freePublishEndsAt; // number | null (Free) | undefined (paid)
  const trialExpired = !cfg.canPublish && typeof endsAt === "number" && Date.now() > endsAt;
  const trialDaysLeft =
    !cfg.canPublish && typeof endsAt === "number" && !trialExpired
      ? Math.max(1, Math.ceil((endsAt - Date.now()) / 86_400_000))
      : null;
  const publishOk = cfg.canPublish || !trialExpired;

  async function start() {
    if (!publishOk) {
      setSubscriptionModalOpen(true);
      return;
    }
    setBusy(true);
    setTunnel({ state: "starting" });
    try {
      const st = await daemon.startTunnel();
      setTunnel({ state: st.state, url: st.url, message: st.message });
    } catch (err) {
      setTunnel({ state: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    daemon.stopTunnel();
    setTunnel({ state: "closed" });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the URL is selectable */
    }
  }

  const open = tunnel.state === "open" && tunnel.url;

  return (
    <div className="tool-panel">
      <div className="tool-head">
        <span className="tool-title">🚀 Deployments</span>
      </div>
      <div className="tool-scroll">
        <div className="deploy-card">
          <div className="deploy-card-head">
            <span className="deploy-card-title">Public share link</span>
            {open ? (
              <span className="mock-chip live">● Live</span>
            ) : tunnel.state === "starting" ? (
              <span className="muted small">starting…</span>
            ) : null}
          </div>
          <p className="muted small">
            A public URL for the app running in your Webview — anyone with the link can use it
            while it's live.
          </p>
          {!previewUrl && !open && publishOk && (
            <p className="muted small">⏵ Run your app in the Webview tab first.</p>
          )}
          {!cfg.canPublish &&
            (trialExpired ? (
              <p className="muted small">
                ⏳ Your 30 free days of publishing have ended — upgrade to bring your app back
                online.
              </p>
            ) : trialDaysLeft != null ? (
              <p className="muted small">
                ⏳ Free plan: {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} of publishing
                left — upgrade to keep your links live after that.
              </p>
            ) : (
              <p className="muted small">
                Free plan includes 30 days of public publishing, counted from your first deploy.
              </p>
            ))}
          {open ? (
            <>
              <div className="deploy-url-row">
                <code className="deploy-url">{tunnel.url}</code>
                <button className="btn-ghost sm" onClick={() => copy(tunnel.url!)}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <a className="btn-ghost sm" href={tunnel.url} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
              </div>
              <button className="btn-ghost sm" onClick={stop}>
                Stop sharing
              </button>
            </>
          ) : (
            <button
              className="btn-primary sm"
              onClick={start}
              disabled={busy || tunnel.state === "starting" || (!previewUrl && publishOk)}
              title={publishOk ? undefined : "Your free publishing window has ended"}
            >
              {publishOk ? "Start share link" : "⚡ Upgrade to keep publishing"}
            </button>
          )}
          {tunnel.state === "error" && tunnel.message && (
            <div className="auth-error">⚠️ {tunnel.message}</div>
          )}
        </div>

        <div className="deploy-card">
          <div className="deploy-card-head">
            <span className="deploy-card-title">GitHub backup</span>
          </div>
          <p className="muted small">
            Every project can sync to your own GitHub — use the Git tool to commit &amp; push, or
            connect GitHub in Settings for automatic backups.
          </p>
        </div>
      </div>
    </div>
  );
}
