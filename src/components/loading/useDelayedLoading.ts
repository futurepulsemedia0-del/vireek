import { useEffect, useRef, useState } from 'react';
import { createDelayedVisibility, type DelayedVisibility, type DelayedVisibilityOptions } from './delayedVisibility';

/**
 * React wrapper around createDelayedVisibility.
 * Returns true only once loading has lasted >150ms, and keeps it true for >=400ms after being shown.
 */
export function useDelayedLoading(isLoading: boolean, options: DelayedVisibilityOptions = {}): boolean {
  const { showAfterMs, minVisibleMs } = options;
  const [visible, setVisible] = useState(false);
  const controller = useRef<DelayedVisibility | null>(null);

  useEffect(() => {
    const c = createDelayedVisibility(setVisible, { showAfterMs, minVisibleMs });
    controller.current = c;
    return () => {
      c.dispose();
      controller.current = null;
    };
  }, [showAfterMs, minVisibleMs]);

  useEffect(() => {
    controller.current?.set(isLoading);
  }, [isLoading, showAfterMs, minVisibleMs]);

  return visible;
}

/**
 * Progressive reveal for long waits. `stagesMs` are cumulative thresholds, e.g. [150, 700, 1500].
 * Returns how many stages have been reached (0..stagesMs.length). Resets when `active` turns false.
 */
export function useStagedReveal(active: boolean, stagesMs: readonly number[]): number {
  const [stage, setStage] = useState(0);
  const key = stagesMs.join(',');

  useEffect(() => {
    if (!active) {
      setStage(0);
      return;
    }
    const timers = key
      .split(',')
      .filter(Boolean)
      .map((ms, i) => window.setTimeout(() => setStage(i + 1), Number(ms)));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [active, key]);

  return stage;
}
