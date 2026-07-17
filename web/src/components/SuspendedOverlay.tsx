import { useState } from "react";
import { useStore } from "../lib/store";
import { submitSuspensionAppeal } from "../lib/daemonClient";
import { SUPPORT_EMAIL } from "../lib/brand";

/**
 * Per-user suspension lockout. Full-screen "you have been suspended" screen shown to
 * a NON-admin whose account an admin has suspended (with an optional custom message).
 * Admins are exempt so the owner can't lock themselves out of the admin panel.
 * Driven by `store.suspended` (from hello + live `suspension_changed` pushes), so it
 * flips without a reload.
 *
 * Appeals: the form relays the user's message to the support inbox through the
 * daemon (Resend, reply-to their account email). If that path isn't available,
 * the mailto: link to support@kryct.com is always there as the fallback.
 */
export function SuspendedOverlay() {
  const isAdmin = useStore((s) => s.isAdmin);
  const suspended = useStore((s) => s.suspended);
  const message = useStore((s) => s.suspendMessage);
  const appealable = useStore((s) => s.suspendAppealable);
  const session = useStore((s) => s.session);

  const [appeal, setAppeal] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!suspended || isAdmin) return null;

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `Suspension appeal — ${session?.email ?? "my account"}`,
  )}`;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSending(true);
    try {
      const r = await submitSuspensionAppeal(appeal.trim(), session?.token ?? null);
      if (r.ok) setSent(true);
      else setErr(`Direct sending isn't set up on this server — email us at ${SUPPORT_EMAIL}.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="maint-overlay" role="alertdialog" aria-modal="true">
      <div className="maint-card">
        <div className="maint-icon">🚫</div>
        <h1>Your account has been suspended</h1>
        {message && <p className="suspend-reason">{message}</p>}
        <p>
          Following a review of activity associated with your account, we've determined that it
          violates our <a href="/terms">Terms of Service</a>. We hold every account to the same
          standard to keep Kryct safe and fair for everyone — we encourage you to read the{" "}
          <a href="/terms">Terms</a> and the <a href="/acceptable-use">Acceptable Use Policy</a> to
          understand what led to this decision.
        </p>

        {appealable ? (
          <>
            <p>
              If you believe this determination was made in error, we sincerely want to hear from
              you. Submit an appeal below, or write to us at{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — a member of our team will
              personally review your case and respond.
            </p>

            {sent ? (
              <p className="appeal-sent">
                ✓ Appeal sent — we'll review it and reply to{" "}
                {session?.email ?? "your account email"}.
              </p>
            ) : (
              <form className="appeal-form" onSubmit={send}>
                <label className="muted small" htmlFor="appeal-text">
                  Think this is a mistake? Tell us what happened and we'll take a look.
                </label>
                <textarea
                  id="appeal-text"
                  value={appeal}
                  onChange={(e) => setAppeal(e.target.value)}
                  placeholder="Explain why your account should be reinstated…"
                  maxLength={2000}
                  rows={4}
                />
                {err && <div className="auth-error">⚠️ {err}</div>}
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={sending || appeal.trim().length < 10}
                >
                  {sending ? "Sending…" : "Send appeal"}
                </button>
              </form>
            )}

            <p className="muted small appeal-alt">
              Or email us directly: <a href={mailto}>{SUPPORT_EMAIL}</a>
            </p>
          </>
        ) : (
          <p className="suspend-final">
            Due to the severity of this violation, this decision is final and cannot be appealed.
          </p>
        )}
      </div>
    </div>
  );
}
