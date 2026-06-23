/**
 * Lightweight browser detection.
 *
 * Used to gate Google sign-in: Safari blocks the cross-site storage handshake the
 * Firebase OAuth handler (`*.firebaseapp.com`) needs from the `127.0.0.1` app
 * origin, so popup/redirect sign-in never completes there. We treat real Safari
 * (desktop + iOS) specially and let every other browser use Google normally.
 */

/** True only for genuine Safari — not Chrome/Edge/Firefox, incl. their iOS variants. */
export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const appleVendor = /apple/i.test(navigator.vendor ?? "");
  // Has "Safari" but none of the other engines' tokens (Chrome/Chromium, Chrome
  // iOS = CriOS, Firefox iOS = FxiOS, Edge = Edg, Opera = OPR, Android).
  const looksSafari = /^((?!chrome|chromium|crios|fxios|edg|android|opr).)*safari/i.test(ua);
  return appleVendor && looksSafari;
}
