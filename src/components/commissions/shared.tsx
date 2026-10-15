import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import type { StatementStatus } from '@/lib/commissionEngine';
import type { RecordStatus } from '@/lib/commissions';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

export const STATEMENT_TONE: Record<StatementStatus, Tone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  paid: 'success',
  void: 'danger',
};

export const STATEMENT_LABEL: Record<StatementStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  paid: 'Paid',
  void: 'Void',
};

export const RECORD_TONE: Record<RecordStatus, Tone> = { pending: 'warning', approved: 'info', paid: 'success' };

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-3 border-danger/30 p-5 hover:translate-y-0 sm:flex-row sm:items-center sm:justify-between" role="alert">
      <p className="text-sm text-danger">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
    </Card>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
  helperText,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
  helperText?: string;
}) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {children}
      </select>
      {helperText && <p className="mt-1.5 text-xs text-text-secondary">{helperText}</p>}
    </div>
  );
}

/** Accessible modal: focus trap, Esc to close, backdrop click, scroll-safe on phones. */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  danger,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  danger?: boolean;
}) {
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  const titleId = useId();
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" />
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed inset-x-3 bottom-3 top-auto z-[120] mx-auto flex max-h-[90vh] w-auto max-w-lg flex-col rounded-2xl border border-border bg-bg-secondary shadow-card-hover sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 dark:shadow-card-hover-dark"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div className="flex items-start gap-3">
                {danger && (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><TriangleAlert size={18} /></span>
                )}
                <div>
                  <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
                  {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
                </div>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><X size={18} /></button>
            </div>
            <div className="space-y-4 overflow-y-auto p-5">{children}</div>
            <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end">{footer}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Local-time YYYY-MM-DD (never shifts a day the way toISOString() can). */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  return { start: toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '-';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatPct(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * Runs `fn` on mount and whenever `deps` change, with cancel-on-unmount.
 * Changing `deps` shows the loading state; `reload()` refreshes quietly
 * (keeps the current data on screen) so lists never flash or lose scroll.
 */
export function useLoader<T>(fn: () => Promise<T>, deps: (string | number | boolean | null | undefined)[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const depsKey = JSON.stringify(deps);
  const lastKey = useRef(depsKey);
  const hasData = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (lastKey.current !== depsKey) {
      lastKey.current = depsKey;
      hasData.current = false;
      setData(null);
    }
    if (!hasData.current) setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (cancelled) return;
        hasData.current = true;
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
        setError(msg || 'Could not load data.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, tick]);

  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}
