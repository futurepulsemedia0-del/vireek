import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, comboFromEvent, findConflict, formatCombo, isValidCombo, matchAction, sanitizeShortcuts } from './shortcuts';

const ev = (o: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }>) =>
  ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: 'KeyA', ...o });

describe('shortcuts', () => {
  it('all defaults are valid and unique', () => {
    const all = SHORTCUT_ACTIONS.map((a) => DEFAULT_SHORTCUTS[a]);
    all.forEach((c) => expect(isValidCombo(c)).toBe(true));
    expect(new Set(all).size).toBe(all.length);
  });
  it('builds canonical combos and ignores bare modifiers', () => {
    expect(comboFromEvent(ev({ altKey: true, shiftKey: true, code: 'KeyA' }))).toBe('Alt+Shift+KeyA');
    expect(comboFromEvent(ev({ ctrlKey: true, altKey: true, code: 'Digit1' }))).toBe('Ctrl+Alt+Digit1');
    expect(comboFromEvent(ev({ code: 'ShiftLeft', shiftKey: true }))).toBe(null);
  });
  it('rejects plain/shift-only, reserved, malformed and non-canonical order', () => {
    for (const bad of ['KeyA', 'Shift+KeyA', 'Ctrl+KeyW', 'Ctrl+KeyC', 'Alt+F4', 'Alt+Shift', 'Alt+Foo', 'Shift+Alt+KeyA', 'Alt+Alt+KeyA', ''])
      expect(isValidCombo(bad)).toBe(false);
    expect(isValidCombo('Alt+KeyZ')).toBe(true);
  });
  it('finds conflicts and matches actions', () => {
    expect(findConflict(DEFAULT_SHORTCUTS, 'toggleContrast', DEFAULT_SHORTCUTS.openCenter)).toBe('openCenter');
    expect(findConflict(DEFAULT_SHORTCUTS, 'openCenter', DEFAULT_SHORTCUTS.openCenter)).toBe(null);
    expect(matchAction(DEFAULT_SHORTCUTS, 'Alt+Shift+KeyC')).toBe('toggleContrast');
    expect(matchAction(DEFAULT_SHORTCUTS, 'Alt+KeyQ')).toBe(null);
  });
  it('formats for display', () => {
    expect(formatCombo('Alt+Shift+KeyA')).toBe('Alt+Shift+A');
    expect(formatCombo('Meta+Digit0')).toBe('⌘+0');
  });
  it('sanitizeShortcuts: keeps valid overrides, resets everything on invalid or duplicate', () => {
    expect(sanitizeShortcuts({ openCenter: 'Alt+KeyZ' }).openCenter).toBe('Alt+KeyZ');
    expect(sanitizeShortcuts({ openCenter: 'KeyZ' })).toEqual(DEFAULT_SHORTCUTS);
    expect(sanitizeShortcuts({ openCenter: DEFAULT_SHORTCUTS.resetAll })).toEqual(DEFAULT_SHORTCUTS);
    expect(sanitizeShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
  });
});
