import { useState, useEffect } from "react";
import {
  signIn,
  signUp,
  signInWithGoogle,
  getRedirectError,
  resetPassword,
  getSignInMethods,
} from "../lib/firebaseClient";
import { isSafari } from "../lib/browser";
import { BRAND_LABEL } from "../lib/brand";
import { TIER_LIST } from "@ide/shared";

/** Safari can't complete Firebase's cross-site Google OAuth — gate it off there. */
const GOOGLE_UNAVAILABLE = isSafari();

/**
 * Login / Registration gateway — the synthwave entry gate.
 *
 * Shown in place of everything else until the visitor is authenticated. There is
 * NO bypass: the email/password form talks straight to Firebase Auth
 * (signInWithEmailAndPassword / createUserWithEmailAndPassword). A successful
 * sign-in updates the session (via onIdTokenChanged in App) and transitions to
 * the dashboard. Errors surface as neon-pink warning text on the card.
 */
export function AuthGateway() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Forgot-password popup (its own email input, independent of the form).
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  // Surface any error from a returning Google redirect sign-in (otherwise a
  // blocked/failed redirect would silently drop the user back here).
  useEffect(() => {
    getRedirectError().then((err) => {
      if (err) setError(friendlyAuthError(err));
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "register") {
        await createAccount();
      } else {
        await signIn(email, password);
        // onIdTokenChanged (subscribed in App) populates the session + lands the
        // user on the dashboard.
      }
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    await signUp(email, password);
    // Firebase signs the new user in immediately — App transitions on its own.
  }

  // Open the forgot-password popup, prefilling whatever's already typed.
  function openForgot() {
    setResetEmail(email);
    setResetErr(null);
    setResetMsg(null);
    setForgotOpen(true);
  }

  // Send the reset link to the email typed in the popup.
  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    setResetErr(null);
    setResetMsg(null);
    const addr = resetEmail.trim();
    if (!addr) {
      setResetErr("Enter your email.");
      return;
    }
    setResetBusy(true);
    try {
      // If we can tell this email has no password (e.g. a Google account), say so
      // instead of pretending a link was sent (Firebase can't reset a passwordless
      // account). Best-effort — returns [] when enumeration protection is on.
      const methods = await getSignInMethods(addr);
      if (methods.length > 0 && !methods.includes("password")) {
        setResetErr(
          methods.includes("google.com")
            ? "That email signs in with Google — there's no password to reset. Use “Continue with Google”."
            : "That email uses a different sign-in method — there's no password to reset.",
        );
        return;
      }
      await resetPassword(addr);
      setResetMsg(
        `If an account with a password exists for ${addr}, a reset link is on its way — check your inbox and spam. (Accounts that use “Continue with Google” won't get one.)`,
      );
    } catch (err) {
      setResetErr(friendlyAuthError(err));
    } finally {
      setResetBusy(false);
    }
  }

  async function google() {
    if (GOOGLE_UNAVAILABLE) return; // disabled in Safari — defense in depth
    setBusy(true);
    setError(null);
    setNotice(null);
    // Redirect navigates the page away on success; this timeout only fires if the
    // redirect never even starts (e.g. Safari blocks it), so the UI never hangs.
    const timer = window.setTimeout(() => {
      setBusy(false);
      setError(
        "Google sign-in is taking too long in this browser. Try email/password, the Skip button, or use Chrome.",
      );
    }, 12000);
    try {
      await signInWithGoogle();
      // On success the page redirects to Google and back; onIdTokenChanged
      // (subscribed in App) then populates the session and lands the user on the
      // dashboard — no extra wiring needed here.
    } catch (err) {
      setError(friendlyAuthError(err));
      setBusy(false);
    } finally {
      window.clearTimeout(timer);
    }
  }

  return (
    <div className="auth-gateway">
      <div className="auth-card glass">
        <div className="auth-brand">{BRAND_LABEL}</div>
        <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="subtitle">
          {mode === "login"
            ? "Sign in to open your private workspaces."
            : "Start free — effort-based pricing, no card required."}
        </p>

        <form onSubmit={submit} className="auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {mode === "login" && (
            <button
              type="button"
              className="linklike auth-forgot"
              onClick={openForgot}
              disabled={busy}
            >
              Forgot password?
            </button>
          )}

          {error && <div className="auth-error">⚠️ {error}</div>}
          {notice && <div className="auth-notice">✓ {notice}</div>}

          <button className="btn-primary wide" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
          </button>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <button
            type="button"
            className="btn-google wide"
            onClick={google}
            disabled={busy || GOOGLE_UNAVAILABLE}
            title={GOOGLE_UNAVAILABLE ? "Google sign-in isn't supported in Safari" : undefined}
          >
            <GoogleGlyph />
            Continue with Google
          </button>
          {GOOGLE_UNAVAILABLE && (
            <p className="muted auth-hint">
              Sign in with Google is unavailable in Safari — use email &amp; password.
            </p>
          )}

          <div className="auth-switch">
            {mode === "login" ? (
              <>
                New here?{" "}
                <button type="button" className="linklike" onClick={() => setMode("register")}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have one?{" "}
                <button type="button" className="linklike" onClick={() => setMode("login")}>
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>

        <div className="auth-plans">
          {TIER_LIST.map((t) => (
            <div key={t.key} className="auth-plan">
              <span className="auth-plan-name">{t.name}</span>
              <span className="auth-plan-price">{t.priceLabel}<small>/mo</small></span>
              <span className="auth-plan-tokens">{t.tokenLabel}</span>
            </div>
          ))}
        </div>
      </div>

      {forgotOpen && (
        <div className="modal-backdrop" onClick={() => setForgotOpen(false)}>
          <div className="modal dialog glass" onClick={(e) => e.stopPropagation()}>
            <h3>Reset your password</h3>
            <p className="subtitle">Enter your account email and we’ll send a reset link.</p>
            <form onSubmit={sendReset} className="auth-form">
              <label>
                Email
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                  autoComplete="email"
                />
              </label>
              {resetErr && <div className="auth-error">⚠️ {resetErr}</div>}
              {resetMsg && <div className="auth-notice">✓ {resetMsg}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setForgotOpen(false)}
                  disabled={resetBusy}
                >
                  Close
                </button>
                <button type="submit" className="btn-primary" disabled={resetBusy}>
                  {resetBusy ? "Sending…" : "Send reset link"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/** Official multi-color Google "G" mark for the OAuth button. */
function GoogleGlyph() {
  return (
    <svg className="google-glyph" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Translate Firebase Auth error codes into clean, human warning text. */
function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google popup — allow popups and retry.";
    case "auth/account-exists-with-different-credential":
      return "An account already exists with this email. Sign in with your password instead.";
    case "auth/unauthorized-domain":
      return "This domain isn't authorized for Google sign-in in the Firebase console.";
    case "auth/operation-not-allowed":
      return "Google sign-in isn't enabled for this project yet.";
    case "auth/invalid-email":
      return "That email address looks invalid.";
    case "auth/missing-password":
      return "Enter your password to continue.";
    case "auth/weak-password":
      return "Password is too weak — use at least 6 characters.";
    case "auth/email-already-in-use":
      return "An account already exists for that email. Try signing in.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error reaching Firebase. Check your connection.";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
