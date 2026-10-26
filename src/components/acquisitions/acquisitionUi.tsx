import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';

/** Shared look-and-feel for the Acquisitions module (design tokens only). */
export const panelCls = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
export const fieldCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
export const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';
const TONES: Record<Tone, string> = {
  good: 'bg-success/15 text-success',
  bad: 'bg-danger/10 text-danger',
  warn: 'bg-warning-500/15 text-warning-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function ProgressBar({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
      {error && <span role="alert" className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className={panelCls}>
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-bold text-text-primary sm:text-2xl">{value}</p>
      {sub && <p className={`mt-0.5 text-xs ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : 'text-text-secondary'}`}>{sub}</p>}
    </div>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="focus-ring rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-semibold hover:bg-danger/10">Retry</button>
      )}
    </div>
  );
}

/** Same account-scoping rule as ImportsPage / useDocumentsScope: owners are their own account, members point at their owner. */
export function useAcquisitionsScope() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || Boolean(permissions?.can_edit_business_profile);
  return { accountOwnerId, canManage };
}
