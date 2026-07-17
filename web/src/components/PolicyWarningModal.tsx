import { useStore } from "../lib/store";

/**
 * Formal content-policy WARNING (first offense). Blocking, acknowledge-only —
 * the prompt was refused but the account is intact. A repeat violation
 * escalates to a suspension, so this is deliberately weighty (not a toast).
 */
export function PolicyWarningModal() {
  const message = useStore((s) => s.policyWarning);
  const setPolicyWarning = useStore((s) => s.setPolicyWarning);
  if (!message) return null;

  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true">
      <div className="modal dialog glass policy-warning" onClick={(e) => e.stopPropagation()}>
        <div className="policy-warning-icon">⚠️</div>
        <h2>Policy warning</h2>
        <p>{message}</p>
        <p className="muted small">
          Please review our <a href="/terms">Terms of Service</a> and{" "}
          <a href="/acceptable-use">Acceptable Use Policy</a>.
        </p>
        <div className="modal-actions">
          <button className="btn-primary" onClick={() => setPolicyWarning(null)}>
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}
