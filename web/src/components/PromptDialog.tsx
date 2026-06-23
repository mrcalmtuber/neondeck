import { useEffect, useRef, useState } from "react";

/**
 * Sleek overlay input dialog — replaces native window.prompt / window.confirm.
 * Used for New File / New Folder names and Delete confirmation.
 */
export function PromptDialog({
  title,
  label,
  placeholder,
  initialValue = "",
  confirmText = "Create",
  danger = false,
  inputless = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  danger?: boolean;
  /** When true, show no text field (confirmation-only dialog). */
  inputless?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    if (inputless || value.trim()) onSubmit(value.trim());
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {!inputless && (
          <label className="field">
            {label && <span>{label}</span>}
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
              spellCheck={false}
            />
          </label>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={danger ? "btn-stop" : "btn-primary"} onClick={submit}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
