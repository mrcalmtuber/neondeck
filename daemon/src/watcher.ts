import fs from "node:fs";
import { buildTree } from "./workspace.js";
import type { FileNode } from "@ide/shared";

/**
 * Recursive workspace watcher. Any create/modify/delete — whether by the user
 * or an AI tool — triggers a debounced rebuild of the file-tree schema, which
 * the caller broadcasts as WORKSPACE_CHANGED.
 *
 * Uses native fs.watch with { recursive: true }. On Linux (no native recursive
 * support on older kernels) fs.watch may not recurse; the daemon still works,
 * it just won't see nested changes — swap in chokidar there if needed.
 */
export interface Watcher {
  close: () => void;
}

const DEBOUNCE_MS = 120;

export function watchWorkspace(
  workspaceDir: string,
  onChange: (root: FileNode) => void,
): Watcher {
  let timer: NodeJS.Timeout | null = null;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        onChange(await buildTree(workspaceDir));
      } catch (err) {
        console.warn("[watcher] tree rebuild failed:", (err as Error).message);
      }
    }, DEBOUNCE_MS);
  };

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    fsWatcher = fs.watch(workspaceDir, { recursive: true }, (_event, filename) => {
      // Ignore churn from dirs we never surface anyway.
      if (filename && /node_modules|\.git|dist|\.next|\.neondeck/.test(filename.toString())) return;
      fire();
    });
    console.log(`[watcher] watching ${workspaceDir}`);
  } catch (err) {
    console.warn("[watcher] fs.watch unavailable:", (err as Error).message);
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      fsWatcher?.close();
    },
  };
}
