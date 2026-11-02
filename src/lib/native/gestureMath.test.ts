import { describe, expect, it } from 'vitest';
import { isHorizontalIntent, pullProgress, resolveSnap, resolveSwipe, rubberBand, shouldDismissSheet } from './gestureMath';

describe('resolveSwipe', () => {
  it('ignores short slow drags', () => expect(resolveSwipe({ dx: -100, dy: 5, velocityX: -0.1, width: 360 })).toBe('none'));
  it('commits past 35% of the row', () => expect(resolveSwipe({ dx: -130, dy: 5, velocityX: -0.1, width: 360 })).toBe('left'));
  it('commits on a fast flick', () => expect(resolveSwipe({ dx: 60, dy: 5, velocityX: 0.9, width: 360 })).toBe('right'));
  it('treats mostly-vertical movement as scrolling', () => expect(resolveSwipe({ dx: -200, dy: 260, velocityX: -1, width: 360 })).toBe('none'));
});

describe('misc gesture maths', () => {
  it('rubber-bands past the limit', () => {
    expect(rubberBand(-5, 100)).toBe(0);
    expect(rubberBand(140, 100)).toBe(110);
  });
  it('detects horizontal intent', () => {
    expect(isHorizontalIntent(30, 5)).toBe(true);
    expect(isHorizontalIntent(30, 30)).toBe(false);
  });
  it('snaps to nearest, or one step on a flick', () => {
    expect(resolveSnap([0.4, 0.9], 0.5, 0)).toBe(0);
    expect(resolveSnap([0.4, 0.9], 0.5, -0.8)).toBe(1);
    expect(resolveSnap([0.4, 0.9], 0.85, 0.8)).toBe(0);
  });
  it('dismisses when dragged far below the lowest snap', () => {
    expect(shouldDismissSheet([0.4, 0.9], 0.2, 0)).toBe(true);
    expect(shouldDismissSheet([0.4, 0.9], 0.38, 0)).toBe(false);
  });
  it('reports pull progress', () => expect(pullProgress(36)).toBe(0.5));
});
