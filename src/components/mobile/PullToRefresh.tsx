// src/components/mobile/PullToRefresh.tsx — branded pull-to-refresh for the technician screens.
// Only engages when the page is scrolled to the very top. Honors reduced-motion (no spinner animation).

import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { haptic } from '@/lib/native/haptics';
import { PULL_TRIGGER_PX, pullProgress, rubberBand } from '@/lib/native/gestureMath';

interface Props {
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
  disabled?: boolean;
}

export function PullToRefresh({ onRefresh, children, disabled = false }: Props) {
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

  function onTouchStart(e: TouchEvent) {
    if (disabled || refreshing || !atTop()) return;
    startY.current = e.touches[0].clientY;
    armed.current = false;
  }

  function onTouchMove(e: TouchEvent) {
    if (startY.current === null) return;
    const d = e.touches[0].clientY - startY.current;
    if (d <= 0) {
      setPull(0);
      return;
    }
    const shown = rubberBand(d, PULL_TRIGGER_PX * 1.4);
    setPull(shown);
    if (shown >= PULL_TRIGGER_PX && !armed.current) {
      armed.current = true;
      void haptic('impact');
    } else if (shown < PULL_TRIGGER_PX) {
      armed.current = false;
    }
  }

  async function onTouchEnd() {
    const shouldRun = armed.current && !refreshing;
    startY.current = null;
    armed.current = false;
    if (!shouldRun) {
      setPull(0);
      return;
    }
    setRefreshing(true);
    setPull(PULL_TRIGGER_PX * 0.7);
    try {
      await onRefresh();
      void haptic('success');
    } catch {
      void haptic('error');
    } finally {
      setRefreshing(false);
      setPull(0);
    }
  }

  const progress = refreshing ? 1 : pullProgress(pull);

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={() => void onTouchEnd()} onTouchCancel={() => void onTouchEnd()}>
      <div
        className="flex items-center justify-center overflow-hidden text-accent"
        style={{ height: pull, opacity: progress, transition: startY.current === null ? 'height 160ms ease-out' : 'none' }}
        role="status"
        aria-live="polite"
      >
        <Loader2 className={`h-5 w-5 ${refreshing ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" style={{ transform: `rotate(${progress * 270}deg)` }} />
        <span className="sr-only">{refreshing ? 'Refreshing' : progress >= 1 ? 'Release to refresh' : ''}</span>
      </div>
      {children}
    </div>
  );
}
