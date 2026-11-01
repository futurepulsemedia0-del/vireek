/** Runs `cb` when the browser is idle (or after a short timeout on Safari). Returns a cancel function. */
export function whenIdle(cb: () => void, timeoutMs = 2000): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, Math.min(timeoutMs, 1200));
  return () => window.clearTimeout(id);
}
