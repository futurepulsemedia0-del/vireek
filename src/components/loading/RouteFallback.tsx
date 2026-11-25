import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandLoader } from './BrandLoader';
import { LoaderStage } from './LoaderStage';
import { TopProgressBar } from './TopProgressBar';
import { useStagedReveal } from './useDelayedLoading';
import './loading.css';

/** marketing → signal · app / portal → pulse (in-app navigation) · data → network (dashboard / data loading). */
export type RouteFallbackVariant = 'marketing' | 'app' | 'portal' | 'data';

interface RouteFallbackProps {
  variant?: RouteFallbackVariant;
   /** Auth guards that replace the whole screen (cold start): show the mark from the first frame so there is never a blank gap after the boot loader is gone. */
  fullScreen?: boolean;
  /** Suspense fallbacks of lazy routes: show the mark from the first frame (routeLazy guarantees one full loop). */
  immediate?: boolean;
}

// top bar 250 → mark 800 (slow chunk only) → microcopy 1600 (app / portal / data only)
const STAGES = [250, 800, 1600] as const;
const IMMEDIATE_STAGES = [0, 0, 2600] as const;
const COPY_ROTATE_MS = 2400;

/**
 * Suspense fallback for lazy routes. Shows nothing for the first 250ms so fast chunks never flash.
 * Known limit: React unmounts a Suspense fallback the instant the chunk arrives, so the 400ms
 * minimum cannot apply here (it does for LoadingBoundary, Button, Overlay and PullToRefresh).
 */
export function RouteFallback({ variant = 'marketing', fullScreen = false, immediate = false }: RouteFallbackProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const stage = useStagedReveal(true, immediate || fullScreen ? IMMEDIATE_STAGES : STAGES);
  const [copyIndex, setCopyIndex] = useState(0);
  const showCopy = stage >= 3 && variant !== 'marketing';

  useEffect(() => {
    if (!showCopy) return;
    const id = window.setInterval(() => setCopyIndex((n) => n + 1), COPY_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [showCopy]);

  const copy = copyIndex % 2 === 0 ? t('loading.pickingUp', 'Picking up…') : t('loading.connecting', 'Connecting your calls…');

  return (
    <LoaderStage>
      {stage >= 1 && <TopProgressBar />}
      {/* Fixed-size box: the mark sits at the exact centre of the visible area from the first frame, and the
          microcopy hangs BELOW it (absolute) so it appearing later can never push the mark upwards. */}
      <div className="relative flex h-36 w-[156px] items-center justify-center">
        {stage >= 2 && (
          <div className="vrk-fade-in">
            <BrandLoader variant={variant === 'marketing' ? 'signal' : variant === 'data' ? 'network' : 'pulse'} size="xxl" />
          </div>
        )}
        {showCopy && (
          <p
            aria-hidden="true"
            className="vrk-fade-in absolute left-1/2 top-full mt-5 -translate-x-1/2 whitespace-nowrap text-sm text-text-secondary sm:text-base"
          >
            {copy}
          </p>
        )}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {stage >= 1 ? t('loading.route', 'Loading') : ''}
      </span>
    </LoaderStage>
  );
}
