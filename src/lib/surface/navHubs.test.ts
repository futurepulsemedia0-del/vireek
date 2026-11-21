import { describe, expect, it } from 'vitest';
import { ACCOUNT_ITEMS, PRIMARY_ITEMS } from '@/components/DashboardNav';
import { HUBS, groupByHub } from './navHubs';
import { PILLARS, audienceFor, groupByPillar } from './surface';

const all = [...PRIMARY_ITEMS, ...ACCOUNT_ITEMS];
const pillarGroups = groupByPillar(all, { audience: audienceFor(true, true), showLabs: true });

describe('nav hubs', () => {
  it('has unique hub ids and only known pillars', () => {
    const ids = HUBS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HUBS) expect(PILLARS.some((p) => p.id === h.pillar)).toBe(true);
  });

  it('never drops or duplicates a route when splitting a pillar into hubs', () => {
    for (const { pillar, items } of pillarGroups) {
      const grouped = groupByHub(pillar, items).flatMap((g) => g.items);
      expect(grouped).toHaveLength(items.length);
      expect(new Set(grouped.map((i) => i.href)).size).toBe(new Set(items.map((i) => i.href)).size);
    }
  });
  it('leaves no menu page in the catch-all "More" hub', () => {
    for (const { pillar, items } of pillarGroups) {
      const more = groupByHub(pillar, items).find((g) => g.hub.id === `${pillar}-more`);
      expect(more?.items.map((i) => i.label) ?? []).toEqual([]);
    }
  });
  it('keeps every pillar to a handful of hubs', () => {
    for (const { pillar, items } of pillarGroups) {
      expect(groupByHub(pillar, items).length).toBeLessThanOrEqual(9);
    }
  });
});
