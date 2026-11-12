import { describe, expect, it } from 'vitest';
import { CS_TASK_MAX_BATCH, buildCsTaskCandidates, dueLabel, parseCsTasks } from './csTasks';
import type { StaffSuccessRow } from './successTools';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Level = 'high' | 'medium' | 'low' | 'new' | 'churned';

function row(n: number, level: Level, score: number | null, over: Partial<{ label: string; id: string; reasons: string[]; action: string }> = {}): StaffSuccessRow {
  return {
    id: over.id ?? uuid(n),
    label: over.label ?? `Acme ${n}`,
    risk: { level, score, reasons: (over.reasons ?? ['Recent activity: no calls']).map((text) => ({ severity: 'high' as const, text })), action: over.action ?? 'Call them.' },
  } as unknown as StaffSuccessRow;
}

describe('buildCsTaskCandidates', () => {
  it('keeps only high and medium accounts', () => {
    const out = buildCsTaskCandidates([row(1, 'high', 20), row(2, 'medium', 50), row(3, 'low', 90), row(4, 'new', null), row(5, 'churned', 0)]);
    expect(out.map((c) => c.account_id)).toEqual([uuid(1), uuid(2)]);
  });

  it('orders high before medium, then lowest score, then label', () => {
    const out = buildCsTaskCandidates([row(1, 'medium', 30), row(2, 'high', 35), row(3, 'high', 10), row(4, 'high', 10, { label: 'Aardvark' })]);
    expect(out.map((c) => c.account_id)).toEqual([uuid(4), uuid(3), uuid(2), uuid(1)]);
  });

  it('drops rows whose id is not a uuid', () => {
    expect(buildCsTaskCandidates([row(1, 'high', 10, { id: 'not-a-uuid' }), row(2, 'high', 10)]).length).toBe(1);
  });

  it('caps the batch at the server limit', () => {
    const many = Array.from({ length: CS_TASK_MAX_BATCH + 25 }, (_, i) => row(i + 1, 'medium', 50));
    expect(buildCsTaskCandidates(many).length).toBe(CS_TASK_MAX_BATCH);
  });

  it('clamps score, keeps null, trims reasons to 3 and bounds text lengths', () => {
    const long = 'x'.repeat(500);
    const [c] = buildCsTaskCandidates([row(1, 'high', 140, { reasons: [long, 'b', 'c', 'd'], action: long, label: long })]);
    expect(c.risk_score).toBe(100);
    expect(c.reasons.length).toBe(3);
    expect(c.reasons[0].length).toBeLessThanOrEqual(300);
    expect(c.suggested_action.length).toBeLessThanOrEqual(300);
    expect(c.title.length).toBeLessThanOrEqual(200);
    expect(buildCsTaskCandidates([row(2, 'high', null)])[0].risk_score).toBe(null);
  });

  it('does not mutate the input array', () => {
    const rows = [row(1, 'medium', 50), row(2, 'high', 10)];
    buildCsTaskCandidates(rows);
    expect(rows[0].id).toBe(uuid(1));
  });
});

describe('parseCsTasks', () => {
  const good = { id: 'a', account_id: 'b', risk_level: 'high', risk_score: 12, title: 'T', reasons: ['r', 5], suggested_action: 'Do', status: 'open', due_at: '2026-11-20T00:00:00Z', assigned: true, mine: false };
  it('parses valid rows and ignores malformed ones', () => {
    const out = parseCsTasks({ tasks: [good, { ...good, status: 'done' }, { ...good, risk_level: 'low' }, null, 'x'] });
    expect(out.length).toBe(1);
    expect(out[0].reasons).toEqual(['r']);
    expect(out[0].assigned).toBe(true);
  });
  it('returns an empty list for anything unexpected', () => {
    expect(parseCsTasks(null)).toEqual([]);
    expect(parseCsTasks({ tasks: 'x' })).toEqual([]);
  });
});

describe('dueLabel', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  it('reports overdue, today and future', () => {
    expect(dueLabel('2026-11-10T00:00:00Z', now)).toEqual({ text: 'Overdue by 2d', overdue: true });
    expect(dueLabel('2026-11-12T18:00:00Z', now)).toEqual({ text: 'Due today', overdue: false });
    expect(dueLabel('2026-11-15T12:00:00Z', now)).toEqual({ text: 'Due in 3d', overdue: false });
  });
  it('handles an invalid date', () => {
    expect(dueLabel('nope', now).overdue).toBe(false);
  });
});
