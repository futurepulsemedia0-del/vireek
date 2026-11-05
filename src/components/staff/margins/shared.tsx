import type { ReactNode } from 'react';
import type { VoiceBasis } from '@/lib/marginDashboard';

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums sm:text-3xl ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

const BASIS_STYLE: Record<string, string> = {
  provider_reported: 'bg-success/10 text-success',
  mixed: 'bg-warning/10 text-warning',
  estimated: 'bg-bg-tertiary text-text-secondary',
  none: 'bg-bg-tertiary text-text-secondary',
};
const BASIS_LABEL: Record<string, string> = { provider_reported: 'Measured', mixed: 'Mixed', estimated: 'Estimate', none: 'No calls' };

/** Text label always accompanies the colour, so basis is never conveyed by colour alone. */
export function BasisTag({ basis }: { basis: VoiceBasis | 'provider_reported' | 'estimated' }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${BASIS_STYLE[basis]}`}>{BASIS_LABEL[basis]}</span>;
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function TableWrap({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export const TH = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary';
export const THR = 'px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-text-secondary';
export const TD = 'px-3 py-2 text-text-primary';
export const TDR = 'px-3 py-2 text-right tabular-nums text-text-primary';
export const INPUT = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus-visible:border-accent';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
}

export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-danger">
      {errors.map((e) => <li key={e}>{e}</li>)}
    </ul>
  );
}
