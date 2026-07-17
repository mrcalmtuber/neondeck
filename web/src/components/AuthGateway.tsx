import { useState, useEffect } from "react";
import {
  signIn,
  signUp,
  signInWithGoogle,
  signInWithGithubToken,
  getRedirectError,
  getIdToken,
  resetPassword,
  getSignInMethods,
} from "../lib/firebaseClient";
import { connectGitHub, getStoredGithubToken, clearGithubToken } from "../lib/githubAuth";
import { requestPasswordReset, saveConsent } from "../lib/daemonClient";
import { sendBestVerificationEmail } from "../lib/verifyEmail";
import { BRAND_LABEL } from "../lib/brand";
import { TIER_LIST } from "@ide/shared";

/**
 * Login / Registration gateway.
 *
 * Reached from the public landing page (or restored directly after a Google
 * OAuth redirect). Shown until the visitor is authenticated. There is
 * NO bypass: the email/password form talks straight to Firebase Auth
 * (signInWithEmailAndPassword / createUserWithEmailAndPassword). A successful
 * sign-in updates the session (via onIdTokenChanged in App) and transitions to
 * the dashboard. Errors surface as flat red-tinted warning text on the card.
 */
interface AuthGatewayProps {
  /** Which form to show first (the landing page deep-links "Sign up" here). */
  initialMode?: "login" | "register";
  /** When set, renders a "← Back" link that returns to the landing page. */
  onBack?: () => void;
}

