import { BRAND_LABEL, PLATFORM_NAME, SUPPORT_EMAIL } from "../lib/brand";

/**
 * Static legal pages served at real URLs (/terms, /privacy, /acceptable-use) so
 * footer links, app-store forms and emails can point at them. No router: the
 * daemon's SPA fallback serves index.html for any path and App.tsx renders this
 * component when the pathname matches. Links here are plain <a> full loads.
 */
export type LegalKind = "terms" | "privacy" | "aup";

export function legalKindForPath(pathname: string): LegalKind | null {
  if (pathname === "/terms") return "terms";
  if (pathname === "/privacy") return "privacy";
  if (pathname === "/acceptable-use") return "aup";
  return null;
}

const UPDATED = "July 11, 2026";

export function LegalPage({ kind }: { kind: LegalKind }) {
  return (
    <div className="legal">
      <header className="legal-nav">
        <a className="wordmark legal-logo" href="/">
          {BRAND_LABEL}
        </a>
        <a className="legal-back" href="/">
          ← Back to {PLATFORM_NAME}
        </a>
      </header>
      <main className="legal-body">
        {kind === "terms" && <Terms />}
        {kind === "privacy" && <Privacy />}
        {kind === "aup" && <Aup />}
        <p className="muted legal-foot">
          Questions? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> · © {new Date().getFullYear()}{" "}
          {PLATFORM_NAME} ·{" "}
          <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·{" "}
          <a href="/acceptable-use">Acceptable use</a>
        </p>
      </main>
    </div>
  );
}

