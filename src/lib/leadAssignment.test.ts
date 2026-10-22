import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  DEFAULT_SETTINGS,
  EMPTY_RULE,
  describeRule,
  diffPool,
  eventLabel,
  formatMinutes,
  methodLabel,
  moveInList,
  parseList,
  priorityPlan,
  rangeForDays,
  resolveOwnerId,
  ruleWarnings,
  summarizeReport,
  validateRule,
  validateSettings,
  type AgentReportRow,
  type AssignmentAgent,
  type RuleDraft,
} from '@/lib/leadAssignment';

const agent = (over: Partial<AssignmentAgent> = {}): AssignmentAgent => ({
  team_member_id: 'a1',
  name: 'Ann',
  email: 'ann@x.test',
  role: 'member',
  languages: [],
  enrolled: true,
  accepts_leads: true,
  max_open_leads: 25,
  ...over,
});

const row = (over: Partial<AgentReportRow> = {}): AgentReportRow => ({
  member_id: 'a1',
  member_name: 'Ann',
  leads_assigned: 10,
  leads_touched: 9,
  leads_won: 3,
  conversion_rate: 30,
  avg_first_touch_minutes: 4,
  sla_breaches: 1,
  reassigned_away: 0,
  open_leads: 2,
  won_value: 1000,
  ...over,
});

describe('parseList', () => {
  it('splits on commas, semicolons and newlines, trims and de-duplicates case-insensitively', () => {
    expect(parseList('HVAC, plumbing;  hvac\n\n Electrical ')).toEqual(['HVAC', 'plumbing', 'Electrical']);
  });
  it('returns an empty list for blank input', () => {
    expect(parseList('  , ;\n')).toEqual([]);
  });
  it('caps the length of every item', () => {
    expect(parseList('x'.repeat(200))[0]).toHaveLength(80);
  });
});

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it('rejects a reassign window shorter than the SLA', () => {
    const errors = validateSettings({ ...DEFAULT_SETTINGS, first_touch_sla_minutes: 10, reassign_after_minutes: 5 });
    expect(errors.join(' ')).toMatch(/cannot be shorter/);
  });
  it('rejects out-of-range and fractional values', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, first_touch_sla_minutes: 0 }).length).toBeGreaterThan(0);
    expect(validateSettings({ ...DEFAULT_SETTINGS, max_reassignments: 11 }).length).toBeGreaterThan(0);
    expect(validateSettings({ ...DEFAULT_SETTINGS, reassign_after_minutes: 15.5 }).length).toBeGreaterThan(0);
  });
  it('allows zero reassignments (escalate straight away)', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, max_reassignments: 0 })).toEqual([]);
  });
});

describe('validateRule', () => {
  const ok: RuleDraft = { ...EMPTY_RULE, name: 'Spanish desk' };
  it('accepts a named rule', () => {
    expect(validateRule(ok)).toEqual([]);
  });
  it('requires a name and a sane priority', () => {
    expect(validateRule({ ...ok, name: '   ' })[0]).toMatch(/name/);
    expect(validateRule({ ...ok, priority: 0 }).length).toBe(1);
    expect(validateRule({ ...ok, priority: 10001 }).length).toBe(1);
  });
  it('enforces list size limits', () => {
    expect(validateRule({ ...ok, languages: Array.from({ length: 21 }, (_, i) => `l${i}`) }).length).toBe(1);
  });
});

describe('ruleWarnings', () => {
  it('warns when a rule has no criteria', () => {
    expect(ruleWarnings({ ...EMPTY_RULE, name: 'x' }, [agent()]).join(' ')).toMatch(/no criteria/);
  });
  it('warns when nobody in the pool speaks the language', () => {
    const draft: RuleDraft = { ...EMPTY_RULE, name: 'x', languages: ['Spanish'], agent_ids: ['a1'] };
    expect(ruleWarnings(draft, [agent()]).join(' ')).toMatch(/speaks/);
  });
  it('stays quiet when the pool covers the language (case-insensitive)', () => {
    const draft: RuleDraft = { ...EMPTY_RULE, name: 'x', languages: ['spanish'], agent_ids: ['a1'] };
    expect(ruleWarnings(draft, [agent({ languages: ['Spanish'] })])).toEqual([]);
  });
  it('warns about pool members that are not enrolled', () => {
    const draft: RuleDraft = { ...EMPTY_RULE, name: 'x', services: ['hvac'], agent_ids: ['a1'] };
    expect(ruleWarnings(draft, [agent({ enrolled: false })]).join(' ')).toMatch(/not enrolled/);
  });
});

