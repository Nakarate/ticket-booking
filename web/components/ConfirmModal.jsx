import { useEffect } from "react";

// Confirm dialog for money/destructive actions (pay/cancel/logout/close-sale).
// Enter confirms, Escape dismisses. The data-testid hooks back the e2e tests
// (confirm-backdrop / confirm-cancel / confirm-ok) — keep them stable.
export function ConfirmModal({ title, message, confirmLabel, cancelLabel = "ยกเลิก", tone = "primary", onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") { onConfirm(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, onClose]);

  return (
    <div className="modal-backdrop" data-testid="confirm-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">{title}</h3>
        <p className="modal__msg">{message}</p>
        <div className="modal__actions">
          <button className="btn btn--ghost" data-testid="confirm-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${tone === "danger" ? "btn--danger" : "btn--primary"}`}
            data-testid="confirm-ok"
            autoFocus
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
