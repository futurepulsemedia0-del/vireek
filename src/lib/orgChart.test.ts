import { describe, expect, it } from 'vitest';
import {
  buildOrgTree,
  descendantIds,
  eligibleManagers,
  initials,
  managerChain,
  normalizeHistory,
  normalizeOverview,
  orgErrorMessage,
  positionChanged,
  searchOrg,
  summarizeOrg,
  tenureLabel,
  validatePositionForm,
  type OrgMember,
} from './orgChart';

let seq = 0;
const member = (name: string, reportsTo: string | null = null, extra: Partial<OrgMember> = {}): OrgMember => {
  seq += 1;
  return {
    id: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@example.com`,
    photo_url: null,
    access_role: 'member',
    title: null,
    reports_to_id: reportsTo,
    invite_status: 'active',
    is_me: false,
    since: `2027-0${(seq % 9) + 1}-01T00:00:00Z`,
    ...extra,
  };
};

// Owner
//  ├─ Ana ── Ben ── Cy
//  │          └─ Dee
//  └─ Eli
const TEAM = [member('Ana'), member('Ben', 'ana'), member('Cy', 'ben'), member('Dee', 'ben'), member('Eli')];

describe('buildOrgTree', () => {
  it('nests reports under their manager, sorted by name', () => {
    const { roots, maxDepth } = buildOrgTree(TEAM);
    expect(roots.map((r) => r.member.name)).toEqual(['Ana', 'Eli']);
    const ben = roots[0].children[0];
    expect(ben.member.name).toBe('Ben');
    expect(ben.children.map((c) => c.member.name)).toEqual(['Cy', 'Dee']);
    expect(maxDepth).toBe(2);
  });

  it('counts every report below a person, at any depth', () => {
    const { roots } = buildOrgTree(TEAM);
    expect(roots[0].reportCount).toBe(3);
    expect(roots[1].reportCount).toBe(0);
  });

  it('treats a missing manager as top level instead of dropping the person', () => {
    const { roots } = buildOrgTree([member('Zed', 'ghost'), member('Amy')]);
    expect(roots.map((r) => r.member.name)).toEqual(['Amy', 'Zed']);
  });

  it('survives a reporting loop in bad data without losing anyone', () => {
    const loop = [member('Ann', 'bob'), member('Bob', 'ann')];
    const { roots } = buildOrgTree(loop);
    const names: string[] = [];
    const walk = (nodes: typeof roots) => nodes.forEach((n) => { names.push(n.member.name); walk(n.children); });
    walk(roots);
    expect(names.sort()).toEqual(['Ann', 'Bob']);
  });

  it('handles an empty team', () => {
    expect(buildOrgTree([])).toEqual({ roots: [], maxDepth: 0 });
  });
});

describe('summarizeOrg', () => {
  it('counts headcount, pending invites, managers, levels and widest span', () => {
    const members = [...TEAM, member('Fay', 'eli', { invite_status: 'pending' })];
    const { roots, maxDepth } = buildOrgTree(members);
    expect(summarizeOrg(members, roots, maxDepth)).toEqual({
      headcount: 5,
      pending: 1,
      managers: 3, // Ana, Ben, Eli
      levels: 4, // owner + Ana + Ben + Cy/Dee
      widestSpan: 2,
    });
  });

  it('is sane for an owner with no team', () => {
    expect(summarizeOrg([], [], 0)).toEqual({ headcount: 0, pending: 0, managers: 0, levels: 1, widestSpan: 0 });
  });
});

describe('manager choices', () => {
  it('lists every descendant', () => {
    expect([...descendantIds(TEAM, 'ana')].sort()).toEqual(['ben', 'cy', 'dee']);
  });

  it('never offers yourself or your own reports as a manager (no loops)', () => {
    expect(eligibleManagers(TEAM, 'ben').map((m) => m.name)).toEqual(['Ana', 'Eli']);
    expect(eligibleManagers(TEAM, 'cy').map((m) => m.name)).toEqual(['Ana', 'Ben', 'Dee', 'Eli']);
  });

  it('returns the manager chain nearest first', () => {
    expect(managerChain(TEAM, 'cy').map((m) => m.name)).toEqual(['Ben', 'Ana']);
    expect(managerChain(TEAM, 'ana')).toEqual([]);
  });

  it('stops safely when the chain loops', () => {
    expect(managerChain([member('Ann', 'bob'), member('Bob', 'ann')], 'ann').map((m) => m.name)).toEqual(['Bob']);
  });
});

describe('searchOrg', () => {
  const people = [member('Ana', null, { title: 'Operations Manager' }), member('Ben', 'ana', { title: 'Lead Technician' }), member('Cy', 'ben')];

  it('matches name, title and email, case-insensitively', () => {
    expect([...searchOrg(people, 'LEAD').matches]).toEqual(['ben']);
    expect([...searchOrg(people, 'cy@example').matches]).toEqual(['cy']);
  });

  it('keeps the managers above a match visible', () => {
    expect([...searchOrg(people, 'cy').visible].sort()).toEqual(['ana', 'ben', 'cy']);
  });

  it('matches everyone for an empty query and no one for a miss', () => {
    expect(searchOrg(people, '  ').matches.size).toBe(3);
    expect(searchOrg(people, 'zzz').visible.size).toBe(0);
  });
});

describe('position form', () => {
  const ben = member('Ben', 'ana', { title: 'Lead' });

  it('flags an over-long title and note', () => {
    expect(validatePositionForm({ title: 'x'.repeat(81), reportsTo: '', note: 'y'.repeat(281) })).toEqual({
      title: 'Keep the title to 80 characters or fewer.',
      note: 'Keep the note to 280 characters or fewer.',
    });
    expect(validatePositionForm({ title: 'x'.repeat(80), reportsTo: '', note: '' })).toEqual({});
  });

  it('detects a real change and ignores whitespace-only edits', () => {
    expect(positionChanged(ben, { title: ' Lead ', reportsTo: 'ana', note: '' })).toBe(false);
    expect(positionChanged(ben, { title: 'Lead', reportsTo: '', note: '' })).toBe(true);
    expect(positionChanged(ben, { title: 'Senior Lead', reportsTo: 'ana', note: '' })).toBe(true);
  });
});

describe('display helpers', () => {
  it('builds initials', () => {
    expect(initials('Ana Maria Lopez')).toBe('AL');
    expect(initials('  cher ')).toBe('C');
    expect(initials('')).toBe('?');
  });

  it('formats tenure', () => {
    const now = Date.parse('2028-03-20T12:00:00Z');
    expect(tenureLabel('2028-03-01T00:00:00Z', now)).toBe('Less than a month');
    expect(tenureLabel('2027-10-01T00:00:00Z', now)).toBe('5 mos');
    expect(tenureLabel('2026-01-05T00:00:00Z', now)).toBe('2 yrs 2 mos');
    expect(tenureLabel('2027-03-10T00:00:00Z', now)).toBe('1 yr');
    expect(tenureLabel(null, now)).toBe('');
    expect(tenureLabel('not a date', now)).toBe('');
  });

  it('maps database errors to friendly messages', () => {
    expect(orgErrorMessage({ code: '42501', message: 'Not authorised' })).toBe("You don't have permission to do that.");
    expect(orgErrorMessage({ code: 'P0001', message: 'The manager must be on the same team' })).toBe('The manager must be on the same team');
    expect(orgErrorMessage({ message: 'Failed to fetch' })).toBe("You're offline — check your connection and try again.");
    expect(orgErrorMessage({ code: 'XX000', message: 'boom' }, 'Fallback')).toBe('Fallback');
    expect(orgErrorMessage(null, 'Fallback')).toBe('Fallback');
  });
});

describe('normalizers', () => {
  it('survives junk and duplicates', () => {
    const o = normalizeOverview({
      can_manage: true,
      owner: { name: ' ', company: 'Acme HVAC' },
      members: [{ id: 'a', name: 'Ana', access_role: 'boss' }, { id: 'a', name: 'Dup' }, null, { name: 'no id' }],
    });
    expect(o.can_manage).toBe(true);
    expect(o.owner).toEqual({ name: 'Account owner', company: 'Acme HVAC' });
    expect(o.members).toHaveLength(1);
    expect(o.members[0].access_role).toBe('member');
    expect(normalizeOverview(null).members).toEqual([]);
  });

  it('drops history rows without an id or start date', () => {
    const h = normalizeHistory([{ id: 'h1', started_at: '2027-01-01T00:00:00Z', access_role: 'admin' }, { id: 'h2' }, 'x']);
    expect(h).toHaveLength(1);
    expect(h[0].access_role).toBe('admin');
    expect(normalizeHistory(undefined)).toEqual([]);
  });
});
