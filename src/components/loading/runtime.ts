/**
 * Loading runtime: (1) pauses brand animations while the tab is in the background,
 * (2) removes the static boot loader (#vrk-boot, defined in index.html) once the app has mounted.
 */

const BOOT_ID = 'vrk-boot';
const FADE_MS = 260; // a hair longer than the 240ms CSS fade in index.html

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

/** Fades out and removes the boot loader. Safe to call more than once. */
export function dismissBootLoader(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(BOOT_ID);
  if (!el) return;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    el.remove();
    return;
  }
  el.classList.add('o');
  window.setTimeout(() => el.remove(), FADE_MS);
}
