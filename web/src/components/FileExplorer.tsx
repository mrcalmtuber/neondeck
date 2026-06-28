import { useState, useEffect } from "react";
import type { FileNode, SearchMatch } from "@ide/shared";
import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { daemon } from "../lib/daemonClient";
import { PromptDialog } from "./PromptDialog";

type Dialog =
  | { kind: "new-file" }
  | { kind: "new-folder" }
  | { kind: "delete"; path: string }
  | null;

/** File tree synced with the workspace + New / Delete actions + project search. */
export function FileExplorer() {
  const tree = useStore((s) => s.tree);
  const setTree = useStore((s) => s.setTree);
  const selectedPath = useStore((s) => s.selectedPath);
  const [dialog, setDialog] = useState<Dialog>(null);

  // ---- project-wide search ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ matches: SearchMatch[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);

  // Debounced search: fire ~250ms after the user stops typing.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      daemon
        .searchFiles(q)
        .then(setResults)
        .catch(() => setResults({ matches: [], truncated: false }))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  /** Open a search hit in the editor and scroll to its line. */
  async function openHit(hit: SearchMatch) {
    const s = useStore.getState();
    s.setSelected(hit.path);
    const content = await ws.read(hit.path);
    s.setOpenFile(hit.path, content);
    s.setGotoLine(hit.line);
  }

  async function refresh() {
    setTree(await ws.listTree());
  }

  /** Where new entries land: inside the selected dir, or next to a selected file. */
  function targetDir(): string {
    if (!selectedPath || selectedPath === ".") return "";
    const node = findNode(tree, selectedPath);
    if (node?.type === "dir") return selectedPath;
    const slash = selectedPath.lastIndexOf("/");
    return slash === -1 ? "" : selectedPath.slice(0, slash);
  }

  async function createEntry(name: string, kind: "file" | "dir") {
    const dir = targetDir();
    const path = dir ? `${dir}/${name}` : name;
    await ws.create(path, kind);
    await refresh();
    setDialog(null);
  }

  async function deleteEntry(path: string) {
    await ws.remove(path);
    if (useStore.getState().openFile === path) useStore.getState().setOpenFile("", "");
    await refresh();
    setDialog(null);
  }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span>EXPLORER</span>
        <div className="explorer-actions">
          <button
            className={`icon-btn ${searchOpen ? "active" : ""}`}
            title="Search in files"
            onClick={() => {
              setSearchOpen((o) => {
                if (o) setQuery(""); // closing → clear the query (back to tree)
                return !o;
              });
            }}
          >
            🔍
          </button>
          <button className="icon-btn" title="New File" onClick={() => setDialog({ kind: "new-file" })}>
            📄+
          </button>
          <button className="icon-btn" title="New Folder" onClick={() => setDialog({ kind: "new-folder" })}>
            📁+
          </button>
          <button
            className="icon-btn"
            title="Delete Selected"
            disabled={!selectedPath || selectedPath === "."}
            onClick={() => selectedPath && setDialog({ kind: "delete", path: selectedPath })}
          >
            🗑️
          </button>
          <button className="icon-btn" title="Refresh" onClick={refresh}>
            ⟳
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="search-box">
          <input
            type="text"
            autoFocus
            placeholder="Search text in files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
          {query && (
            <button className="icon-btn" title="Clear" onClick={() => setQuery("")}>
              ✕
            </button>
          )}
        </div>
      )}

      {searchOpen && query.trim() ? (
        <SearchResults results={results} searching={searching} onOpen={openHit} />
      ) : (
        <div className="tree">
          {tree ? <TreeNode node={tree} depth={0} /> : <div className="muted">No workspace</div>}
        </div>
      )}

      {dialog?.kind === "new-file" && (
        <PromptDialog
          title="New File"
          label={`Path${targetDir() ? ` (in ${targetDir()}/)` : ""}`}
          placeholder="e.g. index.js"
          onSubmit={(name) => createEntry(name, "file")}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "new-folder" && (
        <PromptDialog
          title="New Folder"
          label={`Name${targetDir() ? ` (in ${targetDir()}/)` : ""}`}
          placeholder="e.g. components"
          onSubmit={(name) => createEntry(name, "dir")}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <PromptDialog
          title={`Delete "${dialog.path}"?`}
          inputless
          danger
          confirmText="Delete"
          onSubmit={() => deleteEntry(dialog.path)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** Project-search results grouped by file; click a hit to open + jump to line. */
function SearchResults({
  results,
  searching,
  onOpen,
}: {
  results: { matches: SearchMatch[]; truncated: boolean } | null;
  searching: boolean;
  onOpen: (hit: SearchMatch) => void;
}) {
  if (searching && !results) {
    return <div className="search-results muted">Searching…</div>;
  }
  if (!results || results.matches.length === 0) {
    return <div className="search-results muted">No matches</div>;
  }

  // Group consecutive matches by file (results arrive sorted by path).
  const groups: { path: string; hits: SearchMatch[] }[] = [];
  for (const m of results.matches) {
    const last = groups[groups.length - 1];
    if (last && last.path === m.path) last.hits.push(m);
    else groups.push({ path: m.path, hits: [m] });
  }

  return (
    <div className="search-results">
      <div className="search-count muted">
        {results.matches.length} match{results.matches.length === 1 ? "" : "es"} in {groups.length} file
        {groups.length === 1 ? "" : "s"}
        {results.truncated ? " (showing first 200)" : ""}
      </div>
      {groups.map((g) => (
        <div key={g.path} className="search-group">
          <div className="search-file" title={g.path}>
            {g.path}
          </div>
          {g.hits.map((hit, i) => (
            <button
              key={i}
              className="search-hit"
              onClick={() => onOpen(hit)}
              title={`${g.path}:${hit.line}`}
            >
              <span className="search-line">{hit.line}</span>
              <span className="search-preview">{hit.preview}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const openFile = useStore((s) => s.openFile);
  const selectedPath = useStore((s) => s.selectedPath);
  const setSelected = useStore((s) => s.setSelected);
  const setOpenFile = useStore((s) => s.setOpenFile);

  // Single click selects (and toggles folders). Files only OPEN in the editor
  // on double-click — keeping single-click as a lightweight "select".
  function handleClick() {
    setSelected(node.path);
    if (node.type === "dir") setOpen((o) => !o);
  }

  async function handleDoubleClick() {
    if (node.type !== "file") return;
    setSelected(node.path);
    const content = await ws.read(node.path);
    setOpenFile(node.path, content);
  }

  const isActive = openFile === node.path || selectedPath === node.path;

  return (
    <div>
      <div
        className={`tree-row ${isActive ? "active" : ""}`}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        title={node.type === "file" ? "Double-click to open in the editor" : undefined}
      >
        <span className="tree-icon">
          {node.type === "dir" ? (open ? "▾" : "▸") : "·"}
        </span>
        <span className="tree-name">{depth === 0 ? node.name || "workspace" : node.name}</span>
      </div>
      {node.type === "dir" &&
        open &&
        node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

function findNode(node: FileNode | null, path: string): FileNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
