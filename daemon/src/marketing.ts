import { createHmac } from "node:crypto";
import type { DaemonConfig } from "./config.js";
import type { UsageStore } from "./usage.js";
import { sendResendEmail } from "./devEmail.js";

/**
 * Recurring marketing / lifecycle email engine.
 *
 * Segments each account and sends up to a per-week target, spaced across the
 * week (at most one send per scheduler pass, with a minimum gap). Targets:
 *   - opted-in + active (logged in this week)         → config.marketingWeeklyActive
 *   - opted-in + lapsed (not seen in ≥7 days)         → config.marketingWeeklyLapsed (win-back)
 *   - opted-OUT of marketing at sign-up               → config.marketingWeeklyOptOut
 *
 * Every email carries a one-click unsubscribe (a signed link) that HARD-stops
 * all future mail — required by anti-spam law (CAN-SPAM/GDPR/CASL) and Resend's
 * AUP, and the only thing standing between this cadence and a blacklisted domain.
 * The whole engine is OFF unless config.marketingEmails is set.
 */

const WEEK_MS = 7 * 86_400_000;

/** ISO-week key like "2026-W28" (bucket for the weekly send count). */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Signed unsubscribe token (stable per user; HMAC over the uid). */
export function unsubToken(userId: string, secret: string): string {
  return createHmac("sha256", secret || "kryct-unsub").update(userId).digest("hex").slice(0, 32);
}
export function verifyUnsub(userId: string, token: string, secret: string): boolean {
  const expected = unsubToken(userId, secret);
  // constant-ish comparison
  return token.length === expected.length && token === expected;
}

/** Rotating promo emails (opted-in). Kept upbeat, short, one CTA. */
const PROMOS: Array<{ subject: string; heading: string; body: string; cta: string }> = [
  {
    subject: "Build something today on Kryct 🚀",
    heading: "Your next app is one sentence away",
    body: "Describe an idea and the Kryct Agent writes the code, runs it in a real cloud workspace, and hands you a live preview. Come see what you can ship in ten minutes.",
    cta: "Open Kryct",
  },
  {
    subject: "New templates to remix",
    heading: "Start from a working app",
    body: "Full-stack starters, dashboards, bots, games — open one, tell the agent what to change, and make it yours. No setup, no config.",
    cta: "Browse templates",
  },
  {
    subject: "Unlock publishing + more Sparks",
    heading: "Ready for more?",
    body: "Pro and Max lift your monthly Sparks and let you publish apps on public URLs with no time limit. Yearly plans save 16%.",
    cta: "See plans",
  },
  {
    subject: "We miss you — here's what's new",
    heading: "Come back and build",
    body: "The agent's been busy. Reopen your workspace and pick up where you left off, or start something new in a single prompt.",
    cta: "Return to Kryct",
  },
];

/** A softer, non-promotional note for people who opted OUT of marketing. */
const OPTOUT_UPDATE = {
  subject: "Your Kryct account",
  heading: "A quick note from Kryct",
  body: "Your projects are saved and ready whenever you want to build. You're receiving this occasional account update because you have a Kryct account.",
  cta: "Open your workspace",
};

function emailHtml(
  appOrigin: string,
  unsubUrl: string,
  c: { heading: string; body: string; cta: string },
): string {
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;text-transform:uppercase;margin-bottom:18px">Kryct</div>
  <h2 style="margin:0 0 12px">${c.heading}</h2>
  <p style="line-height:1.6">${c.body}</p>
  <p style="margin:22px 0"><a href="${appOrigin}" style="display:inline-block;background:#2E72D2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">${c.cta}</a></p>
  <p style="color:#8a8f98;font-size:12px;border-top:1px solid #e5e5e5;padding-top:14px;margin-top:22px">
    You're receiving this because you have a Kryct account.
    <a href="${unsubUrl}" style="color:#8a8f98">Unsubscribe</a> from these emails at any time.
  </p>
</div>`;
}

/** Per-week target for an account given its segment. 0 = don't email. */
function weeklyTarget(
  acct: { marketingOptIn?: boolean; lastLoginAt?: number },
  config: DaemonConfig,
): number {
  if (acct.marketingOptIn === false) return Math.max(0, config.marketingWeeklyOptOut);
  const active = acct.lastLoginAt != null && Date.now() - acct.lastLoginAt < WEEK_MS;
  return active ? config.marketingWeeklyActive : config.marketingWeeklyLapsed;
}

/**
 * One scheduler pass: send at most one email to each account that's under its
 * weekly target and past the minimum gap. Best-effort and non-fatal.
 */
export async function processMarketingEmails(
  config: DaemonConfig,
  store: UsageStore,
): Promise<void> {
  if (!config.marketingEmails || !config.resendApiKey) return;
  const week = isoWeek();
  let sent = 0;
  try {
    const candidates = await store.marketingCandidates();
    for (const a of candidates) {
      if (!a.email) continue;
      const target = weeklyTarget(a, config);
      if (target <= 0) continue;
      const count = a.emailWeek === week ? a.emailWeekCount ?? 0 : 0;
      if (count >= target) continue;
      // Space sends across the week: require a gap of (7d / target), min 2 days.
      const minGap = Math.max(2 * 86_400_000, Math.floor(WEEK_MS / target));
      if (a.lastEmailAt != null && Date.now() - a.lastEmailAt < minGap) continue;

      const optedOut = a.marketingOptIn === false;
      const content = optedOut ? OPTOUT_UPDATE : PROMOS[count % PROMOS.length];
      // Link to the APP (not the API): it shows a confirmation popup that does
      // the actual opt-out — a deliberate two-step unsubscribe.
      const unsubUrl =
        `${config.appOrigin}/?unsub=${encodeURIComponent(a.userId)}` +
        `&t=${unsubToken(a.userId, config.resendApiKey)}`;
      try {
        await sendResendEmail(config, {
          from: config.devEmailFrom,
          to: a.email,
          subject: content.subject,
          html: emailHtml(config.appOrigin, unsubUrl, content),
        });
        store.noteMarketingSent(a.userId, week);
        sent++;
      } catch (err) {
        console.warn(`[marketing] send failed for ${a.userId}:`, (err as Error).message);
      }
    }
    if (sent > 0) {
      await store.flush();
      console.log(`[marketing] sent ${sent} email(s) this pass (week ${week})`);
    }
  } catch (err) {
    console.warn("[marketing] pass failed:", (err as Error).message);
  }
}
