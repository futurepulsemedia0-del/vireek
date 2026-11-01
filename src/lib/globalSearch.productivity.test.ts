import { describe, it, expect } from 'vitest';
import {
  PAGES,
  QUICK_ACTIONS,
  SCOPE_TYPES,
  createSearchCache,
  parseScopedQuery,
  rankCommands,
  scoreCommand,
  withinOneEdit,
} from './globalSearch';
import { SHORTCUT_DEFS } from './shortcuts/definitions';

const c = (label: string, keywords?: string) => ({ label, keywords });

describe('palette relevance: fuzzy tiers', () => {
  it('keeps the legacy order and ranks fuzzy tiers below keywords', () => {
    expect(scoreCommand('jobs', c('Jobs'))).toBeGreaterThan(scoreCommand('jo', c('Jobs')));
    expect(scoreCommand('ob', c('My Jobs'))).toBeGreaterThan(scoreCommand('dispatch', c('My Jobs', 'work orders dispatch')));
    expect(scoreCommand('dispatch', c('My Jobs', 'work orders dispatch'))).toBeGreaterThan(scoreCommand('custmer', c('Customers')));
    expect(scoreCommand('zzz', c('My Jobs'))).toBe(0);
  });

  it('tolerates a typo and finds initials/subsequences', () => {
    expect(scoreCommand('custmer', c('Customers'))).toBeGreaterThan(0);
    expect(scoreCommand('bprf', c('Business Profile'))).toBeGreaterThan(0);
  });

  it('matches multi-word queries against label + keywords', () => {
    expect(scoreCommand('create quote', c('New quote', 'create add estimate proposal'))).toBeGreaterThan(0);
    expect(scoreCommand('new quote', c('New job', 'create add schedule'))).toBe(0);
  });

  it('finds Customers from a typo and gates "Invite teammate" on permission', () => {
    expect(rankCommands('custmers', PAGES, {})[0]?.id).toBe('page:customers');
    expect(rankCommands('invite', QUICK_ACTIONS, {})).toHaveLength(0);
    expect(rankCommands('invite', QUICK_ACTIONS, { can_manage_team: true })[0]?.id).toBe('action:invite-teammate');
  });

  it('withinOneEdit covers substitution, swap, insert and delete', () => {
    expect(withinOneEdit('abc', 'abd')).toBe(true);
    expect(withinOneEdit('abc', 'acb')).toBe(true);
    expect(withinOneEdit('abc', 'ab')).toBe(true);
    expect(withinOneEdit('abc', 'xbd')).toBe(false);
    expect(withinOneEdit('abc', 'a')).toBe(false);
  });
});

describe('scoped prefixes', () => {
  it('parses > @ # and leaves everything else alone', () => {
    expect(parseScopedQuery('> new job')).toEqual({ scope: 'actions', term: 'new job' });
    expect(parseScopedQuery('  @sam')).toEqual({ scope: 'people', term: 'sam' });
    expect(parseScopedQuery('#1042')).toEqual({ scope: 'jobs', term: '1042' });
    expect(parseScopedQuery('smith')).toEqual({ scope: 'all', term: 'smith' });
    expect(parseScopedQuery('a>b')).toEqual({ scope: 'all', term: 'a>b' });
  });

  it('maps scopes to server entity types ([] = no record search)', () => {
    expect(SCOPE_TYPES.all).toBeNull();
    expect(SCOPE_TYPES.actions).toEqual([]);
    expect(SCOPE_TYPES.people).toEqual(['team', 'customer', 'lead']);
    expect(SCOPE_TYPES.jobs).toEqual(['job']);
  });
});

describe('search cache', () => {
  it('expires entries, evicts least-recently-used, and clears', () => {
    let now = 0;
    const cache = createSearchCache<number>({ ttlMs: 100, max: 2, now: () => now });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    now = 101;
    expect(cache.get('a')).toBeUndefined();
    cache.set('z', 9);
    cache.clear();
    expect(cache.get('z')).toBeUndefined();
  });
});

describe('palette <-> shortcut registry stay in sync', () => {
  it('every palette command with a shortcutId points at the same href/state as the registry', () => {
    const byId = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));
    for (const cmd of [...PAGES, ...QUICK_ACTIONS].filter((x) => x.shortcutId)) {
      const def = byId.get(cmd.shortcutId!);
      expect(def, cmd.id).toBeTruthy();
      expect(cmd.href, cmd.id).toBe(def!.href);
      expect(cmd.state, cmd.id).toEqual(def!.state);
    }
  });

  it('every navigation/create shortcut is reachable from the palette', () => {
    const linked = new Set([...PAGES, ...QUICK_ACTIONS].map((x) => x.shortcutId));
    for (const d of SHORTCUT_DEFS.filter((x) => x.href)) expect(linked.has(d.id), d.id).toBe(true);
  });

  it('palette command ids stay unique', () => {
    const ids = [...PAGES, ...QUICK_ACTIONS].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
