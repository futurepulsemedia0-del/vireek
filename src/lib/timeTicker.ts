/* ------------------------------------------------------------------ */
/*  timeTicker — ONE shared interval for every live relative timestamp */
/*                                                                      */
/*  Components subscribe via useSyncExternalStore. The interval only    */
/*  runs while at least one subscriber exists, and pauses while the     */
/*  tab is hidden (refreshing immediately when it becomes visible).     */
/* ------------------------------------------------------------------ */

export const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = Date.now();

function emit(): void {
  current = Date.now();
  listeners.forEach((l) => l());
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    emit();
    startTimer();
  } else {
    stopTimer();
  }
}

function startTimer(): void {
  if (timer === null && listeners.size > 0) timer = setInterval(emit, TICK_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function subscribeTicker(listener: () => void): () => void {
  if (listeners.size === 0) {
    current = Date.now();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  }
  listeners.add(listener);
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') startTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopTimer();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Last tick time (ms). Falls back to the real clock when nobody is subscribed yet. */
export function getTickerNow(): number {
  return listeners.size > 0 ? current : Date.now();
}

/** Test helper: number of active subscribers. */
export function tickerSubscriberCount(): number {
  return listeners.size;
}
