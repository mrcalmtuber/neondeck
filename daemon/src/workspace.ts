import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { FileNode, SearchMatch } from "@ide/shared";

/** Directory names we never surface in the tree. */
const IGNORED = new Set(["node_modules", ".git", ".DS_Store", "dist", ".next", ".neondeck"]);

/**
 * Resolves a workspace-relative path to an absolute path and guarantees it
 * stays inside `workspaceDir`. Throws on any traversal attempt (`..`,
 * absolute paths, symlink escapes). Every file op goes through this.
 */
export function safeResolve(workspaceDir: string, relPath: string): string {
  const normalized = path
    .normalize(relPath)
    .replace(/^([/\\])+/, ""); // strip leading slashes -> force relative
  const abs = path.resolve(workspaceDir, normalized);
  const root = path.resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return abs;
}

export async function buildTree(workspaceDir: string): Promise<FileNode> {
  const root = path.resolve(workspaceDir);
  return walk(root, root);
}

async function walk(absPath: string, root: string): Promise<FileNode> {
  const rel = path.relative(root, absPath) || ".";
  const name = rel === "." ? path.basename(root) : path.basename(absPath);
  const stat = await fs.stat(absPath);

  if (!stat.isDirectory()) {
    return { name, path: toPosix(rel), type: "file" };
  }

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const children: FileNode[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    children.push(await walk(path.join(absPath, entry.name), root));
  }
  children.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { name, path: toPosix(rel), type: "dir", children };
}

export async function readFile(workspaceDir: string, relPath: string): Promise<string> {
  const abs = safeResolve(workspaceDir, relPath);
  return fs.readFile(abs, "utf8");
}

// ---------------------------------------------------------------------------
// Project-wide text search (grep). Reuses the IGNORED set so node_modules/.git
// etc. are skipped; skips large/binary files; caps results to bound the payload.
// ---------------------------------------------------------------------------

const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 1_000_000; // 1 MB — skip anything bigger
const SEARCH_PREVIEW_MAX = 200;

/** Collect every (non-ignored) file path under the workspace, relative + posix. */
async function listAllFiles(absDir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await listAllFiles(abs, root, out);
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(root, abs)));
    }
  }
}

export async function searchFiles(
  workspaceDir: string,
  query: string,
  opts: { caseSensitive?: boolean } = {},
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const root = path.resolve(workspaceDir);
  const term = opts.caseSensitive ? query : query.toLowerCase();
  if (!term) return { matches: [], truncated: false };

  const files: string[] = [];
  await listAllFiles(root, root, files);
  files.sort();

  const matches: SearchMatch[] = [];
  let truncated = false;

  for (const rel of files) {
    if (matches.length >= SEARCH_MAX_MATCHES) {
      truncated = true;
      break;
    }
    const abs = safeResolve(workspaceDir, rel);
    let content: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue; // unreadable / vanished — skip
    }
    if (content.indexOf("\u0000") !== -1) continue; // NUL byte => looks binary, skip

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const hay = opts.caseSensitive ? raw : raw.toLowerCase();
      const col = hay.indexOf(term);
      if (col === -1) continue;
      matches.push({
        path: rel,
        line: i + 1,
        col,
        preview: raw.trim().slice(0, SEARCH_PREVIEW_MAX),
      });
      if (matches.length >= SEARCH_MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
  }

  return { matches, truncated };
}

export async function writeFile(
  workspaceDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = safeResolve(workspaceDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

// ---------------------------------------------------------------------------
// Manual CRUD (sync fs ops, per spec). All paths jailed via safeResolve.
// ---------------------------------------------------------------------------

/** MANUAL_CREATE: create an empty file or a folder. */
export function createEntry(workspaceDir: string, relPath: string, kind: "file" | "dir"): void {
  const abs = safeResolve(workspaceDir, relPath);
  if (kind === "dir") {
    fsSync.mkdirSync(abs, { recursive: true });
  } else {
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fsSync.existsSync(abs)) fsSync.writeFileSync(abs, "", "utf8");
  }
}

/** MANUAL_UPDATE: write file contents (also used by the agent's writes). */
export function writeFileSync(workspaceDir: string, relPath: string, content: string): void {
  const abs = safeResolve(workspaceDir, relPath);
  fsSync.mkdirSync(path.dirname(abs), { recursive: true });
  fsSync.writeFileSync(abs, content, "utf8");
}

/** MANUAL_DELETE: remove a file or folder (recursive). Refuses the root. */
export function deleteEntry(workspaceDir: string, relPath: string): void {
  const abs = safeResolve(workspaceDir, relPath);
  if (abs === path.resolve(workspaceDir)) throw new Error("Refusing to delete the workspace root.");
  fsSync.rmSync(abs, { recursive: true, force: true });
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
