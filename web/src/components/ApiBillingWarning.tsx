import { API_PRICE_LABEL } from "@ide/shared";

/**
 * The "no limits — but you are billed for every use" acknowledgement modal.
 * Shown before BOTH billed-usage commitments:
 *   1. creating an API key (confirmLabel "Create key"), and
 *   2. flipping the in-IDE agent onto API billing (confirmLabel "Switch billing").
 * The user must explicitly confirm; there is no way around it.
 */
export function ApiBillingWarning({
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal api-warn glass" onClick={(e) => e.stopPropagation()}>
        <div className="paywall-icon">⚡</div>
        <h2>No limits — pay per use</h2>
        <p className="paywall-msg">
          There is no Sparks cap on API-key billing. <strong>You are billed for every use</strong>,
          charged to your card:
        </p>
        <p className="api-warn-price">{API_PRICE_LABEL}</p>
        <p className="paywall-msg muted">
          A runaway prompt costs real money — you can revoke keys and cancel runs at any time.
        </p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-neon" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
