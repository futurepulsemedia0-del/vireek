/**
 * Vireek Pulse timing rules (single source — see BRAND_MOTION.md):
 *  1. Loading shorter than `showAfterMs` (150ms) shows nothing.
 *  2. Once shown, the loader stays at least `minVisibleMs` (400ms).
 *  3. A new load that starts while a hide is pending cancels the hide.
 */
export interface DelayedVisibilityOptions {
  showAfterMs?: number;
  minVisibleMs?: number;
}

export interface DelayedVisibility {
  /** Tell the controller whether work is currently in flight. */
  set: (loading: boolean) => void;
  isVisible: () => boolean;
  /** Clears all timers. No more `onChange` calls after this. */
  dispose: () => void;
}

export const SHOW_AFTER_MS = 150;
export const MIN_VISIBLE_MS = 400;

export function createDelayedVisibility(
  onChange: (visible: boolean) => void,
  options: DelayedVisibilityOptions = {},
): DelayedVisibility {
  const showAfterMs = options.showAfterMs ?? SHOW_AFTER_MS;
  const minVisibleMs = options.minVisibleMs ?? MIN_VISIBLE_MS;

  let visible = false;
  let loading = false;
  let shownAt = 0;
  let disposed = false;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearShow = () => {
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = null;
  };
  const clearHide = () => {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  };
  const emit = (next: boolean) => {
    if (disposed || visible === next) return;
    visible = next;
    onChange(next);
  };

  return {
    set(next) {
      if (disposed || next === loading) return;
      loading = next;
      if (next) {
        clearHide(); // rule 3: a new load cancels a pending hide
        if (!visible && showTimer === null) {
          showTimer = setTimeout(() => {
            showTimer = null;
            shownAt = Date.now();
            emit(true);
          }, showAfterMs);
        }
        return;
      }
      clearShow(); // rule 1: finished before showAfterMs → never shown
      if (visible && hideTimer === null) {
        const remaining = Math.max(0, minVisibleMs - (Date.now() - shownAt)); // rule 2
        hideTimer = setTimeout(() => {
          hideTimer = null;
          emit(false);
        }, remaining);
      }
    },
    isVisible: () => visible,
    dispose() {
      disposed = true;
      clearShow();
      clearHide();
    },
  };
}
