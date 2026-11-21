/**
 * Loading runtime: (1) pauses brand animations while the tab is in the background,
 * (2) removes the static boot loader (#vrk-boot, defined in index.html) once the app has mounted.
 */

const BOOT_ID = 'vrk-boot';
const FADE_MS = 540; // a hair longer than the 500ms CSS fade in index.html

/** Must match the `animation-delay` of `.vb-c` in index.html: the boot content appears after this long. */
export const BOOT_SHOW_AFTER_MS = 250;
/** Once the boot content is on screen it stays at least this long (same value as MIN_VISIBLE_MS). */
export const BOOT_MIN_VISIBLE_MS = 500;

export interface BootDismissPlan {
  /** The content never appeared: remove the element at once, no fade, no flash. */
  instant: boolean;
  /** Extra time to keep it on screen so it does not blink away. */
  waitMs: number;
}

/**
 * Pure. `visibleForMs` is how long the boot content has been visible (<= 0 means it has not appeared yet).
 *  - not yet visible  → remove immediately (rule: a fast load shows nothing)
 *  - visible < 500ms  → wait the remainder, then fade (rule: minimum visible time)
 *  - visible >= 500ms → fade now
 */
export function bootDismissPlan(visibleForMs: number): BootDismissPlan {
  if (!Number.isFinite(visibleForMs) || visibleForMs <= 0) return { instant: true, waitMs: 0 };
  return { instant: false, waitMs: Math.max(0, BOOT_MIN_VISIBLE_MS - visibleForMs) };
}

/** Milliseconds the boot content has been visible, estimated from the navigation timeline. */
function bootVisibleForMs(): number {
  if (typeof performance === 'undefined') return Number.POSITIVE_INFINITY;
  let responseStart = 0;
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    if (nav && Number.isFinite(nav.responseStart)) responseStart = nav.responseStart;
  } catch {
    /* older engines: assume the document started at 0 */
  }
  return performance.now() - (responseStart + BOOT_SHOW_AFTER_MS);
}

let initialised = false;
let stop: (() => void) | null = null;

/** Idempotent. Returns a cleanup function. */
export function initLoadingRuntime(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (initialised && stop) return stop;
  initialised = true;

  const root = document.documentElement;
  const sync = () => {
    if (document.visibilityState === 'hidden') root.setAttribute('data-vrk-paused', '');
    else root.removeAttribute('data-vrk-paused');
  };
  sync();
  document.addEventListener('visibilitychange', sync);

  stop = () => {
    document.removeEventListener('visibilitychange', sync);
    root.removeAttribute('data-vrk-paused');
    initialised = false;
    stop = null;
  };
  return stop;
}

let pendingDismiss: number | null = null;

function fadeOut(el: HTMLElement): void {
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    el.remove();
    return;
  }
  el.classList.add('o');
  window.setTimeout(() => el.remove(), FADE_MS);
}

/**
 * Removes the boot loader. Safe to call more than once.
 * Fast load (<250ms): removed silently. Slower load: held until it has been visible for 500ms, then faded.
 */
export function dismissBootLoader(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(BOOT_ID);
  if (!el || pendingDismiss !== null) return;

  const plan = bootDismissPlan(bootVisibleForMs());
  if (plan.instant) {
    el.remove();
    return;
  }
  const finish = () => {
    pendingDismiss = null;
    const node = document.getElementById(BOOT_ID);
    if (node) fadeOut(node);
  };
  if (plan.waitMs <= 0) {
    finish();
    return;
  }
  pendingDismiss = window.setTimeout(finish, plan.waitMs);
}
