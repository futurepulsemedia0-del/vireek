import { useId, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import type { Assignee } from '@/lib/tasksApi';
import type { CadenceRole } from '@/lib/cadence';

/** Everything a tab needs from the page shell. */
export interface TabProps {
  role: CadenceRole;
  canManage: boolean;
  canViewFinancials: boolean;
  tz: string;
  today: string;
  weekStart: string;
  meId: string;
  assignees: Assignee[];
}

export const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';
export const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';
export const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';
export const iconBtn =
  'focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';

export function CadenceModal({
  open,
  title,
  onClose,
  busy = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useFocusTrap(open);
  useEscapeToClose(open && !busy, onClose);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => !busy && onClose()}
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[101] flex max-h-[92vh] flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[92vw] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 id={titleId} className="text-lg font-semibold text-text-primary">
                {title}
              </h2>
              <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-5">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-danger/30 bg-danger-500/5 px-6 py-12 text-center">
      <AlertTriangle className="text-danger" size={26} />
      <p className="mt-3 text-sm font-semibold text-text-primary">Couldn’t load this section</p>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">{message}</p>
      <Button size="sm" variant="secondary" className="mt-4" onClick={onRetry}>
        <RefreshCw size={14} /> Try again
      </Button>
    </div>
  );
}

export const errMsg = (e: unknown, fallback = 'Something went wrong. Please try again.') => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : fallback;
};

/** Tiny dependency-free trend line; gaps (null) break the line. */
export function Sparkline({ values, tone, label }: { values: (number | null)[]; tone: 'success' | 'danger' | 'neutral'; label: string }) {
  const nums = values.filter((v): v is number => v !== null);
  const w = 96;
  const h = 28;
  if (nums.length < 2) {
    return (
      <span className="text-xs text-text-secondary" role="img" aria-label={`${label}: not enough history`}>
        No trend yet
      </span>
    );
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * (w - 4) + 2);
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
  const color = tone === 'success' ? 'text-success-500' : tone === 'danger' ? 'text-danger' : 'text-text-secondary';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label} trend, last ${nums.length} weeks`} className={color}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(lastIdx)} cy={y(values[lastIdx] as number)} r="2.5" fill="currentColor" />
    </svg>
  );
}

export const STATUS_PILL = {
  green: 'bg-success-500/10 text-success-500',
  red: 'bg-danger-500/10 text-danger-500',
  none: 'bg-bg-tertiary text-text-secondary',
} as const;
