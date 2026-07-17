import { requestEmailVerification } from "./daemonClient";
import { sendVerificationEmail, getIdToken } from "./firebaseClient";

/**
 * Send the signed-in user an email-verification email, the reliable way:
 * daemon-first (branded Resend email from the verified kryct.com domain — see
 * POST /api/auth/verify-email), falling back to Firebase's own sender only when
 * the daemon can't send (Admin SDK / Resend not configured, or unreachable).
 *
 * Shared by the sign-up path (AuthGateway) and the Settings → Developer resend
 * button so every route into verification uses the same delivery order.
 */
export async function sendBestVerificationEmail(): Promise<void> {
  let sent = false;
  try {
    const res = await requestEmailVerification(await getIdToken());
    sent = res.ok && !res.fallback;
  } catch {
    /* fall through to the Firebase sender */
  }
  if (!sent) await sendVerificationEmail();
}
