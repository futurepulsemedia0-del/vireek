/**
 * Timing and dismissal rules for the first-layer cookie banner.
 * Framework-free (no React, no '@/' imports) so it can be unit-tested directly.
 *
 * Dismissal (X / Escape) is NOT a consent decision: optional cookies stay off, the consent engine
 * is untouched, and the banner simply stays away for BANNER_RESHOW_AFTER_MS.
 */

/** Visible-tab time after the page has loaded before the banner may appear. */
export const BANNER_REVEAL_DELAY_MS = 3000;
/** Upper bound for requestIdleCallback so the reveal is never starved on a busy main thread. */
export const BANNER_IDLE_TIMEOUT_MS = 1500;
/** First scroll past this share of the scrollable page reveals the banner early. */
export const BANNER_SCROLL_REVEAL_RATIO = 0.25;
/** Exit animation length; must match `duration-300` in ConsentBanner. */
export const BANNER_EXIT_MS = 300;
export const BANNER_DISMISS_STORAGE_KEY = 'vireek-consent-dismissed-at';
export const BANNER_RESHOW_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Share (0..1) of the scrollable distance already scrolled. 0 when the page does not scroll. */
export function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const scrollable = scrollHeight - clientHeight;
  if (!Number.isFinite(scrollable) || scrollable <= 0 || !Number.isFinite(scrollTop)) return 0;
  return Math.min(1, Math.max(0, scrollTop / scrollable));
}

/** True while a stored dismissal timestamp is younger than BANNER_RESHOW_AFTER_MS. */
export function isDismissalActive(raw: string | null, now: number): boolean {
  if (!raw) return false;
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return false;
  // A timestamp in the future (clock change) must never suppress the banner for good.
  if (at > now) return false;
  return now - at < BANNER_RESHOW_AFTER_MS;
}

export function readBannerDismissed(now: number = Date.now()): boolean {
  try {
    return isDismissalActive(localStorage.getItem(BANNER_DISMISS_STORAGE_KEY), now);
  } catch {
    return false;
  }
}

export function markBannerDismissed(now: number = Date.now()): void {
  try {
    localStorage.setItem(BANNER_DISMISS_STORAGE_KEY, String(now));
  } catch {
    /* storage blocked: the banner may return on the next full load, which is acceptable */
  }
}

export function clearBannerDismissal(): void {
  try {
    localStorage.removeItem(BANNER_DISMISS_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
