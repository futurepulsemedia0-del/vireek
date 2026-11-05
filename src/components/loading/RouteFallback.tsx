import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PulseMark } from './PulseMark';
import { TopProgressBar } from './TopProgressBar';
import { useStagedReveal } from './useDelayedLoading';
import './loading.css';

export type RouteFallbackVariant = 'marketing' | 'app' | 'portal';

interface RouteFallbackProps {
  variant?: RouteFallbackVariant;
}

/** Stages (ms): top bar 150 → mark 700 (slow chunk only) → microcopy 1500 (app / portal only). */
const STAGES = [150, 700, 1500] as const;
const COPY_ROTATE_MS = 2400;

/**
 * Suspense fallback for lazy routes. Shows nothing for the first 150ms so fast chunks never flash.
 * Known limit: React unmounts a Suspense fallback the instant the chunk arrives, so the 400ms
 * minimum cannot apply here (it does for LoadingBoundary, Button, Overlay and PullToRefresh).
 */
export function RouteFallback({ variant = 'marketing' }: RouteFallbackProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const stage = useStagedReveal(true, STAGES);
  const [copyIndex, setCopyIndex] = useState(0);
  const showCopy = stage >= 3 && variant !== 'marketing';

  useEffect(() => {
    if (!showCopy) return;
    const id = window.setInterval(() => setCopyIndex((n) => n + 1), COPY_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [showCopy]);

  const copy = copyIndex % 2 === 0 ? t('loading.pickingUp', 'Picking up…') : t('loading.connecting', 'Connecting your calls…');

  return (
    <div className="flex h-full min-h-[60vh] w-full flex-col items-center justify-center gap-4 bg-bg-primary">
      {stage >= 1 && <TopProgressBar />}
      {stage >= 2 && (
        <div className="vrk-fade-in">
          <PulseMark size="md" />
        </div>
      )}
      {showCopy && (
        <p aria-hidden="true" className="vrk-fade-in text-sm text-text-secondary">
          {copy}
        </p>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {stage >= 1 ? t('loading.route', 'Loading') : ''}
      </span>
    </div>
  );
}
