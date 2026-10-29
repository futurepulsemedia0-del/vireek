import { useEffect, useState, useSyncExternalStore } from 'react';

// Tiny store: any number of Suspense fallbacks / loaders can signal "busy".
let active = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const subscribe = (s: () => void) => {
  subs.add(s);
  return () => subs.delete(s);
};
const snapshot = () => active > 0;

export const routeProgress = {
  start() {
    active += 1;
    emit();
  },
  done() {
    active = Math.max(0, active - 1);
    emit();
  },
};

/** Render inside any Suspense fallback / loader; the bar shows while it is mounted. */
export function RouteProgressSignal() {
  useEffect(() => {
    routeProgress.start();
    return () => routeProgress.done();
  }, []);
  return null;
}

/** 2px top bar. Appears only after 120ms (no flash on fast navigations). Mount once. */
export function RouteProgressBar() {
  const busy = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (busy) {
      const show = window.setTimeout(() => {
        setProgress(0.3);
        setVisible(true);
      }, 120);
      const trickle = window.setInterval(() => setProgress((p) => (p < 0.9 ? p + (0.9 - p) * 0.2 : p)), 400);
      return () => {
        window.clearTimeout(show);
        window.clearInterval(trickle);
      };
    }
    if (!visible) return;
    setProgress(1);
    const hide = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 200);
    return () => window.clearTimeout(hide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  if (!visible) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 z-[300] h-0.5" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
      <div
        className="h-full origin-left bg-accent motion-safe:transition-transform motion-safe:duration-300 rtl:origin-right"
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
}
