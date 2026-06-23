import type { FileNode } from "@ide/shared";
import { daemon } from "./daemonClient";

/**
 * Workspace facade. UI components call this instead of talking to the daemon
 * directly, so file CRUD has one entry point. All operations run against the
 * local daemon — the only transport (the former in-browser VFS mode was removed).
 */

export const ws = {
  async listTree(): Promise<FileNode> {
    return daemon.listTree();
  },

  async read(path: string): Promise<string> {
    return daemon.readFile(path);
  },

  async create(path: string, kind: "file" | "dir"): Promise<void> {
    await daemon.manualCreate(path, kind);
  },

  async update(path: string, content: string): Promise<void> {
    await daemon.manualUpdate(path, content);
  },

  async remove(path: string): Promise<void> {
    await daemon.manualDelete(path);
  },

  /**
   * Flatten the whole workspace into [path, contents] pairs — walk the tree and
   * read each file. Used by the "Download .zip" exporter.
   */
  async collectFiles(): Promise<Array<{ path: string; content: string }>> {
    const tree = await daemon.listTree();
    const out: Array<{ path: string; content: string }> = [];
    const walk = async (node: FileNode) => {
      if (node.type === "file") {
        out.push({ path: node.path, content: await daemon.readFile(node.path) });
      } else {
        for (const child of node.children ?? []) await walk(child);
      }
    };
    for (const child of tree.children ?? []) await walk(child);
    return out;
  },

  /** Subscribe to live tree changes (WORKSPACE_CHANGED broadcasts). Returns unsubscribe. */
  onTreeChange(cb: (root: FileNode) => void): () => void {
    return daemon.onMessage((m) => {
      if (m.type === "workspace_changed") cb(m.root);
    });
  },
};