export function AuthGateway({ initialMode = "login", onBack }: AuthGatewayProps = {}) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  // Idea typed into the landing hero before auth — shown here as reassurance;
  // the Dashboard reads (and clears) the same stash to prefill its prompt box.
  const [pendingIdea] = useState(() => sessionStorage.getItem("kryct.pendingIdea"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sign-up consent: ToS is required to register; marketing is pre-checked and
  // unchecking it pops a "you'll miss deals" confirmation (persisted after
  // register via the daemon consent route). Google/GitHub sign-up implicitly
  // opts in (they skip this form) — the pre-checked default carries over.
  const [agreedTos, setAgreedTos] = useState(false);
  const [marketing, setMarketing] = useState(true);
  const [marketingWarn, setMarketingWarn] = useState(false);

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
    // Persist the consent choices with a fresh token (best-effort, non-blocking).
    void saveConsent(marketing, await getIdToken());
    // Send the verification email (branded Resend, Firebase fallback) —
    // best-effort; never blocks account creation.
    void sendBestVerificationEmail().catch(() => {});
  }

  // Unchecking marketing → confirm they really want to miss deals.
  function toggleMarketing(next: boolean) {
    if (!next) {
      setMarketingWarn(true); // opening the modal; actual value set by its buttons
      return;
    }
    setMarketing(true);
  }

  // Open the forgot-password popup, prefilling whatever's already typed.
  function openForgot() {
    setResetEmail(email);
    setResetErr(null);
    setResetMsg(null);
    setForgotOpen(true);
  }

  // Send the reset link to the email typed in the popup. Daemon-first: the
  // daemon sends a branded Kryct email through Resend (and can even reset a
  // Google-only account — completing it adds a password). When the daemon
  // says it can't (admin/Resend unset) or is unreachable, fall back to
  // Firebase's own default sender so the flow never dead-ends.
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
      let viaDaemon = false;
      try {
        const r = await requestPasswordReset(addr);
        if (r.ok) viaDaemon = true;
        else if (!r.fallback) throw new Error("Could not send the reset email.");
      } catch (err) {
        if (err instanceof Error && /Too many/.test(err.message)) {
          setResetErr(err.message);
          return;
        }
        /* network/abort — fall through to the Firebase sender */
      }
      if (!viaDaemon) {
        // Fallback path only: Firebase can't reset a passwordless account, so
        // warn about Google-only emails instead of pretending a link was sent.
        // Best-effort — returns [] when enumeration protection is on.
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
      }
      setResetMsg(
        `If an account exists for ${addr}, a reset link is on its way — check your inbox and spam.`,
      );
    } catch (err) {
      setResetErr(friendlyAuthError(err));
    } finally {
      setResetBusy(false);
    }
  }

  // Google OAuth via full-page redirect. Works in Safari too now: in production
  // the authDomain is our own origin (the daemon proxies /__/* to Firebase), so
  // the whole dance is same-site and ITP has nothing to block.
  async function google() {
    setBusy(true);
    setError(null);
    setNotice(null);
    // Redirect navigates the page away on success; this timeout only fires if the
    // redirect never even starts (e.g. a blocker interferes), so the UI never hangs.
    const timer = window.setTimeout(() => {
      setBusy(false);
      setError("Google sign-in is taking too long. Try email/password instead.");
    }, 12000);
    try {
      // Full-page redirect: remember which auth screen we were on so App can
      // restore it (instead of the landing page) when Google sends us back —
      // otherwise a failed redirect's error would never be seen.
      sessionStorage.setItem("kryct.authScreen", mode);
      await signInWithGoogle();
      // On success the page redirects out and back; onIdTokenChanged
      // (subscribed in App) then populates the session and lands the user on the
      // dashboard — no extra wiring needed here.
    } catch (err) {
      setError(friendlyAuthError(err));
      setBusy(false);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // GitHub sign-in via the daemon's OAuth popup (same-origin callback — Safari
  // safe), then exchange the repo-scoped token for a Firebase session directly.
  async function github() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hadToken = Boolean(getStoredGithubToken());
      const token = await connectGitHub();
      if (!token) {
        setError("GitHub sign-in was cancelled (or isn't configured on this server).");
        return;
      }
      if (!hadToken) {
        // connectGitHub auto-stores the token for project sync, but backups
        // stay OPT-IN: unstash it and park it for the post-login popup instead.
        clearGithubToken();
        sessionStorage.setItem("kryct.ghBindToken", token);
      }
      await signInWithGithubToken(token);
      // onIdTokenChanged (subscribed in App) picks the session up from here.
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-gateway">
      <div className="auth-card glass">
        {onBack && (
          <button type="button" className="linklike auth-back" onClick={onBack}>
            ← Back
          </button>
        )}
        <div className="auth-brand">{BRAND_LABEL}</div>
        <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="subtitle">
          {mode === "login"
            ? "Sign in to open your private workspaces."
            : "Start free — effort-based pricing, no card required."}
        </p>
        {pendingIdea && (
          <div className="auth-idea">
            💡 Idea saved: “{pendingIdea}” — it'll be waiting in your workspace.
          </div>
        )}

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

          {mode === "register" && (
            <div className="auth-consent">
              <label className="auth-check">
                <input
                  type="checkbox"
                  checked={agreedTos}
                  onChange={(e) => setAgreedTos(e.target.checked)}
                />
                <span>
                  I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>{" "}
                  and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
                </span>
              </label>
              <label className="auth-check">
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => toggleMarketing(e.target.checked)}
                />
                <span>Email me product updates, tips, and exclusive deals.</span>
              </label>
            </div>
          )}

          {error && <div className="auth-error">⚠️ {error}</div>}
          {notice && <div className="auth-notice">✓ {notice}</div>}

          <button
            className="btn-primary wide"
            type="submit"
            disabled={busy || (mode === "register" && !agreedTos)}
          >
            {busy ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
          </button>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <button
            type="button"
            className="btn-google wide"
            onClick={google}
            disabled={busy}
          >
            <GoogleGlyph />
            Continue with Google
          </button>
          <button
            type="button"
            className="btn-google wide"
            onClick={github}
            disabled={busy}
          >
            <span aria-hidden="true">🐙</span>
            Continue with GitHub
          </button>

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

      {marketingWarn && (
        <div className="modal-backdrop" onClick={() => setMarketingWarn(false)}>
          <div className="modal dialog glass" onClick={(e) => e.stopPropagation()}>
            <div className="policy-warning-icon">🎁</div>
            <h3>Are you sure you'll miss out?</h3>
            <p className="subtitle">
              Subscribers get first access to launch discounts, new templates, product tips, and
              exclusive deals — often the only place we share them. You can unsubscribe from any
              email in one click.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setMarketing(false);
                  setMarketingWarn(false);
                }}
              >
                No thanks
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setMarketing(true);
                  setMarketingWarn(false);
                }}
              >
                Keep me subscribed
              </button>
            </div>
          </div>
        </div>
      )}

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
      return "That sign-in method isn't enabled for this project yet.";
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