function Terms() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p>
        These terms govern your use of {PLATFORM_NAME} (kryct.com) — a cloud development platform
        where an AI agent helps you build, run, and share apps. By creating an account or using the
        service you agree to them.
      </p>
      <h2>1. Your account</h2>
      <p>
        You need an account (email/password, Google, or GitHub) to use {PLATFORM_NAME}. Keep your
        credentials secure — you're responsible for activity under your account. You must be at
        least 13 years old (or the minimum age in your country) to use the service.
      </p>
      <h2>2. Plans, Sparks & billing</h2>
      <p>
        Free and paid plans include a monthly allowance of agent usage measured in Sparks; actual
        capacity fluctuates with load and usage patterns. Paid subscriptions (monthly or yearly)
        are billed through Stripe and renew automatically until cancelled; you can change or cancel
        your plan anytime from Billing. Developer API usage is metered and billed per token to your
        card. Except where required by law, payments are non-refundable.
      </p>
      <h2>3. Publishing & the Free plan</h2>
      <p>
        Paid plans can publish and share apps on public URLs without a time limit. The Free plan
        includes 30 days of public publishing counted from your first publish; after that, an
        upgrade is required to bring published apps back online.
      </p>
      <h2>4. Your content</h2>
      <p>
        You own the code and content you create on {PLATFORM_NAME}. You grant us the limited rights
        needed to store, run, back up (including to your connected GitHub), and display it back to
        you — that's it. You're responsible for what you build and deploy, and for having the
        rights to any content you upload.
      </p>
      <h2>5. Acceptable use</h2>
      <p>
        Use of the platform must follow the <a href="/acceptable-use">Acceptable Use Policy</a>.
        We may suspend accounts that violate it. If you believe a suspension is a mistake, you can
        appeal in-app or by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — a
        human reviews every appeal.
      </p>
      <h2>6. The AI agent</h2>
      <p>
        The agent generates code and runs commands on your behalf inside your workspace. AI output
        can be wrong or insecure — review before relying on it in production. You are responsible
        for code the agent produces at your direction.
      </p>
      <h2>7. Service changes & availability</h2>
      <p>
        The service is provided "as is" without warranties. We work hard to keep it up, but we
        don't guarantee uninterrupted availability, and free-tier workspaces may sleep or be
        reclaimed. We may change or discontinue features with reasonable notice where practical.
      </p>
      <h2>8. Liability</h2>
      <p>
        To the maximum extent permitted by law, {PLATFORM_NAME} is not liable for indirect,
        incidental, or consequential damages, and our total liability is limited to the amount you
        paid us in the 12 months before the claim.
      </p>
      <h2>9. Termination</h2>
      <p>
        You can delete your account anytime in Settings. We may suspend or terminate accounts that
        break these terms or the Acceptable Use Policy. Sections that by their nature should
        survive (your content ownership, liability limits) survive termination.
      </p>
      <h2>10. Changes to these terms</h2>
      <p>
        We may update these terms; material changes will be announced in-app or by email. Using the
        service after changes take effect means you accept them.
      </p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p>
        This policy explains what {PLATFORM_NAME} collects and why. Short version: we collect what
        we need to run the service, we don't sell your data, and your code is yours.
      </p>
      <h2>1. What we collect</h2>
      <p>
        <strong>Account data</strong> — your email and sign-in identity, handled by Google
        Firebase Authentication (email/password, Google, or GitHub sign-in).{" "}
        <strong>Project data</strong> — the files, chat history, and settings of your workspaces,
        stored so your projects persist between sessions (including encrypted backups in Google
        Firestore and, when you connect it, private repos on your own GitHub account).{" "}
        <strong>Usage data</strong> — agent token usage (Sparks) and basic operational logs used
        for metering, abuse prevention, and debugging.
      </p>
      <h2>2. Payments</h2>
      <p>
        Payments are processed by Stripe; your card number never touches our servers. We store only
        the Stripe customer/subscription identifiers needed to manage your plan.
      </p>
      <h2>3. AI processing</h2>
      <p>
        Prompts you send to the agent, plus relevant project files, are processed by our AI model
        provider to generate responses. They are used to serve your request — not to train models
        on your private code by us.
      </p>
      <h2>4. Emails</h2>
      <p>
        Transactional emails (password resets, developer-program notices, support replies) are sent
        through Resend from a kryct.com address. We don't send marketing email.
      </p>
      <h2>5. Sharing</h2>
      <p>
        We don't sell personal data. We share it only with the processors named above (Google
        Firebase, Stripe, Resend, our AI and hosting providers) as needed to run the service, or
        when the law requires it.
      </p>
      <h2>6. Retention & deletion</h2>
      <p>
        Deleting your account in Settings removes your sign-in immediately and frees your email.
        Residual project/usage records are cleaned up on a rolling basis. You can also email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> to request deletion of specific
        data.
      </p>
      <h2>7. Cookies & local storage</h2>
      <p>
        We use browser storage for sign-in state, your open workspace, and preferences (like theme
        and open tool tabs). No third-party advertising trackers.
      </p>
      <h2>8. Contact</h2>
      <p>
        Privacy questions or requests: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </>
  );
}

function Aup() {
  return (
    <>
      <h1>Acceptable Use Policy</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p>
        {PLATFORM_NAME} gives you real cloud compute and public URLs. Don't use them to harm
        others. In particular, don't:
      </p>
      <ul>
        <li>run malware, phishing pages, scrapers that ignore robots/ToS, or DDoS/botnet tooling;</li>
        <li>mine cryptocurrency or run compute-abuse workloads unrelated to development;</li>
        <li>host or distribute illegal content, or content that sexually exploits minors;</li>
        <li>attack, probe, or overload other people's systems — or {PLATFORM_NAME} itself;</li>
        <li>circumvent plan limits, metering, or suspension (including with multiple accounts);</li>
        <li>publish spam, deceptive, or impersonating apps on share links;</li>
        <li>resell or proxy platform access without permission.</li>
      </ul>
      <p>
        We may suspend accounts that violate this policy — permanently for serious abuse. Every
        suspension can be appealed in-app or via{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>; a human reviews each case.
      </p>
      <p>
        Found a security issue? Please report it responsibly to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — we appreciate it and won't take
        action against good-faith research.
      </p>
    </>
  );
}
