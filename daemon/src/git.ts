import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitCommit } from "@ide/shared";
import { sanitizedChildEnv } from "./executor.js";

/**
 * No-terminal visual git. All git runs as native child_process against the
 * project dir (git operates on the host repo, not inside a sandbox).
 */

// Field delimiter — matches git's %x1f (ASCII unit separator) format token.
const UNIT_SEP = String.fromCharCode(0x1f);

export function run(
  cwd: string,
  args: string[],
  onOutput?: (s: string) => void,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // `-c protocol.allow=…` isn't enough on its own; we also validate remote URLs
    // (validateRemoteUrl) before any network op. extraEnv carries auth (e.g.
    // http.extraHeader via GIT_CONFIG_*) so tokens never land in argv/`ps`.
    //
    // SECURITY (H2): scrub the daemon's own secrets from the child env. Git runs
    // unsandboxed on the host and a malicious repo (.git/hooks/*, a gitattributes
    // filter driver, or a poisoned ~/.gitconfig) could otherwise read
    // $STRIPE_SECRET_KEY / $FIREBASE_SERVICE_ACCOUNT / $RESEND_API_KEY / … out of
    // the environment and exfiltrate them. sanitizedChildEnv keeps PATH/HOME so
    // git still finds its binary + user config; extraEnv (the per-push auth) is
    // layered back on top.
    const base = sanitizedChildEnv();
    const child = spawn("git", args, {
      cwd,
      env: extraEnv ? { ...base, ...extraEnv } : base,
    });
    let out = "";
    const collect = (d: Buffer) => {
      const s = d.toString();
      out += s;
      onOutput?.(s);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => resolve({ code: 127, out: `git not available: ${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
  });
}

function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * SECURITY (H4): validate a user-supplied git remote URL before it reaches git.
 * Git's `ext::`/`fd::` transports execute arbitrary shell commands, `file://`
 * reads local paths, and a leading `-` becomes option injection — all of which
 * mean host RCE / file disclosure since git runs unsandboxed on the host. Allow
 * only real https(s) or ssh (scp-style `git@host:path`) remotes.
 */
export function validateRemoteUrl(url: string): void {
  const u = (url ?? "").trim();
  if (!u) throw new Error("No remote URL provided.");
  if (u.startsWith("-")) throw new Error("Invalid remote URL.");
  if (/[\s]/.test(u)) throw new Error("Remote URL must not contain whitespace.");
  if (/^(ext|fd|file|ssh\+ext|git\+ext)::/i.test(u) || /^file:\/\//i.test(u)) {
    throw new Error("That remote URL scheme isn't allowed.");
  }
  const ok =
    /^https?:\/\/[^\s]+$/i.test(u) ||
    /^ssh:\/\/[^\s]+$/i.test(u) ||
    /^git@[\w.-]+:[\w./~-]+$/i.test(u);
  if (!ok) throw new Error("Remote URL must be an https:// or git@… address.");
}

export async function gitLog(dir: string): Promise<{ isRepo: boolean; commits: GitCommit[] }> {
  if (!isRepo(dir)) return { isRepo: false, commits: [] };
  const { code, out } = await run(dir, [
    "log",
    "-n",
    "50",
    "--pretty=format:%h%x1f%an%x1f%ar%x1f%s",
  ]);
  if (code !== 0) return { isRepo: true, commits: [] };
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, relativeDate, subject] = line.split(UNIT_SEP);
      return { hash, author, relativeDate, subject };
    });
  return { isRepo: true, commits };
}

/**
 * Translate the visual "Publish" button into init → add → commit → (push).
 * Push only happens if a remote is configured/provided AND host git auth works;
 * we surface the real git output either way rather than pretending success.
 */
export async function gitPublish(
  dir: string,
  message: string,
  remoteUrl: string | undefined,
  onOutput: (s: string) => void,
): Promise<{ ok: boolean; message: string }> {
  if (!isRepo(dir)) {
    onOutput("$ git init\n");
    await run(dir, ["init"], onOutput);
    await run(dir, ["branch", "-M", "main"], onOutput);
  }

  onOutput("$ git add -A\n");
  await run(dir, ["add", "-A"], onOutput);

  onOutput(`$ git commit -m "${message}"\n`);
  const commit = await run(dir, ["commit", "-m", message || "Update via IDE"], onOutput);
  if (commit.code !== 0) {
    if (/nothing to commit/i.test(commit.out)) {
      // No new changes — fall through so we can still push prior commits.
    } else if (/Author identity unknown|Please tell me who you are/i.test(commit.out)) {
      return {
        ok: false,
        message:
          'Commit failed — set your git identity first: git config --global user.name "You" && git config --global user.email you@example.com',
      };
    } else {
      return { ok: false, message: `Commit failed: ${firstLine(commit.out)}` };
    }
  }

  // Configure remote if one was provided and none exists yet. Validate it first —
  // a malicious `ext::`/`file://`/`-…` URL would otherwise be host RCE (H4).
  const remotes = await run(dir, ["remote"]);
  if (remoteUrl && !remotes.out.includes("origin")) {
    validateRemoteUrl(remoteUrl);
    onOutput(`$ git remote add origin ${remoteUrl}\n`);
    await run(dir, ["remote", "add", "origin", remoteUrl], onOutput);
  }

  const hasOrigin = (await run(dir, ["remote"])).out.includes("origin");
  if (!hasOrigin) {
    return {
      ok: true,
      message: "Committed locally. Add a GitHub remote URL to publish online.",
    };
  }

  onOutput("$ git push -u origin HEAD\n");
  const push = await run(dir, ["push", "-u", "origin", "HEAD"], onOutput);
  if (push.code !== 0) {
    return {
      ok: false,
      message: "Committed locally, but push failed (check GitHub auth / remote access).",
    };
  }
  return { ok: true, message: "Published to GitHub 🚀" };
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "see logs";
}
