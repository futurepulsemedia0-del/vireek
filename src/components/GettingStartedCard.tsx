import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Rocket, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useGettingStarted } from '@/hooks/useGettingStarted';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { ProductTour } from '@/components/ProductTour';

export const GETTING_STARTED_PATH = '/dashboard/getting-started';

/**
 * Overview entry point: a compact progress card that hides itself once setup
 * is complete or dismissed, plus the one-time first-run product tour.
 */
export function GettingStartedCard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { status, summary, progress, setDismissed, setTourCompleted } = useGettingStarted();
  const [tourOpen, setTourOpen] = useState(false);

  // First run only: wait for data, finished onboarding, and a settled layout.
  const shouldAutoStart = status === 'ready' && !progress.tourCompleted && profile?.onboarding_completed === true;
  useEffect(() => {
    if (!shouldAutoStart) return;
    const timer = window.setTimeout(() => setTourOpen(true), 700);
    return () => window.clearTimeout(timer);
  }, [shouldAutoStart]);

  const tour = (
    <ProductTour
      open={tourOpen}
      checklistHref={GETTING_STARTED_PATH}
      onFinish={() => {
        setTourOpen(false);
        setTourCompleted(true);
      }}
    />
  );

  if (status === 'error') return tour; // never show a broken card on the overview
  if (status === 'loading') {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5" aria-hidden="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-2 w-full" />
      </div>
    );
  }
  if (progress.checklistDismissed || summary.complete || summary.total === 0) return tour;

  return (
    <>
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        aria-label="Setup progress"
        className="relative rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
      >
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide setup checklist"
          className="focus-ring absolute right-3 top-3 rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
        >
          <X size={15} />
        </button>
        <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Rocket size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">
                Finish setting up Vireek · {summary.done} of {summary.total} done
              </h2>
              {summary.next && (
                <p className="mt-0.5 truncate text-xs text-text-secondary">Up next: {summary.next.title}</p>
              )}
            </div>
          </div>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => navigate(summary.next?.href ?? GETTING_STARTED_PATH)}>
            {summary.next ? summary.next.cta : 'View checklist'} <ArrowRight size={14} />
          </Button>
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={summary.pct}
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
        >
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${summary.pct}%` }} />
        </div>
      </motion.section>
      {tour}
    </>
  );
}
