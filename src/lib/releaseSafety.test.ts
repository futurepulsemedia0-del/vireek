import { describe, expect, it } from 'vitest';
import { canDecide, decisionTone, describeRequest, drillStatus, impactSummary, isUuid, nextStages, riskTone, validateReason } from './releaseSafety';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-04T00:00:00Z');

describe('drillStatus', () => {
  it('flags never, due and overdue drills', () => {
    expect(drillStatus(null, NOW).tone).toBe('danger');
    expect(drillStatus(new Date(NOW - 10 * DAY).toISOString(), NOW).tone).toBe('success');
    expect(drillStatus(new Date(NOW - 30 * DAY).toISOString(), NOW).tone).toBe('warning');
    expect(drillStatus(new Date(NOW - 40 * DAY).toISOString(), NOW).label).toMatch(/overdue/);
    expect(drillStatus('garbage', NOW).tone).toBe('danger');
  });
});

describe('canDecide (two-person rule)', () => {
  it('blocks the requester and non-pending requests', () => {
    expect(canDecide({ status: 'pending', requested_by: 'a' }, 'a')).toBe(false);
    expect(canDecide({ status: 'pending', requested_by: 'a' }, 'b')).toBe(true);
    expect(canDecide({ status: 'approved', requested_by: 'a' }, 'b')).toBe(false);
    expect(canDecide({ status: 'pending', requested_by: 'a' }, null)).toBe(false);
  });
});

describe('describeRequest', () => {
  it('writes a plain-language summary for each kind', () => {
    expect(describeRequest({ kind: 'kill_switch_resume', target_key: 'outbound_dialer', payload: {} })).toContain('Resume');
    expect(describeRequest({ kind: 'flag_change', target_key: 'x', payload: { enabled: true, rollout_pct: 25 } })).toBe('Set flag "x" ON at 25%');
    expect(describeRequest({ kind: 'flag_change', target_key: 'x', payload: { enabled: false, rollout_pct: 0 } })).toBe('Set flag "x" OFF');
    expect(describeRequest({ kind: 'app_policy', target_key: 'ios', payload: { min_version: '1.4.0', latest_version: '1.5.0', rollout_pct: 20 } })).toContain('minimum 1.4.0');
  });
});

describe('small helpers', () => {
  it('nextStages only offers higher stages', () => {
    expect(nextStages(1)).toEqual([5, 25, 50, 100]);
    expect(nextStages(50)).toEqual([100]);
    expect(nextStages(100)).toEqual([]);
  });
  it('validates reasons and uuids', () => {
    expect(validateReason('  ')).not.toBeNull();
    expect(validateReason('ok then')).toBeNull();
    expect(validateReason('x'.repeat(501))).not.toBeNull();
    expect(isUuid('00000000-0000-0000-0000-0000000000a1')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
  it('maps tones', () => {
    expect(riskTone('critical')).toBe('danger');
    expect(decisionTone('rollback')).toBe('danger');
    expect(decisionTone(null)).toBe('neutral');
  });
  it('summarises impact', () => {
    expect(impactSummary({ current_tenants: 2, next_tenants: 12, newly_exposed: 10, total_tenants: 100 })).toBe('2 → 12 of 100 accounts (+10); 10 newly exposed');
  });
});
