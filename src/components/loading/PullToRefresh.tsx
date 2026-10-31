import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PulseMark } from './PulseMark';
import './loading.css';

const THRESHOLD = 64;
const MAX_PULL = 96;
const MIN_SHOW_MS = 400;

interface PullToRefreshProps {
  onRefresh: () => Promise<unknown>;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Brand pull-to-refresh for Capacitor/mobile. Touch only; transform/opacity only.
 * Activates only when the page is scrolled to the top. The refresh indicator stays >= 400ms.
 */
export function PullToRefresh({ onRefresh, disabled = false, className, children }: PullToRefreshProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const root = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const el = root.current;
    const ind = indicator.current;
    if (!el || !ind || disabled) return;
    let startY = 0;
    let pull = 0;
    let tracking = false;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const paint = (distance: number, animate: boolean) => {
      const ratio = Math.min(1, distance / THRESHOLD);
      ind.style.transition = animate ? 'transform 240ms cubic-bezier(0.16,1,0.3,1), opacity 240ms cubic-bezier(0.16,1,0.3,1)' : 'none';
      ind.style.opacity = String(ratio);
      ind.style.transform = reduced() ? 'translateY(0)' : `translateY(${distance - 48}px) scale(${0.6 + 0.4 * ratio})`;
    };
    const atTop = () => window.scrollY <= 0 && el.scrollTop <= 0;

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || !atTop() || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      tracking = true;
      pull = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) {
        pull = 0;
        paint(0, false);
        return;
      }
      pull = Math.min(MAX_PULL, dy * 0.5);
      paint(pull, false);
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (pull < THRESHOLD) {
        paint(0, true);
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      paint(THRESHOLD, true);
      const minimum = new Promise<void>((r) => window.setTimeout(r, MIN_SHOW_MS));
      void Promise.allSettled([onRefresh(), minimum]).then(() => {
        refreshingRef.current = false;
        setRefreshing(false);
        paint(0, true);
      });
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [disabled, onRefresh]);

  return (
    <div ref={root} className={className} style={{ overscrollBehaviorY: 'contain' }}>
      <div
        ref={indicator}
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 z-[2147482000] mx-auto w-fit rounded-full border border-border bg-bg-secondary p-1.5 shadow-lg"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)', opacity: 0, transform: 'translateY(-48px)' }}
      >
        <PulseMark size="sm" />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {refreshing ? t('loading.refreshing', 'Refreshing…') : ''}
      </span>
      {children}
    </div>
  );
}
