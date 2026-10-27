import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { statusColor, statusLabel, type DoorStatus } from '@/lib/canvassing';

export const selectCls =
  'focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-primary focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

export const compactSelectCls =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:border-accent';

/** Dot + label: colour is never the only signal. */
export function StatusBadge({ status, className = '' }: { status: DoorStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium text-text-primary ${className}`}>
      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/70 shadow-sm" style={{ backgroundColor: statusColor(status) }} />
      {statusLabel(status)}
    </span>
  );
}

export function TerritoryDot({ color, className = '' }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`} style={{ backgroundColor: color }} />;
}

interface SheetProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Bottom sheet on phones, centred dialog from sm up. Focus-trapped, closes on Escape / backdrop. */
export function Sheet({ open, title, description, onClose, children, footer }: SheetProps) {
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            key="panel"
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[120] flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl dark:shadow-card-hover-dark"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-text-primary">{title}</h2>
                {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1.5 shrink-0 rounded-lg p-2 text-text-secondary hover:text-text-primary">
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex gap-3 border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary px-4 py-3">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

export function ProgressBar({ value, label, color = 'rgb(var(--accent-primary))' }: { value: number; label: string; color?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${v}%`, backgroundColor: color }} />
    </div>
  );
}
