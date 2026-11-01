import { useEffect, useRef, useState, type ReactNode } from 'react';
import { whenIdle } from '@/lib/perf/idle';

interface LazyMountProps {
  children: ReactNode;
  /** Reserved height (px or CSS length) until mounted, so nothing shifts when the widget appears. */
  minHeight: number | string;
  rootMargin?: string;
  className?: string;
}

/** Mounts heavy children (charts, maps, voice demo) only when they approach the viewport. */
export function LazyMount({ children, minHeight, rootMargin = '300px 0px', className }: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return (
    <div ref={ref} className={className} style={visible ? undefined : { minHeight }}>
      {visible ? children : null}
    </div>
  );
}

interface IdleMountProps {
  children: ReactNode;
  /** Upper bound before mounting even without idle time or interaction. */
  timeoutMs?: number;
}

/** Mounts non-critical, fixed-position widgets (chat, assistants) after idle or first interaction. */
export function IdleMount({ children, timeoutMs = 4000 }: IdleMountProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const go = () => setReady(true);
    const cancelIdle = whenIdle(go, timeoutMs);
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, go, { once: true, passive: true }));
    return () => {
      cancelIdle();
      events.forEach((e) => window.removeEventListener(e, go));
    };
  }, [timeoutMs]);

  return ready ? <>{children}</> : null;
}
