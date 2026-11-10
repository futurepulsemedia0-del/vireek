import { motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { useTrustT } from '@/hooks/useTrustT';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export type EmptyStateVariant = 'no-data' | 'no-results' | 'no-permission' | 'load-failed';

interface EmptyStateProps {
  /** Optional. Omit together with `compact` for an inline one-line empty message. */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Primary CTA, contextual to the page (e.g. "Schedule a job"). */
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
  /** Single-line, borderless variant for table cells and small panels (no illustration). */
  compact?: boolean;
  /** Default 'no-data'. 'no-results' = filters matched nothing; 'no-permission'; 'load-failed'. */
  variant?: EmptyStateVariant;
  /** variant 'no-results': becomes the primary "Clear filters" button when no `action` is given. */
  onClearFilters?: () => void;
  /** variant 'load-failed': becomes the primary "Try again" button when no `action` is given. */
  onRetry?: () => void;
  /** Secondary "Learn more" link (opens the help article in a new tab). */
  learnMore?: { label?: string; href: string };
}

const TONE: Record<EmptyStateVariant, { box: string; chip: string }> = {
  'no-data': { box: 'border-border bg-bg-secondary/50', chip: 'bg-accent/10 text-accent' },
  'no-results': { box: 'border-border bg-bg-secondary/50', chip: 'bg-accent/10 text-accent' },
  'no-permission': { box: 'border-warning-500/30 bg-warning-500/5', chip: 'bg-warning-500/10 text-warning-500' },
  'load-failed': { box: 'border-danger/30 bg-danger/5', chip: 'bg-danger/10 text-danger' },
};

// ============================================================
// General-purpose empty state — for "no data yet" panels
// (e.g. no calls, no jobs, no leads, no FAQs, no team members).
//
// Usage:
//   <EmptyState
//     icon={PhoneOff}
//     title="No calls yet"
//     description="Once your assistant takes a call, it'll show up here."
//   />
//
// With an action:
//   <EmptyState
//     icon={Briefcase}
//     title="No jobs scheduled"
//     description="Book your first job to see it here."
//     action={{ label: 'Schedule a job', onClick: () => navigate('/jobs/new') }}
//   />
//
// Filters matched nothing:
//   <EmptyState icon={Briefcase} title="No jobs" variant="no-results" onClearFilters={clear} />
// ============================================================

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className = '',
  compact = false,
  variant = 'no-data',
  onClearFilters,
  onRetry,
  learnMore,
}: EmptyStateProps) {
  const { t } = useTrustT();
  const reduce = useReducedMotion();
  const tone = TONE[variant];

  const primary =
    action ??
    (variant === 'no-results' && onClearFilters ? { label: t('empty.noResults.clear'), onClick: onClearFilters } : undefined) ??
    (variant === 'load-failed' && onRetry ? { label: t('empty.loadFailed.retry'), onClick: onRetry } : undefined);

  const text =
    description ??
    (variant === 'no-results'
      ? t('empty.noResults.description')
      : variant === 'no-permission'
        ? t('empty.noPermission.description')
        : variant === 'load-failed'
          ? t('empty.loadFailed.description')
          : undefined);

  if (compact) {
    return (
      <p role={variant === 'load-failed' ? 'alert' : undefined} className={`py-4 text-center text-sm text-text-secondary ${className}`}>
        {title}
        {text ? ` ${text}` : ''}
        {primary && (
          <button type="button" onClick={primary.onClick} className="focus-ring ms-2 rounded-md font-medium text-accent hover:underline">
            {primary.label}
          </button>
        )}
      </p>
    );
  }

  return (
    <motion.div
      role={variant === 'load-failed' ? 'alert' : undefined}
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center ${tone.box} ${className}`}
    >
      <span className="relative flex h-20 w-20 items-center justify-center" aria-hidden="true">
        <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full text-border" fill="none">
          <circle cx="40" cy="40" r="38" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 5" />
          <circle cx="12" cy="20" r="3" fill="currentColor" />
          <circle cx="70" cy="58" r="2.5" fill="currentColor" />
        </svg>
        <span className={`flex h-14 w-14 items-center justify-center rounded-2xl ${tone.chip}`}>
          {Icon ? <Icon size={26} /> : null}
        </span>
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      {text && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{text}</p>}
      {(primary || secondaryAction || learnMore) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {primary && (
            <button
              type="button"
              onClick={primary.onClick}
              className="focus-ring rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              {primary.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              {secondaryAction.label}
            </button>
          )}
          {learnMore && (
            <a
              href={learnMore.href}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring rounded-xl px-3 py-2.5 text-sm font-medium text-accent hover:underline"
            >
              {learnMore.label ?? t('empty.noData.learnMore')}
            </a>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// Compact inline variant — for small sections inside a SectionCard
// where a full illustrated empty state would be too heavy
// (e.g. "No services added yet" under a form field).
//
// Usage:
//   <EmptyStateInline text="No holidays added yet." />
// ============================================================

export function EmptyStateInline({ text, className = '' }: { text: string; className?: string }) {
  return <p className={`text-xs text-text-secondary/60 ${className}`}>{text}</p>;
}

// ============================================================
// Error / failed-to-load variant — same shape as EmptyState but
// with distinct copy defaults, for when a fetch fails rather than
// legitimately returning zero rows.
//
// Usage:
//   <EmptyStateError onRetry={() => loadProfile()} />
// ============================================================

interface EmptyStateErrorProps {
  icon: LucideIcon;
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

export function EmptyStateError({
  icon: Icon,
  title = 'Something went wrong',
  description = "We couldn't load this data. Please try again.",
  onRetry,
  className = '',
}: EmptyStateErrorProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-danger/30 bg-danger/5 px-6 py-12 text-center ${className}`}
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <Icon size={26} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{description}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring mt-5 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          Try again
        </button>
      )}
    </motion.div>
  );
}
