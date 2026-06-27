import fs from "node:fs";
import path from "node:path";
import { run as git } from "./git.js";
import type { DaemonConfig } from "./config.js";

/**
 * Per-user project sync to the user's OWN GitHub.
 *
 * When a user connects GitHub (OAuth), their browser holds the access token and
 * re-sends it on every connect (survives Render's diskless redeploys). With a
 * token we keep one private repo per user — `neondeck-projects`, each project a
 * subfolder — and push on change / pull on open. The local clone under
 * `<metaDir>/gh-cache/<userKey>` is a throwaway cache, re-created on demand.
 *
 * Everything is guarded and non-fatal: a GitHub hiccup must never break the IDE.
 */

const REPO = "neondeck-projects";
/** Never sync these into the user's repo (mirrors the workspace ignore set). */
const IGNORED = new Set(["node_modules", ".git", "dist", ".next", ".neondeck", ".DS_Store"]);

/** GitHub OAuth is configured on this daemon (users can connect at all). */
export function githubConfigured(config: DaemonConfig): boolean {
  return Boolean(config.githubClientId && config.githubClientSecret);
}

const loginCache = new Map<string, string>(); // token -> github login
const repoReady = new Set<string>(); // token -> repo confirmed/created

async function gh(token: string, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "NeonDeck",
      ...(init?.headers ?? {}),
    },
  });
}

async function resolveLogin(token: string): Promise<string> {
  const cached = loginCache.get(token);
  if (cached) return cached;
  const res = await gh(token, "https://api.github.com/user");
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
  const login = ((await res.json()) as { login?: string }).login;
  if (!login) throw new Error("GitHub account has no login");
  loginCache.set(token, login);
  return login;
}

async function ensureRepo(token: string, login: string): Promise<void> {
  if (repoReady.has(token)) return;
  const check = await gh(token, `https://api.github.com/repos/${login}/${REPO}`);
  if (check.status === 404) {
    const create = await gh(token, "https://api.github.com/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: REPO,
        private: true,
        auto_init: true,
        description: "NeonDeck projects (synced automatically).",
      }),
    });
    if (!create.ok) throw new Error(`Could not create ${REPO} (${create.status})`);
  } else if (!check.ok) {
    throw new Error(`GitHub repo check failed (${check.status})`);
  }
  repoReady.add(token);
}

function cacheDir(config: DaemonConfig, userKey: string): string {
  return path.join(config.metaDir, "gh-cache", userKey);
}
function tokenUrl(token: string, login: string): string {
  return `https://x-access-token:${token}@github.com/${login}/${REPO}.git`;
}

/** Ensure a local clone exists and is up to date; returns its dir + the login. */
async function ensureClone(
  config: DaemonConfig,
  token: string,
  userKey: string,
): Promise<{ dir: string; login: string }> {
  const login = await resolveLogin(token);
  await ensureRepo(token, login);
  const dir = cacheDir(config, userKey);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const clone = await git(path.dirname(dir), ["clone", tokenUrl(token, login), path.basename(dir)]);
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.out.slice(0, 200)}`);
    // Strip the token from the persisted remote (the cache is ephemeral, but be tidy).
    await git(dir, ["remote", "set-url", "origin", `https://github.com/${login}/${REPO}.git`]);
    await git(dir, ["config", "user.email", "neondeck@users.noreply.github.com"]);
    await git(dir, ["config", "user.name", "NeonDeck"]);
  } else {
    await git(dir, ["pull", "--no-rebase", tokenUrl(token, login), "main"]);
  }
  return { dir, login };
}

/** Filter for fs.cpSync — skip ignored segments relative to the project root. */
function copyFilter(srcRoot: string) {
  return (src: string): boolean => {
    const rel = path.relative(srcRoot, src);
    return rel === "" || !rel.split(path.sep).some((seg) => IGNORED.has(seg));
  };
}

/** Commit + push a project to the user's GitHub. No-op without a token / dir. */
export async function pushProject(
  config: DaemonConfig,
  token: string,
  userKey: string,
  project: string,
  srcDir: string,
): Promise<void> {
  if (!token) return;
  try {
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
    const { dir, login } = await ensureClone(config, token, userKey);
    const dest = path.join(dir, project);
    fs.rmSync(dest, { recursive: true, force: true }); // mirror deletions
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true, filter: copyFilter(srcDir) });
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", `Sync ${project}`]); // "nothing to commit" is fine
    const push = await git(dir, ["push", tokenUrl(token, login), "HEAD:main"]);
    if (push.code !== 0) console.warn(`[github] push of "${project}" failed: ${push.out.slice(0, 160)}`);
  } catch (err) {
    console.warn(`[github] push of "${project}" failed:`, (err as Error).message);
  }
}

/** Restore a project from the user's GitHub into destDir. Returns whether it did. */
export async function pullProject(
  config: DaemonConfig,
  token: string,
  userKey: string,
  project: string,
  destDir: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { dir } = await ensureClone(config, token, userKey);
    const src = path.join(dir, project);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return false;
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(src, destDir, { recursive: true, filter: (s) => !s.split(path.sep).includes(".git") });
    console.log(`[github] restored "${project}" from GitHub`);
    return true;
  } catch (err) {
    console.warn(`[github] pull of "${project}" failed:`, (err as Error).message);
    return false;
  }
}

/** Project names this user has in their GitHub repo. Used to repopulate the Hub. */
export async function listRemoteProjects(
  config: DaemonConfig,
  token: string,
  userKey: string,
): Promise<string[]> {
  if (!token) return [];
  try {
    const { dir } = await ensureClone(config, token, userKey);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED.has(e.name))
      .map((e) => e.name);
  } catch (err) {
    console.warn("[github] list failed:", (err as Error).message);
    return [];
  }
}
