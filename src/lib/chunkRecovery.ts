import { isChunkLoadError } from '@/lib/incident';

/**
 * After a new deploy, old tabs may request lazy chunks that no longer exist.
 * A single reload fixes it. A cooldown prevents reload loops.
 */
const RELOAD_KEY = 'vk_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 30_000;

function canReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    return !(last && Date.now() - last < RELOAD_COOLDOWN_MS);
  } catch {
    return true;
  }
}

/** Returns true if the error was a stale-chunk failure and a reload was started. */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === 'undefined') return false;
  if (!isChunkLoadError(error as { name?: string; message?: string } | null | undefined)) return false;
  if (!canReload()) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // storage unavailable: still reload once
  }
  window.location.reload();
  return true;
}

/** Call once at boot (src/main.tsx). */
export function installChunkRecovery(): void {
  if (typeof window === 'undefined') return;

  // Vite fires this when a preloaded dynamic import fails.
  window.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (recoverFromChunkError(payload)) event.preventDefault();
  });

  window.addEventListener('unhandledrejection', (event) => {
    recoverFromChunkError(event.reason);
  });
}
