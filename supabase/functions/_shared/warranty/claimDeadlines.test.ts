import { describe, it, expect } from 'vitest';
import { WARNING_WINDOW_DAYS, daysUntil, deadlineStage, pickAlertCandidates } from './claimDeadlines';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const D = (iso: string, stage: string | null = null) => ({ id: iso, claim_deadline: iso, deadline_alert_stage: stage });

describe('daysUntil', () => {
  it('rounds up partial days', () => {
    expect(daysUntil('2026-10-30T12:00:01Z', NOW)).toBe(2);
    expect(daysUntil('2026-10-30T12:00:00Z', NOW)).toBe(1);
    expect(daysUntil('2026-11-05T12:00:00Z', NOW)).toBe(7);
  });
  it('is negative once a full day has passed', () => {
    expect(daysUntil('2026-10-28T12:00:00Z', NOW)).toBe(-1);
    expect(daysUntil('2026-10-20T12:00:00Z', NOW)).toBe(-9);
  });
});

describe('deadlineStage', () => {
  it('is null beyond the warning window', () => {
    expect(deadlineStage(WARNING_WINDOW_DAYS + 1)).toBeNull();
    expect(deadlineStage(365)).toBeNull();
  });
  it('is due_soon from the window start through the deadline day', () => {
    expect(deadlineStage(WARNING_WINDOW_DAYS)).toBe('due_soon');
    expect(deadlineStage(1)).toBe('due_soon');
    expect(deadlineStage(0)).toBe('due_soon');
  });
  it('is overdue only when strictly past', () => {
    expect(deadlineStage(-1)).toBe('overdue');
    expect(deadlineStage(-400)).toBe('overdue');
  });
});

describe('pickAlertCandidates (each stage fires once per claim)', () => {
  it('flags due_soon and overdue claims with no previous alert', () => {
    const r = pickAlertCandidates([D('2026-11-02T00:00:00Z'), D('2026-10-20T00:00:00Z'), D('2027-01-01T00:00:00Z')], NOW);
    expect(r.map((x) => [x.c.id, x.stage])).toEqual([
      ['2026-11-02T00:00:00Z', 'due_soon'],
      ['2026-10-20T00:00:00Z', 'overdue'],
    ]);
  });
  it('does not alert due_soon twice', () => {
    expect(pickAlertCandidates([D('2026-11-02T00:00:00Z', 'due_soon')], NOW)).toEqual([]);
  });
  it('does not alert overdue twice', () => {
    expect(pickAlertCandidates([D('2026-10-20T00:00:00Z', 'overdue')], NOW)).toEqual([]);
  });
  it('a due_soon claim that later passes its deadline gets exactly one overdue alert', () => {
    const r = pickAlertCandidates([D('2026-10-20T00:00:00Z', 'due_soon')], NOW);
    expect(r).toHaveLength(1);
    expect(r[0].stage).toBe('overdue');
  });
  it('an extended deadline (stage reset by the DB trigger to null) can alert again', () => {
    expect(pickAlertCandidates([D('2026-11-02T00:00:00Z', null)], NOW)).toHaveLength(1);
  });
  it('running the same data twice after applying the stage is a no-op (idempotent)', () => {
    const claims = [D('2026-11-02T00:00:00Z'), D('2026-10-20T00:00:00Z')];
    const first = pickAlertCandidates(claims, NOW);
    const applied = claims.map((c) => ({ ...c, deadline_alert_stage: first.find((f) => f.c.id === c.id)?.stage ?? null }));
    expect(pickAlertCandidates(applied, NOW)).toEqual([]);
  });
});
