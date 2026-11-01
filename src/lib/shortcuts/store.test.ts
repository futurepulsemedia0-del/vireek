import { describe, it, expect, beforeEach } from 'vitest';
import { SHORTCUTS_SCHEMA_VERSION, loadOverrides, saveOverrides, shortcutStore } from './store';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}
const KEY = (scope: string) => `vireek:shortcuts:v${SHORTCUTS_SCHEMA_VERSION}:${scope}`;

describe('shortcut persistence', () => {
  it('round-trips a versioned envelope per user', () => {
    const s = fakeStorage();
    saveOverrides('u1', { 'nav.jobs': 'g x' }, s);
    expect(JSON.parse(s.data.get(KEY('u1'))!)).toEqual({ v: SHORTCUTS_SCHEMA_VERSION, overrides: { 'nav.jobs': 'g x' } });
    expect(loadOverrides('u1', s)).toEqual({ 'nav.jobs': 'g x' });
    expect(loadOverrides('u2', s)).toEqual({}); // another user on the same browser sees nothing
  });

  it('removes the key when there are no overrides', () => {
    const s = fakeStorage({ [KEY('u1')]: '{}' });
    saveOverrides('u1', {}, s);
    expect(s.data.has(KEY('u1'))).toBe(false);
  });

  it('ignores corrupt JSON, wrong versions and hostile content', () => {
    expect(loadOverrides('u1', fakeStorage({ [KEY('u1')]: '{not json' }))).toEqual({});
    expect(loadOverrides('u1', fakeStorage({ [KEY('u1')]: JSON.stringify({ v: 999, overrides: { 'nav.jobs': 'g x' } }) }))).toEqual({});
    const hostile = JSON.stringify({ v: SHORTCUTS_SCHEMA_VERSION, overrides: { 'nav.jobs': 'g o', ghost: 'q', 'nav.calls': 'mod+t' } });
    expect(loadOverrides('u1', fakeStorage({ [KEY('u1')]: hostile }))).toEqual({});
  });

  it('survives a full or blocked storage', () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(() => saveOverrides('u1', { 'nav.jobs': 'g x' }, broken)).not.toThrow();
  });
});

describe('shortcutStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    shortcutStore.setScope('test-user');
    shortcutStore.resetAll();
  });

  it('validates before saving and notifies subscribers', () => {
    let notified = 0;
    const off = shortcutStore.subscribe(() => (notified += 1));
    expect(shortcutStore.setOverride('nav.jobs', 'g x').ok).toBe(true);
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBe('g x');
    expect(shortcutStore.setOverride('nav.team', 'g x').ok).toBe(false); // conflict with the one just saved
    expect(shortcutStore.getSnapshot()['nav.team']).toBeUndefined();
    expect(notified).toBeGreaterThan(0);
    off();
  });

  it('drops the override when it is set back to the default', () => {
    shortcutStore.setOverride('nav.jobs', 'g x');
    shortcutStore.setOverride('nav.jobs', 'g j');
    expect('nav.jobs' in shortcutStore.getSnapshot()).toBe(false);
  });

  it('turns a shortcut off and resets it', () => {
    shortcutStore.setOverride('nav.jobs', null);
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBeNull();
    shortcutStore.reset('nav.jobs');
    expect('nav.jobs' in shortcutStore.getSnapshot()).toBe(false);
  });

  it('keeps users separate when the scope changes', () => {
    shortcutStore.setOverride('nav.jobs', 'g x');
    shortcutStore.setScope('someone-else');
    expect(shortcutStore.getSnapshot()).toEqual({});
    shortcutStore.setScope('test-user');
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBe('g x');
  });
});
