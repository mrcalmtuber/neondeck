import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, EditorState } from "@uiw/react-codemirror";
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
  // Kryct Dark is the only theme — the editor is always dark.
  const cmTheme = "dark";
  const editorPrefs = useStore((s) => s.editorPrefs);
  // User editor preferences (Settings → Editor). Rebuilt only when a pref changes
  // so typing doesn't reconfigure CodeMirror; applies live to the open file.
  const extensions = useMemo(
    () => [
      javascript({ jsx: true, typescript: true }),
      EditorView.theme({ "&": { fontSize: `${editorPrefs.fontSize}px` } }),
      EditorState.tabSize.of(editorPrefs.tabSize),
      ...(editorPrefs.wordWrap ? [EditorView.lineWrapping] : []),
    ],
    [editorPrefs.fontSize, editorPrefs.tabSize, editorPrefs.wordWrap],
  );
  const setFileContent = useStore((s) => s.setFileContent);
  const setOpenFile = useStore((s) => s.setOpenFile);
  const markSaved = useStore((s) => s.markSaved);
  const gotoLine = useStore((s) => s.gotoLine);
  const setGotoLine = useStore((s) => s.setGotoLine);
  const [savedAt, setSavedAt] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef<EditorView | null>(null);

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

  // Scroll to a requested line (e.g. from a search hit), then clear the request.
  useEffect(() => {
    const view = viewRef.current;
    if (!gotoLine || !view) return;
    const lineNo = Math.min(Math.max(gotoLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
    setGotoLine(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoLine, openFile, fileContent]);

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

  // Touch devices select via long-press handles — mouseup never fires there.
  // Watch selectionchange (debounced past the handle-drag churn) and anchor the
  // toolbar BELOW the selection, clear of iOS's selection handles.
  useEffect(() => {
    if (!aiEnabled || !window.matchMedia?.("(pointer: coarse)").matches) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onSel = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const s = window.getSelection();
        const text = s?.toString() ?? "";
        if (!text.trim() || !s || s.rangeCount === 0) {
          setSel(null);
          return;
        }
        const rect = s.getRangeAt(0).getBoundingClientRect();
        setSel({ text, x: rect.left + rect.width / 2, y: rect.bottom + 44 });
      }, 350);
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      if (t) clearTimeout(t);
    };
  }, [aiEnabled]);

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
        extensions={extensions}
        basicSetup={{ lineNumbers: editorPrefs.lineNumbers }}
        onCreateEditor={(view) => (viewRef.current = view)}
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