describe('describeRule', () => {
  it('describes a catch-all rule', () => {
    expect(describeRule(EMPTY_RULE)).toBe('All leads');
  });
  it('combines criteria and resolves zone names', () => {
    const text = describeRule(
      { ...EMPTY_RULE, services: ['HVAC'], languages: ['Spanish'], service_area_ids: ['z1'], postal_codes: ['90210'] },
      { z1: 'West side' },
    );
    expect(text).toBe('service: HVAC · area: West side, 90210 · language: Spanish');
  });
  it('abbreviates long ZIP lists', () => {
    const text = describeRule({ ...EMPTY_RULE, postal_codes: ['1', '2', '3', '4', '5', '6', '7', '8'] });
    expect(text).toContain('+2');
  });
});

describe('pool and ordering helpers', () => {
  it('diffPool keeps unchanged agents out of both lists', () => {
    expect(diffPool(['a', 'b'], ['b', 'c'])).toEqual({ add: ['c'], remove: ['a'] });
    expect(diffPool([], [])).toEqual({ add: [], remove: [] });
  });
  it('priorityPlan renumbers in steps of 10', () => {
    expect(priorityPlan(['x', 'y', 'z'])).toEqual([
      { id: 'x', priority: 10 },
      { id: 'y', priority: 20 },
      { id: 'z', priority: 30 },
    ]);
  });
  it('moveInList moves without mutating and ignores bad indexes', () => {
    const list = ['a', 'b', 'c'];
    expect(moveInList(list, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(list).toEqual(['a', 'b', 'c']);
    expect(moveInList(list, 0, 5)).toEqual(['a', 'b', 'c']);
    expect(moveInList(list, -1, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('formatMinutes', () => {
  it('formats null, sub-minute, minutes and hours', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(0.4)).toBe('<1m');
    expect(formatMinutes(12.4)).toBe('12m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(125)).toBe('2h 5m');
  });
});

describe('summarizeReport', () => {
  it('totals real agents only and computes the blended conversion rate', () => {
    const totals = summarizeReport([
      row(),
      row({ member_id: 'a2', member_name: 'Bob', leads_assigned: 10, leads_won: 1, conversion_rate: 10, sla_breaches: 2, won_value: 200 }),
      row({ member_id: null, member_name: 'Unassigned', leads_assigned: 99, leads_won: 99 }),
    ]);
    expect(totals.assigned).toBe(20);
    expect(totals.won).toBe(4);
    expect(totals.conversionRate).toBe(20);
    expect(totals.slaBreaches).toBe(3);
    expect(totals.wonValue).toBe(1200);
  });
  it('picks the top agent only among agents with enough leads', () => {
    const totals = summarizeReport([
      row({ member_name: 'Small', leads_assigned: 2, conversion_rate: 100 }),
      row({ member_id: 'a2', member_name: 'Solid', leads_assigned: 20, conversion_rate: 40 }),
    ]);
    expect(totals.topAgent).toBe('Solid');
  });
  it('handles an empty report', () => {
    expect(summarizeReport([])).toMatchObject({ assigned: 0, conversionRate: 0, topAgent: null });
  });
});

describe('labels, ranges and owner resolution', () => {
  it('labels methods and events with a safe fallback', () => {
    expect(methodLabel('rule_round_robin')).toBe('Rule · round robin');
    expect(methodLabel(null)).toBe('—');
    expect(methodLabel('something_new')).toBe('something_new');
    expect(eventLabel('sla_breach')).toBe('SLA breached');
    expect(eventLabel('other')).toBe('other');
  });
  it('rangeForDays spans exactly N days ending now', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const { from, to } = rangeForDays(7, now);
    expect(to).toBe('2026-10-22T12:00:00.000Z');
    expect(from).toBe('2026-10-15T12:00:00.000Z');
  });
  it('resolveOwnerId prefers the team member account owner', () => {
    expect(resolveOwnerId({ id: 'u1' }, { account_owner_id: 'o1' })).toBe('o1');
    expect(resolveOwnerId({ id: 'u1' }, null)).toBe('u1');
    expect(resolveOwnerId(null, null)).toBeNull();
  });
});
