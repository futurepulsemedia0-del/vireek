import { beforeEach, describe, expect, it } from 'vitest';
import { applyToDocument } from './apply';
import { DEFAULT_SETTINGS } from './settings';

const root = document.documentElement;
beforeEach(() => {
  root.removeAttribute('style');
  root.className = '';
  document.getElementById('vk-a11y-filters')?.remove();
});

describe('applyToDocument', () => {
  it('does not wipe unrelated inline styles / classes on <html> (regression: setAttribute("style"))', () => {
    root.style.setProperty('--other', '1');
    root.classList.add('dark', 'a11y-rtl');
    applyToDocument({ ...DEFAULT_SETTINGS, highContrast: true });
    expect(root.style.getPropertyValue('--other')).toBe('1');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('a11y-rtl')).toBe(true);
    expect(root.classList.contains('a11y-high-contrast')).toBe(true);
  });
  it('removes classes when settings are switched off', () => {
    applyToDocument({ ...DEFAULT_SETTINGS, hideImages: true });
    applyToDocument(DEFAULT_SETTINGS);
    expect(root.classList.contains('a11y-hide-images')).toBe(false);
  });
  it('creates, swaps and removes the color-blind SVG filter', () => {
    applyToDocument({ ...DEFAULT_SETTINGS, colorBlind: 'protanopia' });
    expect(document.querySelectorAll('#vk-a11y-filters')).toHaveLength(1);
    expect(document.getElementById('vk-a11y-cb-protanopia')).not.toBeNull();
    applyToDocument({ ...DEFAULT_SETTINGS, colorBlind: 'tritanopia' });
    expect(document.querySelectorAll('#vk-a11y-filters')).toHaveLength(1);
    expect(document.getElementById('vk-a11y-cb-tritanopia')).not.toBeNull();
    applyToDocument(DEFAULT_SETTINGS);
    expect(document.getElementById('vk-a11y-filters')).toBeNull();
  });
});
