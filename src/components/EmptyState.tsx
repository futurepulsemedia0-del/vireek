import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
}

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
// ============================================================

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className = '',
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center ${className}`}
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <Icon size={26} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-5 flex items-center gap-3">
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              className="focus-ring rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              {action.label}
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
