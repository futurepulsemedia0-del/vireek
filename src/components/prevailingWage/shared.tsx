import { useId, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Scale } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LEGAL_REVIEW_NOTICE, type LegalReviewStatus } from '@/lib/prevailingWage';

export const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  helperText?: string;
  children: ReactNode;
}

export function Select({ label, helperText, children, className = '', ...props }: SelectProps) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} className={`${selectClass} ${className}`} {...props}>
        {children}
      </select>
      {helperText && <p className="mt-1.5 text-xs text-text-secondary">{helperText}</p>}
    </div>
  );
}

export function LegalBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4">
      <Scale size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
      <div className="text-sm text-text-primary">
        <p className="font-semibold">Legal review required</p>
        {!compact && <p className="mt-0.5 text-text-secondary">{LEGAL_REVIEW_NOTICE}</p>}
        {compact && <p className="mt-0.5 text-text-secondary">Verify every rate and rule with a qualified attorney or compliance professional before certifying payroll.</p>}
      </div>
    </div>
  );
}

const REVIEW_STYLE: Record<LegalReviewStatus, { label: string; cls: string; icon: ReactNode }> = {
  unreviewed: { label: 'Not reviewed', cls: 'bg-danger/10 text-danger', icon: <AlertTriangle size={12} aria-hidden="true" /> },
  in_review: { label: 'In review', cls: 'bg-warning-500/10 text-warning-500', icon: <Clock size={12} aria-hidden="true" /> },
  approved: { label: 'Legally reviewed', cls: 'bg-success-500/10 text-success-500', icon: <CheckCircle2 size={12} aria-hidden="true" /> },
};

export function ReviewBadge({ status }: { status: LegalReviewStatus }) {
  const s = REVIEW_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const cls = {
    neutral: 'bg-bg-tertiary text-text-secondary',
    good: 'bg-success-500/10 text-success-500',
    warn: 'bg-warning-500/10 text-warning-500',
    bad: 'bg-danger/10 text-danger',
    accent: 'bg-accent/10 text-accent',
  }[tone];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

interface ReviewControlProps {
  status: LegalReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  canEdit: boolean;
  busy: boolean;
  onSet: (status: LegalReviewStatus, reviewer: string) => void | Promise<void>;
}

/** Legal-review workflow: unreviewed → in review → approved (with the reviewer's name). */
export function ReviewControl({ status, reviewedBy, reviewedAt, canEdit, busy, onSet }: ReviewControlProps) {
  const [reviewer, setReviewer] = useState('');
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewBadge status={status} />
        {status === 'approved' && (
          <span className="text-xs text-text-secondary">
            by {reviewedBy ?? 'reviewer'}
            {reviewedAt ? ` on ${new Date(reviewedAt).toLocaleDateString('en-US')}` : ''}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-text-secondary">
        Any change to a reviewed item resets it to “Not reviewed”. Certifying a payroll requires “Legally reviewed”.
      </p>
      {canEdit && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          {status !== 'approved' && (
            <>
              <div className="sm:max-w-xs sm:flex-1">
                <Input label="Reviewed by (attorney / compliance)" value={reviewer} onChange={(e) => setReviewer(e.target.value)} maxLength={160} />
              </div>
              <Button size="sm" onClick={() => onSet('approved', reviewer)} disabled={busy || reviewer.trim().length < 2}>
                Mark legally reviewed
              </Button>
              {status === 'unreviewed' && (
                <Button size="sm" variant="secondary" onClick={() => onSet('in_review', '')} disabled={busy}>
                  Mark in review
                </Button>
              )}
            </>
          )}
          {status !== 'unreviewed' && (
            <Button size="sm" variant="ghost" onClick={() => onSet('unreviewed', '')} disabled={busy}>
              Withdraw review
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-text-primary">{children}</h2>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function errMsg(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
