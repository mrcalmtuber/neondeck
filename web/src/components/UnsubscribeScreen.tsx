import { useState } from "react";
import { confirmUnsubscribe } from "../lib/daemonClient";
import { BRAND_LABEL, PLATFORM_NAME, SUPPORT_EMAIL } from "../lib/brand";

/**
 * Step 2 of the two-step email unsubscribe. The email's "Unsubscribe" link
 * lands here (…/?unsub=<uid>&t=<token>) — the opt-out is NOT applied until the
 * user confirms below. Works signed-out (the signed token authorizes it), so it
 * renders standalone, ahead of the auth gate.
 */
export function UnsubscribeScreen({ uid, token }: { uid: string; token: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setErr(null);
    const ok = await confirmUnsubscribe(uid, token);
    setBusy(false);
    if (ok) setDone(true);
    else setErr(`This link isn't valid or has expired. Email ${SUPPORT_EMAIL} and we'll help.`);
  }

  return (
    <div className="unsub-screen">
      <div className="unsub-card glass">
        <div className="unsub-logo wordmark">{BRAND_LABEL}</div>
        {done ? (
          <>
            <h1>You've been unsubscribed</h1>
            <p className="muted">
              You won't receive marketing or product emails from {PLATFORM_NAME} anymore. Important
              account and security notices may still be sent. You can re-subscribe anytime in
              Settings → Email.
            </p>
            <a className="btn-primary" href="/">
              Return to {PLATFORM_NAME}
            </a>
          </>
        ) : (
          <>
            <h1>Unsubscribe from emails?</h1>
            <p className="muted">
              Confirm below to stop receiving marketing and product emails from {PLATFORM_NAME}.
              You'll miss launch discounts, new templates, and tips — but you can re-subscribe
              anytime in Settings.
            </p>
            {err && <div className="auth-error">⚠️ {err}</div>}
            <div className="unsub-actions">
              <a className="btn-ghost" href="/">
                Keep me subscribed
              </a>
              <button className="btn-danger" onClick={confirm} disabled={busy}>
                {busy ? "Unsubscribing…" : "Unsubscribe"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
