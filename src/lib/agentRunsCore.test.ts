import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  approvalState,
  formatRemaining,
  runBudgetSummary,
  stepStatusLabel,
  summarizeToolInput,
} from './agentRunsCore';

const T0 = Date.parse('2026-11-08T10:00:00Z');

describe('approvalState (mirrors the 24h server rule)', () => {
  it('is valid right after being requested and shows time left', () => {
    const s = approvalState('2026-11-08T09:00:00Z', T0);
    expect(s.expired).toBe(false);
    expect(s.label).toBe('23h 0m left');
  });
  it('expires exactly at the TTL and is never negative', () => {
    expect(approvalState(new Date(T0 - APPROVAL_TTL_MS).toISOString(), T0)).toMatchObject({ expired: true, msLeft: 0, label: 'Expired' });
    expect(approvalState(new Date(T0 - APPROVAL_TTL_MS - 5_000).toISOString(), T0).msLeft).toBe(0);
    expect(approvalState(new Date(T0 - APPROVAL_TTL_MS + 1_000).toISOString(), T0).expired).toBe(false);
  });
  it('treats an unparsable timestamp as expired (fail closed)', () => {
    expect(approvalState('not-a-date', T0).expired).toBe(true);
  });
  it('formats minutes-only remainders', () => {
    expect(formatRemaining(14 * 60_000)).toBe('14m left');
    expect(formatRemaining(0)).toBe('Expired');
  });
});

describe('view helpers', () => {
  it('labels every ledger status in plain language and passes unknown ones through', () => {
    for (const s of ['in_flight', 'succeeded', 'failed_retryable', 'failed_permanent', 'awaiting_approval', 'blocked', 'needs_human']) {
      expect(stepStatusLabel(s)).not.toBe(s);
    }
    expect(stepStatusLabel('weird')).toBe('weird');
  });
  it('shows evidence without internal ids and truncates long text', () => {
    const rows = summarizeToolInput({ enrollmentId: 'x', stepNumber: 1, to: '+15551234567', body: 'a'.repeat(400), customerName: 'Pat' });
    expect(rows.map((r) => r.label)).toEqual(['to', 'body', 'customer name']);
    expect(rows[1].value.length).toBe(158);
  });
  it('summarizes the run budget', () => {
    expect(runBudgetSummary({ limits: { max_steps: 2, max_contacts: 1, max_cost_cents: 100 }, usage: { steps: 1, contacts: 0, cost_cents: 0 } }))
      .toBe('steps 1/2 · contacts 0/1 · cost ¢ 0/100');
    expect(runBudgetSummary({ limits: {}, usage: {} })).toBe('no limits recorded');
  });
});
