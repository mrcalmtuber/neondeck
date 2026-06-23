/**
 * Git-style side-by-side diff for Feature A Auto-Fix. Line-aligned two-column
 * view; lines that differ are highlighted. Accept patches the file.
 */
export function DiffModal({
  original,
  fixed,
  loading,
  onAccept,
  onClose,
}: {
  original: string;
  fixed: string;
  loading: boolean;
  onAccept: () => void;
  onClose: () => void;
}) {
  const left = original.split("\n");
  const right = fixed.split("\n");
  const rows = Math.max(left.length, right.length);
  const changed = (i: number) => left[i] !== right[i];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <h3>🛠️ Auto-Fix — review changes</h3>
        {loading ? (
          <div className="muted diff-loading">Analyzing your code…</div>
        ) : (
          <div className="diff-grid">
            <div className="diff-col">
              <div className="diff-col-head">Before</div>
              {left.map((line, i) => (
                <pre key={i} className={`diff-line ${changed(i) ? "diff-del" : ""}`}>
                  {line || " "}
                </pre>
              ))}
            </div>
            <div className="diff-col">
              <div className="diff-col-head">After</div>
              {Array.from({ length: rows }).map((_, i) => (
                <pre key={i} className={`diff-line ${changed(i) ? "diff-add" : ""}`}>
                  {right[i] ?? " "}
                </pre>
              ))}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={onAccept} disabled={loading || original === fixed}>
            ✓ Accept Changes
          </button>
        </div>
      </div>
    </div>
  );
}
