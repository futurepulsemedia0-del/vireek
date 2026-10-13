import { describe, it, expect } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  MAX_RECENTS,
  PAGES,
  QUICK_ACTIONS,
  groupResults,
  highlightSegments,
  hrefForRow,
  loadRecents,
  normalizeQuery,
  pushRecent,
  rankCommands,
  rowToResult,
  scoreCommand,
  type GlobalSearchResult,
  type GlobalSearchRow,
} from './globalSearch';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

const result = (key: string, type: GlobalSearchResult['type'], score: number): GlobalSearchResult => ({
  key,
  type,
  id: key.split(':')[1] ?? key,
  title: key,
  subtitle: '',
  status: null,
  href: '/x',
  score,
});

describe('normalizeQuery', () => {
  it('trims, collapses whitespace and caps length', () => {
    expect(normalizeQuery('  john   smith \n')).toBe('john smith');
    expect(normalizeQuery('a'.repeat(500))).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe('hrefForRow', () => {
  const base = { entity_id: 'abc 1', parent_id: null as string | null };
  it('routes every entity type to a real dashboard page', () => {
    expect(hrefForRow({ ...base, entity_type: 'customer' })).toBe('/dashboard/customers/abc%201');
    expect(hrefForRow({ ...base, entity_type: 'job' })).toBe('/dashboard/jobs?job=abc%201');
    expect(hrefForRow({ ...base, entity_type: 'quote' })).toBe('/dashboard/quotes');
    expect(hrefForRow({ ...base, entity_type: 'invoice' })).toBe('/dashboard/invoicing');
    expect(hrefForRow({ ...base, entity_type: 'team' })).toBe('/dashboard/team');
    expect(hrefForRow({ ...base, entity_type: 'knowledge' })).toBe('/dashboard/knowledge?article=abc%201');
    expect(hrefForRow({ ...base, entity_type: 'lead' })).toBe('/dashboard/leads');
    expect(hrefForRow({ ...base, entity_type: 'call' })).toBe('/dashboard/calls');
  });
  it('sends equipment to its customer, with a safe fallback', () => {
    expect(hrefForRow({ ...base, entity_type: 'equipment', parent_id: 'cust-9' })).toBe('/dashboard/customers/cust-9');
    expect(hrefForRow({ ...base, entity_type: 'equipment' })).toBe('/dashboard/customers');
  });
});

describe('rowToResult', () => {
  it('maps an RPC row and tolerates null subtitle', () => {
    const row: GlobalSearchRow = {
      entity_type: 'customer',
      entity_id: 'c1',
      title: 'Acme',
      subtitle: null,
      parent_id: null,
      status: 'vip',
      score: 1.1,
      created_at: null,
    };
    expect(rowToResult(row)).toMatchObject({ key: 'customer:c1', subtitle: '', href: '/dashboard/customers/c1', status: 'vip' });
  });
});

describe('groupResults', () => {
  it('orders groups by best score, items by score, and drops duplicates', () => {
    const groups = groupResults([
      result('job:1', 'job', 0.4),
      result('customer:1', 'customer', 0.6),
      result('invoice:1', 'invoice', 1.2),
      result('customer:2', 'customer', 0.9),
      result('customer:2', 'customer', 0.9),
    ]);
    expect(groups.map((g) => g.type)).toEqual(['invoice', 'customer', 'job']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['customer:2', 'customer:1']);
  });
  it('returns an empty list for no results', () => {
    expect(groupResults([])).toEqual([]);
  });
});

describe('scoreCommand / rankCommands', () => {
  it('ranks exact > prefix > word-prefix > substring > keyword > none', () => {
    const c = (label: string, keywords?: string) => ({ label, keywords });
    expect(scoreCommand('jobs', c('Jobs'))).toBeGreaterThan(scoreCommand('jo', c('Jobs')));
    expect(scoreCommand('jo', c('Jobs'))).toBeGreaterThan(scoreCommand('jo', c('My Jobs')));
    expect(scoreCommand('jo', c('My Jobs'))).toBeGreaterThan(scoreCommand('ob', c('My Jobs')));
    expect(scoreCommand('ob', c('My Jobs'))).toBeGreaterThan(scoreCommand('dispatch', c('My Jobs', 'work orders dispatch')));
    expect(scoreCommand('zzz', c('My Jobs'))).toBe(0);
  });

  it('hides permission-gated pages unless granted', () => {
    expect(rankCommands('billing', PAGES, {})).toHaveLength(0);
    expect(rankCommands('billing', PAGES, { can_view_billing: true })[0]?.id).toBe('page:billing');
    expect(rankCommands('invoic', PAGES, { can_view_billing: false })).toHaveLength(0);
  });

  it('finds quick actions by label and by keyword', () => {
    expect(rankCommands('new job', QUICK_ACTIONS, {})[0]?.id).toBe('action:new-job');
    expect(rankCommands('estimate', QUICK_ACTIONS, {})[0]?.id).toBe('action:new-quote');
  });

  it('respects the limit and keeps declaration order for ties', () => {
    const all = rankCommands('', PAGES, { can_view_billing: true, can_manage_team: true, can_edit_business_profile: true }, 3);
    expect(all.map((p) => p.id)).toEqual(PAGES.slice(0, 3).map((p) => p.id));
  });

  it('every command has a unique id and an in-app href', () => {
    const ids = [...PAGES, ...QUICK_ACTIONS].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of [...PAGES, ...QUICK_ACTIONS]) expect(c.href.startsWith('/dashboard')).toBe(true);
  });
});

describe('recent items', () => {
  const item = (n: number) => ({ key: `k${n}`, kind: 'command' as const, label: `L${n}`, sublabel: '', href: '/dashboard' });

  it('keeps most-recent-first, de-duplicates and caps the list', () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_RECENTS + 4; i += 1) pushRecent('u1', item(i), storage);
    pushRecent('u1', item(7), storage);
    const list = loadRecents('u1', storage);
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].key).toBe('k7');
    expect(new Set(list.map((r) => r.key)).size).toBe(list.length);
  });

  it('is scoped per user', () => {
    const storage = memoryStorage();
    pushRecent('u1', item(1), storage);
    expect(loadRecents('u2', storage)).toEqual([]);
  });

  it('survives corrupt or hostile storage and a missing user', () => {
    expect(loadRecents('u1', memoryStorage({ 'vireek:cmdk:recent:u1': '{not json' }))).toEqual([]);
    expect(loadRecents('u1', memoryStorage({ 'vireek:cmdk:recent:u1': '{"a":1}' }))).toEqual([]);
    expect(loadRecents('u1', memoryStorage({ 'vireek:cmdk:recent:u1': '[{"key":1},null,{"key":"ok","href":"/x","label":"L"}]' }))).toHaveLength(1);
    expect(loadRecents(undefined, memoryStorage())).toEqual([]);
    expect(pushRecent(undefined, item(1), memoryStorage())).toEqual([]);
  });

  it('does not throw when storage is full', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => pushRecent('u1', item(1), storage)).not.toThrow();
  });
});

describe('highlightSegments', () => {
  it('marks every case-insensitive occurrence and preserves the original text', () => {
    const segs = highlightSegments('John Johnson', 'joh');
    expect(segs.map((s) => s.text).join('')).toBe('John Johnson');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['Joh', 'Joh']);
  });
  it('treats regex characters literally and handles empty input', () => {
    expect(highlightSegments('a.b (x)', '.')).toEqual([
      { text: 'a', match: false },
      { text: '.', match: true },
      { text: 'b (x)', match: false },
    ]);
    expect(highlightSegments('abc', '')).toEqual([{ text: 'abc', match: false }]);
    expect(highlightSegments('', 'a')).toEqual([{ text: '', match: false }]);
  });
});
