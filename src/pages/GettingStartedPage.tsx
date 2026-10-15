/**
 * Getting Started — /dashboard/getting-started
 *
 * Persistent setup checklist. Completion is auto-detected from the account's
 * real data (see src/lib/gettingStartedApi.ts) and re-checked whenever the tab
 * regains focus; only per-person intent (skips, dismissal, tour) is stored.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle, ArrowRight, BookUser, Check, CircleDashed, CreditCard, FileText, Link2, Loader2, PartyPopper,
  PhoneCall, PlayCircle, Phone, RefreshCw, Rocket, Settings, Tag, Undo2, Users, Wrench, EyeOff, Eye,
  type LucideIcon,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { ProductTour } from '@/components/ProductTour';
import { Button } from '@/components/ui/Button';
import { useGettingStarted } from '@/hooks/useGettingStarted';
import { GROUPS, type StepKey, type StepView } from '@/lib/gettingStarted';

const ICONS: Record<StepKey, LucideIcon> = {
  business_profile: Settings,
  phone_number: Phone,
  team: Users,
  customer: BookUser,
  job: Wrench,
  price_book: Tag,
  quote: FileText,
  invoice: CreditCard,
  integrations: Link2,
  first_call: PhoneCall,
};

function StatusDot({ status }: { status: StepView['status'] }) {
  if (status === 'done') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-500 text-white">
        <Check size={15} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (status === 'unknown') {
    return <AlertCircle size={28} className="shrink-0 text-warning-500" aria-hidden="true" />;
  }
  return (
    <CircleDashed
      size={28}
      className={`shrink-0 ${status === 'skipped' ? 'text-text-secondary/40' : 'text-text-secondary/70'}`}
      aria-hidden="true"
    />
  );
}

const STATUS_LABEL: Record<StepView['status'], string> = {
  done: 'Completed',
  todo: 'Not started',
  skipped: 'Skipped',
  unknown: 'Couldn’t check',
};

function StepRow({
  step, onGo, onSkip, onUnskip, onRetry,
}: {
  step: StepView;
  onGo: () => void;
  onSkip: () => void;
  onUnskip: () => void;
  onRetry: () => void;
}) {
  const Icon = ICONS[step.key];
  const muted = step.status === 'done' || step.status === 'skipped';
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StatusDot status={step.status} />
        <div className="min-w-0">
          <h3 className={`flex items-center gap-2 text-sm font-semibold ${muted ? 'text-text-secondary' : 'text-text-primary'}`}>
            <Icon size={15} className="shrink-0 text-text-secondary/70" aria-hidden="true" />
            <span className={step.status === 'done' ? 'line-through decoration-text-secondary/40' : ''}>{step.title}</span>
            <span className="sr-only"> — {STATUS_LABEL[step.status]}</span>
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {step.status === 'unknown' ? 'We couldn’t check this step right now. Try again in a moment.' : step.description}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-10 sm:pl-0">
        {step.status === 'todo' && (
          <>
            <Button size="sm" onClick={onGo}>
              {step.cta} <ArrowRight size={14} aria-hidden="true" />
            </Button>
            {step.skippable && (
              <Button size="sm" variant="ghost" onClick={onSkip}>
                Skip
              </Button>
            )}
          </>
        )}
        {step.status === 'skipped' && (
          <Button size="sm" variant="ghost" onClick={onUnskip}>
            <Undo2 size={14} aria-hidden="true" /> Undo skip
          </Button>
        )}
        {step.status === 'unknown' && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        )}
        {step.status === 'done' && (
          <Button size="sm" variant="ghost" onClick={onGo}>
            Open
          </Button>
        )}
      </div>
    </li>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your checklist">
      <Skeleton className="h-28 w-full rounded-2xl" />
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      ))}
    </div>
  );
}

export function GettingStartedPage() {
  const navigate = useNavigate();
  const gs = useGettingStarted();
  const { status, steps, summary, progress, refreshing } = gs;
  const [tourOpen, setTourOpen] = useState(false);

  return (
    <DashboardLayout activeLabel="Getting Started">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-text-primary">
              <Rocket size={24} className="text-accent" aria-hidden="true" /> Getting Started
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Your setup progress updates automatically as you use Vireek.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setTourOpen(true)}>
              <PlayCircle size={14} aria-hidden="true" /> Take the tour
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void gs.refresh()} disabled={refreshing || status === 'loading'}>
              {refreshing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              Refresh
            </Button>
          </div>
        </header>

        {status === 'loading' && <LoadingState />}

        {status === 'error' && (
          <EmptyState
            icon={AlertCircle}
            title="We couldn’t load your checklist"
            description="Check your connection and try again. Nothing has been lost."
            action={{ label: 'Try again', onClick: () => void gs.refresh() }}
          />
        )}

        {status === 'ready' && summary.total === 0 && (
          <EmptyState
            icon={Check}
            title="Nothing to set up for your role"
            description="Your account owner handles setup. Take the tour to learn your way around."
            action={{ label: 'Take the tour', onClick: () => setTourOpen(true) }}
          />
        )}

        {status === 'ready' && summary.total > 0 && (
          <div className="space-y-8">
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              aria-label="Overall progress"
              className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
            >
              {summary.complete ? (
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success-500/10 text-success-500">
                    <PartyPopper size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">You’re all set up</h2>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      Every step is complete{summary.skipped > 0 ? ` or skipped (${summary.skipped} skipped — you can undo any time)` : ''}.
                      Vireek is working for you.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div aria-live="polite">
                      <p className="text-3xl font-bold tracking-tight text-text-primary">{summary.pct}%</p>
                      <p className="text-sm text-text-secondary">
                        {summary.done} of {summary.total} steps complete
                        {summary.skipped > 0 && ` · ${summary.skipped} skipped`}
                      </p>
                    </div>
                    {summary.next && (
                      <Button size="sm" onClick={() => navigate(summary.next!.href)}>
                        Next: {summary.next.cta} <ArrowRight size={14} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Setup progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={summary.pct}
                    className="mt-4 h-2 overflow-hidden rounded-full bg-bg-tertiary"
                  >
                    <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${summary.pct}%` }} />
                  </div>
                </>
              )}
            </motion.section>

            {GROUPS.map((group) => {
              const groupSteps = steps.filter((s) => s.group === group.key);
              if (groupSteps.length === 0) return null;
              const groupDone = groupSteps.filter((s) => s.status === 'done').length;
              return (
                <section key={group.key} aria-labelledby={`gs-${group.key}`}>
                  <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                    <div>
                      <h2 id={`gs-${group.key}`} className="text-sm font-semibold text-text-primary">{group.title}</h2>
                      <p className="text-xs text-text-secondary">{group.blurb}</p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-text-secondary">
                      {groupDone}/{groupSteps.length}
                    </span>
                  </div>
                  <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                    {groupSteps.map((step) => (
                      <StepRow
                        key={step.key}
                        step={step}
                        onGo={() => navigate(step.href)}
                        onSkip={() => gs.skipStep(step.key)}
                        onUnskip={() => gs.unskipStep(step.key)}
                        onRetry={() => void gs.refresh()}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}

            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={() => gs.setDismissed(!progress.checklistDismissed)}>
                {progress.checklistDismissed ? (
                  <><Eye size={14} aria-hidden="true" /> Show checklist on Overview</>
                ) : (
                  <><EyeOff size={14} aria-hidden="true" /> Hide checklist from Overview</>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ProductTour
        open={tourOpen}
        onFinish={() => {
          setTourOpen(false);
          gs.setTourCompleted(true);
        }}
      />
    </DashboardLayout>
  );
}
