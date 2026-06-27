import { DAEMON_HTTP } from "./daemonClient";

/**
 * GitHub OAuth (browser side). The token is held in the browser (localStorage)
 * and re-sent to the daemon on every connect, so it survives the daemon's
 * diskless redeploys. The OAuth code→token exchange (which needs the client
 * secret) happens on the daemon; this just runs the popup + stores the result.
 */

const TOKEN_KEY = "neondeck:gh-token";
const STATE_KEY = "neondeck:gh-state";

export function getStoredGithubToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearGithubToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

/** The daemon's GitHub OAuth client id (null when GitHub sync isn't configured). */
async function githubClientId(): Promise<string | null> {
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/health`);
    const data = (await res.json()) as { githubClientId?: string | null };
    return data.githubClientId ?? null;
  } catch {
    return null;
  }
}

/** True when the daemon has GitHub OAuth configured (so we can show "Connect"). */
export async function githubAvailable(): Promise<boolean> {
  return Boolean(await githubClientId());
}

/**
 * Run the OAuth popup flow. Resolves with the access token (also stored) or null
 * if the user cancelled / it failed / GitHub isn't configured.
 */
export async function connectGitHub(): Promise<string | null> {
  const clientId = await githubClientId();
  if (!clientId) return null;

  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    /* ignore */
  }
  const redirectUri = `${DAEMON_HTTP}/api/github/callback`;
  const authUrl =
    `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo&state=${encodeURIComponent(state)}`;
  const daemonOrigin = new URL(DAEMON_HTTP).origin;
  const popup = window.open(authUrl, "github-oauth", "width=600,height=720");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      try {
        sessionStorage.removeItem(STATE_KEY);
      } catch {
        /* ignore */
      }
      resolve(token);
    };
    function onMessage(e: MessageEvent) {
      if (e.origin !== daemonOrigin) return; // only trust the daemon's callback page
      const d = e.data as { type?: string; token?: string; state?: string } | null;
      if (!d || d.type !== "github-oauth") return;
      let expected = "";
      try {
        expected = sessionStorage.getItem(STATE_KEY) ?? "";
      } catch {
        /* ignore */
      }
      if (d.state !== expected) return; // CSRF guard
      if (d.token) storeToken(d.token);
      finish(d.token || null);
    }
    window.addEventListener("message", onMessage);
    // If the popup is closed without a message, resolve null.
    const poll = setInterval(() => {
      if (popup && popup.closed) finish(getStoredGithubToken());
    }, 500);
  });
}
