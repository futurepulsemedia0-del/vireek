import { describe, it, expect } from 'vitest';
import {
  createMatcher,
  detectConflicts,
  detectPlatform,
  formatBinding,
  isReservedBinding,
  normalizeBinding,
  parseBinding,
  resolveShortcuts,
  sanitizeOverrides,
  speakBinding,
  stepMatches,
  validateOverride,
  type KeyEventLike,
  type MatchInput,
  type ShortcutContext,
  type ShortcutDef,
} from './registry';
import { SHORTCUT_DEFS, navigationHandlers } from './definitions';

const ev = (o: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe('binding grammar', () => {
  it('normalises modifiers, case, sequences and symbol keys', () => {
    expect(normalizeBinding('Shift+Mod+K')).toBe('mod+shift+k');
    expect(normalizeBinding('shift+?')).toBe('?');
    expect(normalizeBinding('G  O')).toBe('g o');
    expect(normalizeBinding('mod+plus')).toBe('mod+plus');
  });

  it('rejects invalid bindings', () => {
    for (const bad of ['', 'mod++', 'ctrl+k', 'mod+k o', 'a b c d', 'mod+', 'mod+mod+k', 'f13']) {
      expect(normalizeBinding(bad), bad).toBeNull();
    }
    expect(parseBinding('mod+k')).toHaveLength(1);
  });
});

describe('event matching', () => {
  it('matches "?" with or without Shift (regression: the old matcher never fired it on US keyboards)', () => {
    const step = parseBinding('?')![0];
    expect(stepMatches(step, ev({ key: '?', shiftKey: true }), 'other')).toBe(true);
    expect(stepMatches(step, ev({ key: '?' }), 'other')).toBe(true);
  });

  it('uses Cmd on macOS and Ctrl elsewhere, never the other one', () => {
    const k = parseBinding('mod+k')![0];
    expect(stepMatches(k, ev({ key: 'k', ctrlKey: true }), 'other')).toBe(true);
    expect(stepMatches(k, ev({ key: 'k', metaKey: true }), 'other')).toBe(false);
    expect(stepMatches(k, ev({ key: 'k', metaKey: true }), 'mac')).toBe(true);
    expect(stepMatches(k, ev({ key: 'k', ctrlKey: true }), 'mac')).toBe(false);
  });

  it('keeps Shift as part of a letter binding', () => {
    const k = parseBinding('mod+k')![0];
    expect(stepMatches(k, ev({ key: 'K', ctrlKey: true, shiftKey: true }), 'other')).toBe(false);
  });

  it('uses the physical key for macOS Option+letter', () => {
    const s = parseBinding('alt+j')![0];
    expect(stepMatches(s, ev({ key: '∆', code: 'KeyJ', altKey: true }), 'mac')).toBe(true);
  });

  it('detects the platform', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ userAgentData: { platform: 'Windows' } })).toBe('other');
  });
});

describe('display + screen reader text', () => {
  it('renders Mac and Windows glyphs', () => {
    const glyphs = (p: 'mac' | 'other') => formatBinding('mod+shift+k', p).map((s) => s.map((k) => k.glyph));
    expect(glyphs('mac')).toEqual([['⌘', '⇧', 'K']]);
    expect(glyphs('other')).toEqual([['Ctrl', 'Shift', 'K']]);
  });

  it('speaks bindings as phrases', () => {
    expect(speakBinding('mod+shift+k', 'mac')).toBe('Command Shift K');
    expect(speakBinding('g o', 'other')).toBe('G then O');
    expect(speakBinding('g o', 'other', 'luego')).toBe('G luego O');
    expect(speakBinding('?', 'other')).toBe('Question mark');
  });
});

