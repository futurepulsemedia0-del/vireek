import { isChunkLoadError } from '@/lib/incident';

const KEY = 'vireek:chunk-reload-at';
const LOOP_GUARD_MS = 60_000;

/** Reload once per minute for a stale deploy. Without working sessionStorage we cannot guard against loops, so we do not reload. */
export function reloadOnceForStaleDeploy(now: number = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? 0);
    if (Number.isFinite(last) && now - last < LOOP_GUARD_MS) return false;
    window.sessionStorage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForStaleDeploy()) event.preventDefault();
  });
}

export function recoverFromChunkError(error: Error): boolean {
  return isChunkLoadError(error) && reloadOnceForStaleDeploy();
}
