import { describe, expect, it, vi } from 'vitest';
import {
  OPEN_ACCESSIBILITY_EVENT,
  OPEN_ASK_DATA_EVENT,
  openAccessibilityCenter,
  openAskData,
} from './uiEvents';

describe('uiEvents', () => {
  it('each helper fires only its own event', () => {
    const a11y = vi.fn();
    const ask = vi.fn();
    window.addEventListener(OPEN_ACCESSIBILITY_EVENT, a11y);
    window.addEventListener(OPEN_ASK_DATA_EVENT, ask);

    openAccessibilityCenter();
    expect(a11y).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();

    openAskData();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(a11y).toHaveBeenCalledTimes(1);

    window.removeEventListener(OPEN_ACCESSIBILITY_EVENT, a11y);
    window.removeEventListener(OPEN_ASK_DATA_EVENT, ask);
  });
});
