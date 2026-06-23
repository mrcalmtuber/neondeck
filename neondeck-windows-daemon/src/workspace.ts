import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { FileNode } from "./shared/protocol.js";

/** Directory names we never surface in the tree. */
const IGNORED = new Set(["node_modules", ".git", ".DS_Store", "dist", ".next"]);

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
