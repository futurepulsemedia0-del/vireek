import { Button } from '@/components/ui/Button';
import { useTourT } from './useTourT';

interface Props {
  stepIndex: number;
  stepCount: number;
  onResume: () => void;
  onLater: () => void;
  onDismiss: () => void;
}

/** Non-modal nudge shown when a paused tour exists. Never steals focus. */
export function TourResumePrompt({ stepIndex, stepCount, onResume, onLater, onDismiss }: Props) {
  const tt = useTourT();
  return (
    <div
      role="region"
      aria-label={tt('tour.ui.resumeRegion', 'Resume product tour')}
      className="fixed bottom-4 end-4 z-[65] w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-border bg-bg-secondary p-4 shadow-2xl print:hidden"
    >
      <h2 className="text-sm font-semibold text-text-primary">{tt('tour.ui.resumeTitle', 'Continue your tour?')}</h2>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        {tt('tour.ui.resumeBody', 'You paused at step {{current}} of {{total}}. Pick up right where you left off.', {
          current: Math.min(stepIndex + 1, stepCount),
          total: stepCount,
        })}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onResume}>
          {tt('tour.ui.resume', 'Resume')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onLater}>
          {tt('tour.ui.notNow', 'Not now')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {tt('tour.ui.dontAsk', 'Don’t ask again')}
        </Button>
      </div>
    </div>
  );
}
