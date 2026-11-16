import { describe, expect, it } from 'vitest';
import { CENTER_TABS, REGISTRY, SECTIONS, isCategoryModified, resetCategory, settingKeysForTab, type CenterTab } from './registry';
import { COLOR_CHOICES, DEFAULT_SETTINGS, sanitizeSettings } from './settings';
import { computeRenderState } from './apply';

const TABS = CENTER_TABS.map((c) => c.id);

describe('registry structure', () => {
  it('ids are unique and every item/section belongs to a real tab', () => {
    const ids = REGISTRY.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    REGISTRY.forEach((i) => expect(TABS).toContain(i.tab));
    SECTIONS.forEach((s) => expect(TABS).toContain(s.tab));
  });
  it('the 8 design categories plus quick setup exist, in order', () => {
    expect(TABS).toEqual(['quick', 'vision', 'reading', 'cognitive', 'hearing', 'navigation', 'cursor', 'motion', 'advanced']);
  });
  it('every category has something to show', () => {
    TABS.forEach((t) => expect(REGISTRY.some((i) => i.tab === t) || SECTIONS.some((s) => s.tab === t)).toBe(true));
  });
});

describe('per-category reset', () => {
  it('resets only that category and leaves the rest untouched', () => {
    const s = { ...DEFAULT_SETTINGS, focusColor: 'blue' as const, focusWidth: 5, largeCursor: true, highContrast: true, textSize: 1.25 };
    const r = resetCategory(s, 'cursor');
    expect(r.focusColor).toBe('default');
    expect(r.focusWidth).toBe(3);
    expect(r.largeCursor).toBe(false);
    expect(r.highContrast).toBe(true);
    expect(r.textSize).toBe(1.25);
    expect(s.focusColor).toBe('blue'); // input not mutated
  });
  it('cursor reset also clears the legacy keyboard-focus flag', () => {
    expect(resetCategory({ ...DEFAULT_SETTINGS, highlightKeyboardFocus: true }, 'cursor').highlightKeyboardFocus).toBe(false);
  });
  it('reading reset covers text-to-speech; navigation reset covers shortcuts (fresh copy)', () => {
    expect(resetCategory({ ...DEFAULT_SETTINGS, ttsRate: 1.8 }, 'reading').ttsRate).toBe(1);
    const s = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, openCenter: 'Alt+KeyZ' } };
    const r = resetCategory(s, 'navigation');
    expect(r.shortcuts.openCenter).toBe(DEFAULT_SETTINGS.shortcuts.openCenter);
    expect(r.shortcuts).not.toBe(DEFAULT_SETTINGS.shortcuts);
  });
  it('isCategoryModified reflects the category only; quick/advanced have no resettable keys', () => {
    expect(isCategoryModified(DEFAULT_SETTINGS, 'vision')).toBe(false);
    expect(isCategoryModified({ ...DEFAULT_SETTINGS, grayscale: true }, 'vision')).toBe(true);
    expect(isCategoryModified({ ...DEFAULT_SETTINGS, grayscale: true }, 'motion')).toBe(false);
    (['quick', 'advanced'] as CenterTab[]).forEach((t) => expect(settingKeysForTab(t)).toEqual([]));
  });
  it('categories do not share setting keys', () => {
    const seen = new Map<string, CenterTab>();
    TABS.forEach((t) => settingKeysForTab(t).forEach((k) => { expect(seen.has(k)).toBe(false); seen.set(k, t); }));
  });
});

describe('cursor & focus settings', () => {
  it('sanitize accepts only known colors and clamps thickness', () => {
    COLOR_CHOICES.forEach((c) => expect(sanitizeSettings({ cursorColor: c, focusColor: c }).focusColor).toBe(c));
    const s = sanitizeSettings({ cursorColor: 'red', focusColor: 7, focusWidth: 99 });
    expect(s.cursorColor).toBe('default');
    expect(s.focusColor).toBe('default');
    expect(s.focusWidth).toBe(6);
  });
  it('defaults add no classes; custom focus and pointer color map to classes and variables', () => {
    expect(computeRenderState(DEFAULT_SETTINGS).classes).toEqual([]);
    const r = computeRenderState({ ...DEFAULT_SETTINGS, focusColor: 'yellow', focusWidth: 5, cursorColor: 'blue', unstickHeaders: true });
    expect([...r.classes].sort()).toEqual(['a11y-cursor-blue', 'a11y-custom-focus', 'a11y-unstick']);
    expect(r.vars['--a11y-focus-width']).toBe('5px');
    expect(r.vars['--a11y-focus-color']).toBe('#ffd400');
    expect(computeRenderState({ ...DEFAULT_SETTINGS, focusWidth: 4 }).classes).toEqual(['a11y-custom-focus']);
  });
  it('mute/captions are runtime-only (no html class)', () => {
    expect(computeRenderState({ ...DEFAULT_SETTINGS, muteMedia: true, captionsAlways: true }).classes).toEqual([]);
  });
});
