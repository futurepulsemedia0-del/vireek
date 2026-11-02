// src/lib/native/gestureMath.ts — pure maths for swipe rows, bottom sheets and pull-to-refresh.

export const MIN_TOUCH_TARGET_PX = 44;

/** Rubber-band: the further you pull past the limit, the less the content follows. */
export function rubberBand(distance: number, limit: number): number {
  if (distance <= 0) return 0;
  if (distance <= limit) return distance;
  return limit + (distance - limit) * 0.25;
}

export type SwipeOutcome = 'none' | 'left' | 'right';

export interface SwipeInput {
  dx: number;
  dy: number;
  velocityX: number; // px/ms, signed
  width: number;
}

/** Commit when dragged past 35% of the row, or flicked fast; ignore mostly-vertical drags (scrolling). */
export function resolveSwipe({ dx, dy, velocityX, width }: SwipeInput): SwipeOutcome {
  if (width <= 0) return 'none';
  if (Math.abs(dy) > Math.abs(dx)) return 'none';
  const far = Math.abs(dx) >= width * 0.35;
  const fast = Math.abs(velocityX) >= 0.5 && Math.abs(dx) >= 48;
  if (!far && !fast) return 'none';
  return dx < 0 ? 'left' : 'right';
}

/** True while a horizontal drag has clearly started (so the page must stop scrolling vertically). */
export function isHorizontalIntent(dx: number, dy: number, slop = 10): boolean {
  return Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Snap points are fractions of the viewport height (0–1), ascending. Returns the index to settle on. */
export function resolveSnap(points: readonly number[], currentFraction: number, velocityY: number): number {
  if (points.length === 0) return 0;
  const sorted = points;
  // Flick: move one snap in the direction of the flick (velocityY > 0 = moving down = smaller sheet).
  const nearest = nearestIndex(sorted, currentFraction);
  if (Math.abs(velocityY) >= 0.6) {
    const step = velocityY > 0 ? -1 : 1;
    return Math.min(sorted.length - 1, Math.max(0, nearest + step));
  }
  return nearest;
}

function nearestIndex(points: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i] - value) < Math.abs(points[best] - value)) best = i;
  }
  return best;
}

/** Dragging the sheet below this fraction of its smallest snap dismisses it. */
export function shouldDismissSheet(points: readonly number[], currentFraction: number, velocityY: number): boolean {
  const lowest = points[0] ?? 0.5;
  return currentFraction < lowest * 0.6 || (velocityY >= 1.0 && currentFraction <= lowest);
}

export const PULL_TRIGGER_PX = 72;
export function pullProgress(distance: number): number {
  return Math.min(1, Math.max(0, distance / PULL_TRIGGER_PX));
}
