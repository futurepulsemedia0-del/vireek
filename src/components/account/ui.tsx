import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';

export const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-placeholder disabled:opacity-60';
export const primaryBtn =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryBtn =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50';

export function AccountCard({
  id,
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-24 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <Icon size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-base font-semibold text-text-primary">
              {title}
            </h2>
            {description && <p className="text-xs text-text-secondary">{description}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className="mt-5">{children}</div>
    </section>
  );
}

const TONES = {
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  accent: 'bg-accent/10 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
} as const;

export function StatusPill({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function LinkRow({
  to,
  icon: Icon,
  title,
  description,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="focus-ring group flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-bg-primary px-4 py-3 transition-colors hover:border-accent/30 hover:bg-bg-tertiary"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary group-hover:text-accent">
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-text-primary">{title}</span>
          <span className="block text-xs text-text-secondary">{description}</span>
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-text-secondary rtl:rotate-180" aria-hidden="true" />
    </Link>
  );
}
