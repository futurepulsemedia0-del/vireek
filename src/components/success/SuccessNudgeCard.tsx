import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { NudgeList } from '@/components/success/NudgeList';
import { useSuccessSnapshot } from '@/hooks/useSuccessSnapshot';

export const SUCCESS_CENTER_PATH = '/dashboard/success';

/** Overview entry point: at most two nudges. Renders nothing while loading, on error, or when there is nothing to suggest. */
export function SuccessNudgeCard() {
  const { status, view, snoozeNudge, dismissNudge } = useSuccessSnapshot({ maxNudges: 2 });
  if (status !== 'ready' || !view || view.nudges.length === 0) return null;
  return (
    <section aria-label="Recommended for you" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-text-primary">Get more from Vireek</h2>
        <Link to={SUCCESS_CENTER_PATH} className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-accent hover:underline">
          Success Center <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </div>
      <NudgeList nudges={view.nudges} onSnooze={(k) => void snoozeNudge(k)} onDismiss={(k) => void dismissNudge(k)} />
    </section>
  );
}
