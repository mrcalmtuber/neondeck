import { API_PRICE_LABEL } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { DevStore } from "./devProgram.js";

/**
 * Waitlist auto-acceptance + the acceptance email.
 *
 * A background pass (2 min after boot, then hourly — see server.ts) accepts
 * anyone whose registration is older than DEV_WAITLIST_HOURS (~2 days) and
 * sends the "you're in" email through Resend's plain HTTPS API (no SDK).
 * Everything is best-effort and non-fatal:
 *   - no RESEND_API_KEY → acceptance still happens, silently;
 *   - a failed send → acceptance stands, emailSent stays false, retried next
 *     pass (Resend outages never wedge the program).
 */
export async function processDevWaitlist(
  config: DaemonConfig,
  devStore: DevStore,
  onAccepted?: (userId: string) => void,
): Promise<void> {
  if (!config.devProgramEnabled) return;
  try {
    const cutoff = Date.now() - config.devWaitlistHours * 3_600_000;
    const due = await devStore.dueForAcceptance(cutoff);
    for (const { userId, email } of due) {
      devStore.markAccepted(userId);
      if (config.resendApiKey && email && !devStore.emailAlreadySent(userId)) {
        try {
          await sendAcceptanceEmail(config, email);
          devStore.markEmailSent(userId); // only after a 2xx — never double-sends
        } catch (err) {
          console.warn(`[dev] acceptance email failed for ${userId}:`, (err as Error).message);
        }
      }
      onAccepted?.(userId);
    }
    if (due.length > 0) await devStore.flush();
  } catch (err) {
    console.warn("[dev] waitlist pass failed:", (err as Error).message);
  }
}

/** POST to Resend's plain HTTPS API (no SDK); throws on any non-2xx. */
export async function sendResendEmail(
  config: DaemonConfig,
  opts: { from: string; to: string; subject: string; html: string; replyTo?: string },
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** The waitlist "you're in" email; throws so the caller can retry next pass. */
async function sendAcceptanceEmail(config: DaemonConfig, email: string): Promise<void> {
  await sendResendEmail(config, {
    from: config.devEmailFrom,
    to: email,
    subject: "You're in — the Kryct Developer Program",
    html: acceptanceHtml(config.appOrigin),
  });
}

function acceptanceHtml(appOrigin: string): string {
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px">You've been accepted to the Kryct Developer Program 🎉</h2>
  <p>Your spot on the waitlist just came up. Here's how to get building with the Kryct API:</p>
  <ol style="line-height:1.7">
    <li>Open <strong>Settings → Developer</strong> on Kryct (the button below takes you straight there).</li>
    <li>Add a payment card.</li>
    <li>Create your API key and start making agent runs.</li>
  </ol>
  <p style="background:#f5f5f7;border-radius:8px;padding:12px 16px">
    API usage is <strong>unlimited and metered</strong> — ${API_PRICE_LABEL}, billed to your card.
  </p>
  <p><a href="${appOrigin}/?open=dev" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Open Kryct</a></p>
  <p style="color:#666;font-size:13px">— The Kryct team</p>
</div>`;
}

/** The email-verification email around a Firebase-generated verification link
 *  (URL-safe by construction — no HTML-escaping hazard interpolating it). */
export function emailVerificationHtml(link: string): string {
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;text-transform:uppercase;margin-bottom:18px">Kryct</div>
  <h2 style="margin:0 0 12px">Verify your email</h2>
  <p style="line-height:1.6">Confirm this is your address to finish setting up your Kryct account —
  it unlocks the developer program and account tools. Just click the button below.</p>
  <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Verify my email</a></p>
  <p style="color:#666;font-size:12px;word-break:break-all">Or paste this link into your browser:<br>${link}</p>
  <p style="color:#666;font-size:13px;border-top:1px solid #e5e5e5;padding-top:12px;margin-top:20px">
  If you didn't create a Kryct account, you can safely ignore this email.</p>
  <p style="color:#666;font-size:13px">— The Kryct team</p>
</div>`;
}

/** Project names are user input — escape them before interpolating into HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Snapshot-lifecycle warning: ~30 days idle, 2 days before the archive. */
export function projectWarningHtml(project: string, appOrigin: string): string {
  const name = escapeHtml(project);
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;text-transform:uppercase;margin-bottom:18px">Kryct</div>
  <h2 style="margin:0 0 12px">"${name}" will be archived in 2 days</h2>
  <p style="line-height:1.6">You haven't opened <strong>${name}</strong> on Kryct in about a month.
  To keep it, just open it — that's all it takes, and you can come back anytime.</p>
  <p style="background:#f5f5f7;border-radius:8px;padding:12px 16px;line-height:1.6">
  If you do nothing, the project will be <strong>archived in 2 days</strong> (you'll still be able
  to restore it or download a .zip for 24 hours), and permanently deleted after that.</p>
  <p style="margin:20px 0"><a href="${appOrigin}/" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Open Kryct</a></p>
  <p style="color:#666;font-size:13px">— The Kryct team</p>
</div>`;
}

/** Snapshot-lifecycle archive notice: 24 hours to restore or download. */
export function projectArchivedHtml(project: string, appOrigin: string): string {
  const name = escapeHtml(project);
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;text-transform:uppercase;margin-bottom:18px">Kryct</div>
  <h2 style="margin:0 0 12px">"${name}" has been archived</h2>
  <p style="line-height:1.6"><strong>${name}</strong> was archived after a month of inactivity.
  You have <strong>24 hours</strong> to act:</p>
  <ul style="line-height:1.7">
    <li><strong>Restore it</strong> with one click from your dashboard, or</li>
    <li><strong>Download a .zip</strong> backup of all its files.</li>
  </ul>
  <p style="line-height:1.6">After that, the project will be permanently deleted.</p>
  <p style="margin:20px 0"><a href="${appOrigin}/" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Open your dashboard</a></p>
  <p style="color:#666;font-size:13px">— The Kryct team</p>
</div>`;
}

/** The forgot-password email around a Firebase-generated reset link (the link
 *  is URL-safe by construction — no HTML-escaping hazard interpolating it). */
export function passwordResetHtml(link: string): string {
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;text-transform:uppercase;margin-bottom:18px">Kryct</div>
  <h2 style="margin:0 0 12px">Reset your password</h2>
  <p style="line-height:1.6">We received a request to reset the password for your Kryct account.
  Click the button below to choose a new one. The link expires in about an hour.</p>
  <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">Reset your password</a></p>
  <p style="color:#666;font-size:12px;word-break:break-all">Or paste this link into your browser:<br>${link}</p>
  <p style="color:#666;font-size:13px;border-top:1px solid #e5e5e5;padding-top:12px;margin-top:20px">
  If you didn't request this, you can safely ignore this email — your password won't change.</p>
  <p style="color:#666;font-size:13px">— The Kryct team</p>
</div>`;
}