describe('default definitions', () => {
  it('have unique ids, valid bindings, no reserved keys and ZERO conflicts', () => {
    expect(new Set(SHORTCUT_DEFS.map((d) => d.id)).size).toBe(SHORTCUT_DEFS.length);
    for (const d of SHORTCUT_DEFS) {
      expect(normalizeBinding(d.binding), d.id).not.toBeNull();
      expect(isReservedBinding(d.binding), d.id).toBe(false);
    }
    expect(detectConflicts(resolveShortcuts(SHORTCUT_DEFS, {}))).toEqual([]);
  });

  it('derives a handler for every shortcut that has an href', () => {
    const calls: Array<[string, unknown]> = [];
    const handlers = navigationHandlers((href, opts) => calls.push([href, opts]));
    for (const d of SHORTCUT_DEFS.filter((x) => x.href)) expect(typeof handlers[d.id]).toBe('function');
    handlers['create.job']();
    expect(calls[0]).toEqual(['/dashboard/jobs', { state: { prefill: {} } }]);
    handlers['nav.calendar']();
    expect(calls[1]).toEqual(['/dashboard/calendar', undefined]);
  });
});

describe('conflict detection', () => {
  const mk = (id: string, binding: string, context: ShortcutContext = 'global'): ShortcutDef => ({
    id,
    binding,
    category: 'general',
    defaultLabel: id,
    context,
  });
  const conflictsOf = (defs: ShortcutDef[]) => detectConflicts(resolveShortcuts(defs, {}));

  it('flags duplicates', () => {
    expect(conflictsOf([mk('a', 'g o'), mk('b', 'g o')])[0]?.kind).toBe('duplicate');
  });
  it('flags a short binding that shadows a longer sequence', () => {
    expect(conflictsOf([mk('a', 'g'), mk('b', 'g o')])[0]?.kind).toBe('shadow');
  });
  it('treats the global context as overlapping every context', () => {
    expect(conflictsOf([mk('a', 'x', 'dashboard'), mk('b', 'x', 'global')])).toHaveLength(1);
  });
  it('allows different contexts to reuse a binding when neither is global', () => {
    // only 'global' and 'dashboard' exist today, so two distinct non-global contexts cannot collide
    expect(conflictsOf([mk('a', 'x', 'dashboard'), mk('b', 'y', 'dashboard')])).toEqual([]);
  });
});

describe('user overrides', () => {
  it('accepts a free binding and reports why others are refused', () => {
    expect(validateOverride(SHORTCUT_DEFS, {}, 'nav.jobs', 'g x')).toEqual({ ok: true, binding: 'g x' });
    const reason = (id: string, b: string | null) => {
      const r = validateOverride(SHORTCUT_DEFS, {}, id, b);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason('nav.jobs', 'g o')).toBe('conflict');
    expect(reason('nav.jobs', 'mod+t')).toBe('reserved');
    expect(reason('nav.jobs', '/')).toBe('reserved');
    expect(reason('nav.jobs', 'nope+++')).toBe('invalid');
    expect(reason('missing.id', 'g x')).toBe('unknown');
    expect(reason('create.job', 'g')).toBe('conflict'); // would swallow every "g …" sequence
    expect(reason('nav.jobs', null)).toBe('ok'); // turning a shortcut off is always allowed
  });

  it('sanitises hostile, stale or conflicting stored data', () => {
    const out = sanitizeOverrides(SHORTCUT_DEFS, {
      'nav.jobs': 'g x',
      'nav.team': 'g x',
      ghost: 'q',
      'nav.leads': 5,
      'nav.calls': 'mod+t',
      'nav.insights': null,
    });
    expect(out['nav.insights']).toBeNull();
    expect('ghost' in out).toBe(false);
    expect('nav.leads' in out).toBe(false);
    expect('nav.calls' in out).toBe(false);
    expect(detectConflicts(resolveShortcuts(SHORTCUT_DEFS, out))).toEqual([]);
    expect(sanitizeOverrides(SHORTCUT_DEFS, 'garbage')).toEqual({});
    expect(sanitizeOverrides(SHORTCUT_DEFS, [1, 2])).toEqual({});
  });

  it('resolves overrides and drops disabled shortcuts', () => {
    const r = resolveShortcuts(SHORTCUT_DEFS, { 'nav.jobs': 'g x', 'nav.team': null });
    expect(r.find((s) => s.def.id === 'nav.jobs')?.binding).toBe('g x');
    expect(r.find((s) => s.def.id === 'nav.jobs')?.overridden).toBe(true);
    expect(r.some((s) => s.def.id === 'nav.team')).toBe(false);
  });
});

