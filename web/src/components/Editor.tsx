import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { useStore } from "../lib/store";
import { ws } from "../lib/workspaceService";
import { daemon } from "../lib/daemonClient";
import { DiffModal } from "./DiffModal";

const AUTOSAVE_MS = 2000;

interface Sel {
  text: string;
  x: number;
  y: number;
}

/**
 * Editor with a 2s debounced autosave + explicit Save, plus Feature A inline AI:
 * selecting code reveals a floating [Explain] / [Auto-Fix] toolbar.
 */
export function Editor() {
  const openFile = useStore((s) => s.openFile);
  const fileContent = useStore((s) => s.fileContent);
  const dirty = useStore((s) => s.dirty);
  const transport = useStore((s) => s.transport);
  const agentReady = useStore((s) => s.agentReady);
  const theme = useStore((s) => s.theme);
  // Light editor for the light presets; dark for the neon/dracula presets.
  const cmTheme = theme === "coffee" || theme === "contrast" ? "light" : "dark";
  const setFileContent = useStore((s) => s.setFileContent);
  const setOpenFile = useStore((s) => s.setOpenFile);
  const markSaved = useStore((s) => s.markSaved);
  const [savedAt, setSavedAt] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline AI state
  const [sel, setSel] = useState<Sel | null>(null);
  const [explain, setExplain] = useState<{ text: string; loading: boolean } | null>(null);
  const [diff, setDiff] = useState<{ original: string; fixed: string; loading: boolean } | null>(null);
  const aiEnabled = transport === "daemon" && agentReady;

  async function save() {
    if (!openFile) return;
    await ws.update(openFile, useStore.getState().fileContent);
    markSaved();
    setSavedAt(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    if (!openFile || !dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContent, openFile, dirty]);

  function onMouseUp() {
    if (!aiEnabled) return;
    const s = window.getSelection();
    const text = s?.toString() ?? "";
    if (!text.trim() || !s || s.rangeCount === 0) {
      setSel(null);
      return;
    }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    setSel({ text, x: rect.left + rect.width / 2, y: rect.top - 8 });
  }

  async function runExplain() {
    if (!sel) return;
    const code = sel.text;
    setSel(null);
    setExplain({ text: "", loading: true });
    try {
      await daemon.explainCode(code, (t) =>
        setExplain((e) => ({ text: (e?.text ?? "") + t, loading: true })),
      );
    } catch (err) {
      setExplain({ text: `⚠️ ${err instanceof Error ? err.message : String(err)}`, loading: false });
      return;
    }
    setExplain((e) => (e ? { ...e, loading: false } : null));
  }

  async function runAutoFix() {
    if (!sel || !openFile) return;
    const original = sel.text;
    setSel(null);
    setDiff({ original, fixed: "", loading: true });
    try {
      const res = await daemon.fixCode(openFile, original);
      setDiff({ original: res.original, fixed: res.fixed, loading: false });
    } catch (err) {
      setDiff(null);
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function acceptFix() {
    if (!diff) return;
    // Patch the file by replacing the first occurrence of the selected snippet.
    const next = useStore.getState().fileContent.replace(diff.original, diff.fixed);
    setFileContent(next);
    setDiff(null);
    save();
  }

  if (!openFile) {
    return <div className="editor-empty muted">Select a file to start editing</div>;
  }

  return (
    <div className="editor" onMouseUp={onMouseUp}>
      <div className="editor-tab">
        <span>
          {openFile}
          {dirty ? " ●" : ""}
        </span>
        <span className="editor-status">
          {dirty ? "unsaved…" : savedAt ? `saved ${savedAt}` : ""}
          <button className="btn-ghost sm" onClick={save} title="Save (Ctrl/Cmd-S)">💾 Save</button>
          <button
            className="btn-ghost sm"
            onClick={() => {
              if (dirty) save();
              setOpenFile("", "");
            }}
            title="Close editor — back to the agent"
          >
            ✕ Close
          </button>
        </span>
      </div>

      <CodeMirror
        value={fileContent}
        height="100%"
        theme={cmTheme}
        extensions={[javascript({ jsx: true, typescript: true })]}
        onChange={setFileContent}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            save();
          }
        }}
      />

      {sel && (
        <div className="ai-toolbar" style={{ left: sel.x, top: sel.y }}>
          <button onMouseDown={(e) => e.preventDefault()} onClick={runExplain}>💡 Explain This</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={runAutoFix}>🛠️ Auto-Fix</button>
        </div>
      )}

      {explain && (
        <div className="modal-backdrop" onClick={() => setExplain(null)}>
          <div className="modal explain-popover" onClick={(e) => e.stopPropagation()}>
            <h3>💡 Explain This</h3>
            <div className="explain-body">
              {explain.text || (explain.loading ? "Thinking…" : "")}
              {explain.loading && <span className="spinner" />}
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={() => setExplain(null)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {diff && (
        <DiffModal
          original={diff.original}
          fixed={diff.fixed}
          loading={diff.loading}
          onAccept={acceptFix}
          onClose={() => setDiff(null)}
        />
      )}
    </div>
  );
}
