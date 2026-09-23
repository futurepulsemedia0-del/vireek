import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TriangleAlert as AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** The exact phrase the user must type back, e.g. "delete this job". Omit for a simple two-button confirm. */
  confirmPhrase?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * A real "type to confirm" (or simple two-button) modal for destructive
 * actions across the dashboard — step 15 asks that deleting a job, removing
 * a team member, or disconnecting an integration never happen from a single
 * accidental click. Used the same way everywhere so it behaves and looks
 * identically no matter which page triggers it.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmPhrase,
  confirmLabel = 'Yes, delete this',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onCancel);

  const canConfirm = confirmPhrase ? typed.trim().toLowerCase() === confirmPhrase.toLowerCase() : true;

  const handleConfirm = async () => {
    if (!canConfirm || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
      setTyped('');
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onCancel}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            ref={dialogRef}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            className="fixed left-1/2 top-1/2 z-[120] w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
                <AlertTriangle size={20} />
              </span>
              <button
                type="button"
                onClick={onCancel}
                aria-label="Cancel"
                className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="confirm-dialog-title" className="mt-4 text-base font-semibold text-text-primary">
              {title}
            </h2>
            <p id="confirm-dialog-description" className="mt-1.5 text-sm leading-relaxed text-text-secondary">
              {description}
            </p>

            {confirmPhrase && (
              <div className="mt-4">
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Type "{confirmPhrase}" to confirm
                </label>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                  placeholder={confirmPhrase}
                />
              </div>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canConfirm || submitting}
                onClick={handleConfirm}
                className="focus-ring flex-1 rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Working…' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
