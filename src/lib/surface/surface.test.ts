import { describe, expect, it } from 'vitest';
import {
  audienceFor,
  groupByPillar,
  isLab,
  normalizePath,
  pillarFor,
  plainLabel,
  searchTerms,
  visibleToAudience,
} from './surface';

describe('surface taxonomy', () => {
  it('normalizes case, query, hash and trailing slash', () => {
    expect(normalizePath('/Dashboard/Calls/?a=1#x')).toBe('/dashboard/calls');
  });

  it('classifies core pages into the three pillars', () => {
    expect(pillarFor('/dashboard/calls')).toBe('answer');
    expect(pillarFor('/dashboard/dispatch')).toBe('dispatch');
    expect(pillarFor('/dashboard/invoicing')).toBe('grow');
    expect(pillarFor('/dashboard/billing/plans')).toBe('settings');
  });

  it('puts experimental pages in labs, including sub-paths', () => {
    expect(isLab('/dashboard/event-prediction-mesh')).toBe(true);
    expect(isLab('/dashboard/entropy/history')).toBe(true);
    expect(isLab('/dashboard/calls')).toBe(false);
  });

  it('returns null for unknown paths so callers choose a default', () => {
    expect(pillarFor('/dashboard/does-not-exist')).toBeNull();
  });
});

describe('plain names', () => {
  it('renames by href and keeps the old name searchable', () => {
    expect(plainLabel('/dashboard/immune-system', 'Business Immune System')).toBe('Health Check');
    expect(searchTerms('/dashboard/immune-system')).toContain('business immune system');
    expect(searchTerms('/dashboard/negative-knowledge')).toContain('things not to say');
  });

  it('falls back to the original label when no rename exists', () => {
    expect(plainLabel('/dashboard/customers', 'Customers')).toBe('Customers');
    expect(searchTerms('/dashboard/customers')).toBe('');
  });
});

describe('audience and grouping', () => {
  it('derives audience from existing auth facts', () => {
    expect(audienceFor(true, false)).toBe('owner');
    expect(audienceFor(false, true)).toBe('dispatcher');
    expect(audienceFor(false, false)).toBe('technician');
  });

  it('technicians only see their own world', () => {
    expect(visibleToAudience('/tech/today', 'technician')).toBe(true);
    expect(visibleToAudience('/dashboard/jobs', 'technician')).toBe(true);
    expect(visibleToAudience('/dashboard/billing', 'technician')).toBe(false);
    expect(visibleToAudience('/dashboard/payroll', 'technician')).toBe(false);
    expect(visibleToAudience('/dashboard/billing', 'owner')).toBe(true);
  });

  const items = [
    { href: '/dashboard/calls', label: 'Call History' },
    { href: '/dashboard/calls', label: 'Call History (dup)' },
    { href: '/dashboard/dispatch', label: 'Dispatch Board' },
    { href: '/dashboard/entropy', label: 'Operational Entropy' },
    { href: '/dashboard/billing', label: 'Billing' },
  ];

  it('hides labs by default, de-dupes by href and drops empty groups', () => {
    const g = groupByPillar(items, { audience: 'owner', showLabs: false });
    expect(g.map((x) => x.pillar)).toEqual(['answer', 'dispatch', 'settings']);
    expect(g[0].items).toHaveLength(1);
  });

  it('shows labs only when opted in', () => {
    const g = groupByPillar(items, { audience: 'owner', showLabs: true });
    expect(g.map((x) => x.pillar)).toContain('labs');
  });

  it('never leaks manager pages to technicians', () => {
    const g = groupByPillar(items, { audience: 'technician', showLabs: true });
    expect(g.flatMap((x) => x.items.map((i) => i.href))).toEqual([]);
  });
});
