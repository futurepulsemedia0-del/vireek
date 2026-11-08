// src/lib/motionPolicy.ts
//
// THE motion policy. One module decides whether Vireek is allowed to move, no matter who asked:
//   1. the operating system  (prefers-reduced-motion: reduce)
//   2. the Accessibility Center  (html.a11y-reduce-motion / html.a11y-stop-animations)
// Both sources collapse into ONE attribute on <html>:  data-motion="full" | "reduce" | "stop".
// All CSS (src/styles/motion.css) and all hooks key off that single signal.
//
// Applied before first paint by public/a11y-boot.js and kept live by installMotionRuntime().

export type MotionMode = 'full' | 'reduce' | 'stop';
export type MotionCategory = 'essential' | 'informative' | 'decorative';

export const MOTION_ATTR = 'data-motion';
export const TAB_HIDDEN_ATTR = 'data-tab-hidden';
export const OS_REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
export const CLASS_REDUCE = 'a11y-reduce-motion';
export const CLASS_STOP = 'a11y-stop-animations';

/** Animation names that may still be *running* when motion is reduced (opacity-only, <= ~0.6 Hz). */
export const ALLOWED_REDUCED_ANIMATIONS: readonly string[] = ['vk-essential-fade', 'vrk-soft'];

export interface MotionRule {
  readonly id: string;
  readonly kind: string;
  readonly category: MotionCategory;
  /** Behaviour when mode === 'reduce' (OS preference or Accessibility Center "Reduce Motion"). */
  readonly reduce: string;
  /** Behaviour when mode === 'stop' (Accessibility Center "Stop Animations"). */
  readonly stop: string;
}

/** Documented decision table (mirrored in docs/design/MOTION_POLICY.md; invariants are unit-tested). */
export const MOTION_DECISION_TABLE: readonly MotionRule[] = [
  { id: 'spinner', kind: 'Indeterminate spinner / loader (animate-spin, .vrk-mini, .vrk-spin)', category: 'essential', reduce: 'Non-rotating opacity fade, 1.8s period (vk-essential-fade)', stop: 'Static' },
  { id: 'progress', kind: 'Determinate progress bar / step indicator', category: 'essential', reduce: 'Width/position updates instantly (state stays visible)', stop: 'Instant' },
  { id: 'feedback-color', kind: 'Hover / focus / selected colour, opacity, border changes', category: 'informative', reduce: 'Kept, shortened to 120ms (opacity, colour, border only)', stop: 'Instant' },
  { id: 'toast-dialog', kind: 'Toast / dialog / popover enter and exit', category: 'informative', reduce: 'Opacity only (framer-motion reducedMotion strips transforms)', stop: 'Instant' },
  { id: 'marquee', kind: 'Marquee, ticker, live activity stream, auto-scrolling banner', category: 'informative', reduce: 'No auto-motion; content stays reachable (scroll / drag / keys)', stop: 'No auto-motion' },
  { id: 'autoplay', kind: 'Auto-advancing carousel, autoplaying media', category: 'informative', reduce: 'Does not auto-advance / autoplay; manual controls only', stop: 'Does not auto-advance / autoplay' },
  { id: 'skeleton', kind: 'Skeleton shimmer / pulse', category: 'decorative', reduce: 'Static placeholder', stop: 'Static placeholder' },
  { id: 'live-dot', kind: 'Ping / pulse status dot rings', category: 'decorative', reduce: 'Ring hidden, dot stays', stop: 'Ring hidden, dot stays' },
  { id: 'reveal', kind: 'Reveal-on-scroll, parallax, hero visuals, ambient glow', category: 'decorative', reduce: 'Final state shown immediately (opacity at most)', stop: 'Final state immediately' },
  { id: 'press-hover-transform', kind: 'hover/active scale, translate, lift', category: 'decorative', reduce: 'Transform removed; colour feedback remains', stop: 'Removed' },
  { id: 'smooth-scroll', kind: 'Smooth scrolling (CSS and scrollIntoView / scrollTo)', category: 'decorative', reduce: 'Instant (scrollBehavior() returns "auto")', stop: 'Instant' },
];

type MediaHost = Pick<Window, 'matchMedia'> | undefined;

export function osPrefersReduced(win: MediaHost = typeof window === 'undefined' ? undefined : window): boolean {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia(OS_REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

/** Pure decision: Accessibility Center classes first (stop > reduce), then the OS preference. */
export function readMotionMode(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
  win: MediaHost = typeof window === 'undefined' ? undefined : window,
): MotionMode {
  const cl = doc?.documentElement.classList;
  if (cl?.contains(CLASS_STOP)) return 'stop';
  if (cl?.contains(CLASS_REDUCE)) return 'reduce';
  return osPrefersReduced(win) ? 'reduce' : 'full';
}

export function isMotionReduced(): boolean {
  return readMotionMode() !== 'full';
}

/** Use instead of `behavior: 'smooth'` in scrollTo / scrollIntoView. */
export function scrollBehavior(): ScrollBehavior {
  return isMotionReduced() ? 'auto' : 'smooth';
}

export function syncMotionAttribute(
  doc: Document = document,
  win: MediaHost = typeof window === 'undefined' ? undefined : window,
): MotionMode {
  const mode = readMotionMode(doc, win);
  if (doc.documentElement.getAttribute(MOTION_ATTR) !== mode) doc.documentElement.setAttribute(MOTION_ATTR, mode);
  return mode;
}

/** Subscribe to either source changing (OS media query or <html> class list). Works without the runtime. */
export function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const cleanups: Array<() => void> = [];
  if (typeof window.matchMedia === 'function') {
    try {
      const mql = window.matchMedia(OS_REDUCED_QUERY);
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        cleanups.push(() => mql.removeEventListener('change', onChange));
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onChange);
        cleanups.push(() => mql.removeListener(onChange));
      }
    } catch {
      /* matchMedia unavailable: class changes are still observed */
    }
  }
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    cleanups.push(() => mo.disconnect());
  }
  return () => cleanups.forEach((fn) => fn());
}

/**
 * Boot once (src/main.tsx). Keeps <html data-motion> in sync with both sources and marks
 * <html data-tab-hidden> while the tab is hidden so CSS can pause every running animation.
 */
export function installMotionRuntime(doc: Document = document): () => void {
  syncMotionAttribute(doc);
  const syncHidden = (): void => {
    if (doc.hidden) doc.documentElement.setAttribute(TAB_HIDDEN_ATTR, '');
    else doc.documentElement.removeAttribute(TAB_HIDDEN_ATTR);
  };
  syncHidden();
  const off = subscribeMotion(() => {
    syncMotionAttribute(doc);
  });
  doc.addEventListener('visibilitychange', syncHidden);
  return () => {
    off();
    doc.removeEventListener('visibilitychange', syncHidden);
  };
}