describe('matcher (sequences, typing, dialogs, IME)', () => {
  const ALL = resolveShortcuts(SHORTCUT_DEFS, {});
  const ctx = (extra: Partial<MatchInput> = {}) => ({
    typing: false,
    dialogOpen: false,
    contexts: new Set<ShortcutContext>(['dashboard']),
    ...extra,
  });
  const press = (
    m: ReturnType<typeof createMatcher>,
    key: string,
    now: number,
    extra: Partial<KeyEventLike> = {},
    c: Partial<MatchInput> = {},
  ) => m.match(ALL, { event: ev({ key, ...extra }), now, ...ctx(c) })?.def.id ?? null;
  const fresh = () => createMatcher({ platform: 'other' });

  it('fires "g" then "c" inside the window, not after it', () => {
    const m = fresh();
    expect(press(m, 'g', 0)).toBeNull();
    expect(press(m, 'c', 300)).toBe('nav.calendar');
    expect(press(m, 'g', 1000)).toBeNull();
    expect(press(m, 'c', 2500)).toBeNull();
  });

  it('needs the dashboard context for dashboard shortcuts', () => {
    const m = fresh();
    press(m, 'g', 0, {}, { contexts: new Set() });
    expect(press(m, 'c', 100, {}, { contexts: new Set() })).toBeNull();
  });

  it('never fires while typing — except mod chords flagged allowInInput', () => {
    const m = fresh();
    expect(press(m, 'g', 0, {}, { typing: true })).toBeNull();
    expect(press(m, 'c', 50, {}, { typing: true })).toBeNull();
    expect(press(m, '?', 60, { shiftKey: true }, { typing: true })).toBeNull();
    expect(press(m, 'k', 70, { ctrlKey: true }, { typing: true })).toBe('palette.toggle');
  });

  it('typing resets a half-entered sequence', () => {
    const m = fresh();
    press(m, 'g', 0);
    press(m, 'x', 10, {}, { typing: true });
    expect(press(m, 'c', 20)).toBeNull();
  });

  it('blocks shortcuts behind an open modal except allowInDialog ones', () => {
    const m = fresh();
    expect(press(m, '?', 0, { shiftKey: true }, { dialogOpen: true })).toBeNull();
    expect(press(m, 'k', 1, { ctrlKey: true }, { dialogOpen: true })).toBe('palette.toggle');
  });

  it('ignores IME composition and auto-repeat', () => {
    const m = fresh();
    expect(m.match(ALL, { event: { ...ev({ key: '?', shiftKey: true }), isComposing: true }, now: 0, ...ctx() })).toBeNull();
    expect(m.match(ALL, { event: { ...ev({ key: 'k', ctrlKey: true }), repeat: true }, now: 0, ...ctx() })).toBeNull();
  });

  it('keeps a sequence alive across a bare modifier press', () => {
    const m = fresh();
    press(m, 'c', 0);
    expect(press(m, 'Shift', 100, { shiftKey: true })).toBeNull();
    expect(press(m, 'j', 200)).toBe('create.job');
  });

  it('only fires shortcuts that have a registered handler', () => {
    const m = createMatcher({ platform: 'other', canFire: (id) => id === 'help.shortcuts' });
    expect(m.match(ALL, { event: ev({ key: 'k', ctrlKey: true }), now: 0, ...ctx() })).toBeNull();
    expect(m.match(ALL, { event: ev({ key: '?', shiftKey: true }), now: 1, ...ctx() })?.def.id).toBe('help.shortcuts');
  });
});
