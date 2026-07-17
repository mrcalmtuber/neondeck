import { useState } from "react";
import { API_PRICE_LABEL, apiCostUsd, type DevKeyInfo } from "@ide/shared";
import { useStore } from "../lib/store";
import { daemon } from "../lib/daemonClient";
import { isEmailVerified, refreshEmailVerified } from "../lib/firebaseClient";
import { sendBestVerificationEmail } from "../lib/verifyEmail";
import { ApiBillingWarning } from "./ApiBillingWarning";

/** Compact token count: 1.2M / 340K / 512. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}
/** Dollars with a floor so tiny non-zero spend doesn't read as $0.00. */
function fmtUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/**
 * Settings → "Dev" — the developer program section (rendered right under
 * Plan & billing). Four states:
 *   not registered  → register (joins the waitlist)
 *   waitlisted      → "you'll get an email when accepted (~2 days)"
 *   accepted, no card → add a card (one Stripe checkout = card + metered billing)
 *   accepted + card → API keys (create/revoke) + the in-IDE billing toggle
 * Both billed-usage commitments (key creation, in-IDE billing) go through the
 * ApiBillingWarning acknowledgement first.
 */
export function DevProgramSection() {
  const dev = useStore((s) => s.dev);
  const setDev = useStore((s) => s.setDev);
  const authMode = useStore((s) => s.authMode);
  const email = useStore((s) => s.session?.email ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Email/password accounts start unverified; the daemon requires a verified
  // email before it will enroll them (the acceptance email must reach a real
  // inbox). Offer a working verify flow instead of a dead-end error.
  const [verified, setVerified] = useState(isEmailVerified());
  const [verifySent, setVerifySent] = useState(false);
  const [warnFor, setWarnFor] = useState<"key" | "toggle" | null>(null);
  const [newKey, setNewKey] = useState<{ prefix: string; plaintext: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // The daemon omits `dev` when the program is disabled; dev-auth users have no
  // real email/card identity to enroll.
  if (!dev || authMode === "dev") return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    run(async () => {
      try {
        setDev(await daemon.devRegister());
      } catch (err) {
        // If the daemon still rejects for verification (e.g. a token issued before
        // the email was verified), drop into the verify flow so a resend + recheck
        // can force a fresh token instead of leaving a dead-end error.
        if (err instanceof Error && /verify your email/i.test(err.message)) setVerified(false);
        throw err;
      }
    });

  const sendVerify = () =>
    run(async () => {
      // Branded Resend email daemon-first, Firebase's sender as the fallback —
      // the same shared path the sign-up flow uses (verifyEmail.ts).
      await sendBestVerificationEmail();
      setVerifySent(true);
    });

  const recheck = () =>
    run(async () => {
      const ok = await refreshEmailVerified();
      if (!ok) throw new Error("Not verified yet — click the link in the email, then try again.");
      setVerified(true);
      // Reconnect so the daemon picks up the fresh, verified token before Register.
      daemon.disconnect();
      useStore.getState().requestConnect();
    });

  const addCard = () =>
    run(async () => {
      window.location.href = await daemon.devCardCheckout();
    });

  const confirmWarned = () => {
    const target = warnFor;
    setWarnFor(null);
    if (target === "key") {
      void run(async () => {
        const key = await daemon.devCreateKey();
        setCopied(false);
        setNewKey({ prefix: key.prefix, plaintext: key.plaintext });
      });
    } else if (target === "toggle") {
      void run(async () => setDev(await daemon.devSetBillInIde(true)));
    }
  };

  const revoke = (key: DevKeyInfo) => {
    if (!window.confirm(`Revoke ${key.prefix}…? Apps using it stop working immediately.`)) return;
    void run(async () => setDev(await daemon.devRevokeKey(key.id)));
  };

  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.plaintext);
      setCopied(true);
    } catch {
      /* the key stays visible for manual copy */
    }
  };

  const activeKeys = (dev.keys ?? []).filter((k) => !k.revoked);
  const inAll = dev.usageInputTokens ?? 0;
  const outAll = dev.usageOutputTokens ?? 0;
  const inMonth = dev.usageMonthInputTokens ?? 0;
  const outMonth = dev.usageMonthOutputTokens ?? 0;
  const monthCost = apiCostUsd(inMonth, outMonth);
  const totalCost = apiCostUsd(inAll, outAll);
  const apiBase = `${window.location.origin}/api/v1`;

  return (
    <section className="settings-card glass wide">
      <h3>🧩 Developer API</h3>

      {dev.status === "none" &&
        (verified ? (
          <>
            <p className="muted">
              Build with the Kryct Agent from your own code — programmatic agent runs, billed
              per use.
            </p>
            <button className="btn-neon sm" onClick={register} disabled={busy}>
              {busy ? "Registering…" : "Register as a developer"}
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Verify your email to join the developer program — the acceptance email is sent to
              {email ? ` ${email}` : " your address"}.
            </p>
            {verifySent ? (
              <>
                <p className="muted small">
                  ✅ Verification email sent. Open it, click the link, then continue.
                </p>
                <button className="btn-neon sm" onClick={recheck} disabled={busy}>
                  {busy ? "Checking…" : "I've verified — continue"}
                </button>
              </>
            ) : (
              <button className="btn-neon sm" onClick={sendVerify} disabled={busy}>
                {busy ? "Sending…" : "Send verification email"}
              </button>
            )}
          </>
        ))}

      {dev.status === "waitlist" && (
        <p className="muted">
          ⏳ You're on the waitlist — you'll get an email when you're accepted (usually ~2 days).
          {dev.registeredAt ? ` Registered ${new Date(dev.registeredAt).toLocaleDateString()}.` : ""}
        </p>
      )}

      {dev.status === "accepted" && !dev.cardOnFile && (
        <>
          <p className="muted">
            🎉 You're accepted. Add a payment card to create API keys — usage is unlimited and
            metered: <strong>{API_PRICE_LABEL}</strong>.
          </p>
          <button className="btn-neon sm" onClick={addCard} disabled={busy}>
            {busy ? "Opening checkout…" : "Add payment card"}
          </button>
        </>
      )}

      {dev.status === "accepted" && dev.cardOnFile && (
        <>
          <p className="muted">
            Metered API billing is active: <strong>{API_PRICE_LABEL}</strong>, charged to your card.
          </p>

          {/* Usage & cost so far (metered API — safe to show; distinct from the
              consumer Sparks allowance). Updates after each billed run. */}
          <div className="dev-stats">
            <div className="dev-stat">
              <span className="dev-stat-value">{fmtUsd(monthCost)}</span>
              <span className="dev-stat-label">Spent this month</span>
            </div>
            <div className="dev-stat">
              <span className="dev-stat-value">{fmtUsd(totalCost)}</span>
              <span className="dev-stat-label">All-time spend</span>
            </div>
            <div className="dev-stat">
              <span className="dev-stat-value">{fmtTokens(inAll)}</span>
              <span className="dev-stat-label">Input tokens</span>
            </div>
            <div className="dev-stat">
              <span className="dev-stat-value">{fmtTokens(outAll)}</span>
              <span className="dev-stat-label">Output tokens</span>
            </div>
            <div className="dev-stat">
              <span className="dev-stat-value">{activeKeys.length}</span>
              <span className="dev-stat-label">Active keys</span>
            </div>
          </div>
          <p className="muted small dev-stat-note">
            Spend is estimated from token usage at {API_PRICE_LABEL}; your Stripe invoice is the
            source of truth.
          </p>

          {/* Quick-start: where to point requests. */}
          <div className="dev-endpoint">
            <span className="muted small">Agent runs endpoint</span>
            <code>POST {apiBase}/runs</code>
          </div>

          <h4 className="dev-subhead">API keys</h4>
          {activeKeys.length > 0 && (
            <ul className="dev-key-list">
              {activeKeys.map((k) => (
                <li key={k.id} className="dev-key-row">
                  <code>{k.prefix}…</code>
                  <span className="muted">
                    created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                  </span>
                  <button className="btn-ghost sm" onClick={() => revoke(k)} disabled={busy}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button className="btn-neon sm" onClick={() => setWarnFor("key")} disabled={busy}>
            {busy ? "Working…" : "Create API key"}
          </button>

          <label className="dev-toggle">
            <input
              type="checkbox"
              checked={dev.billInIde}
              disabled={busy}
              onChange={(e) => {
                if (e.target.checked) setWarnFor("toggle");
                else void run(async () => setDev(await daemon.devSetBillInIde(false)));
              }}
            />
            <span>
              Bill the in-IDE agent to my API key <span className="muted">(no Sparks limits — every use is charged)</span>
            </span>
          </label>
        </>
      )}

      {error && <div className="auth-error">⚠️ {error}</div>}

      {warnFor && (
        <ApiBillingWarning
          confirmLabel={warnFor === "key" ? "Create key" : "Switch billing"}
          busy={busy}
          onConfirm={confirmWarned}
          onCancel={() => setWarnFor(null)}
        />
      )}

      {newKey && (
        <div className="modal-backdrop">
          <div className="modal api-key-modal glass" onClick={(e) => e.stopPropagation()}>
            <div className="paywall-icon">🔑</div>
            <h2>Your new API key</h2>
            <p className="paywall-msg">
              Copy it now — <strong>you won't see this key again.</strong>
            </p>
            <code className="dev-key-plaintext">{newKey.plaintext}</code>
            <div className="modal-actions">
              <button className="btn-neon" onClick={copyKey}>
                {copied ? "Copied ✓" : "Copy key"}
              </button>
              <button className="btn-ghost" onClick={() => setNewKey(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
