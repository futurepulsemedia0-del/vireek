import { describe, expect, it } from 'vitest';
import {
  formatAge,
  parseHealthRows,
  rowKey,
  summarizeHealth,
  validateTakeoverReason,
} from '@/lib/c2cWorkflowHealth';

const good = {
  stage: 'completed_without_invoice', job_id: 'j1', invoice_id: null, customer_name: 'Bob',
  age_minutes: 300.4, sla_minutes: 240, breached: true, owner_queue: 'billing', suggested_action: 'Draft and send the invoice',
};

describe('parseHealthRows', () => {
  it('returns [] for non-arrays', () => {
    expect(parseHealthRows(null)).toEqual([]);
    expect(parseHealthRows({})).toEqual([]);
  });
  it('keeps valid rows and drops malformed ones', () => {
    const rows = parseHealthRows([good, { ...good, stage: 'bogus' }, null, { ...good, age_minutes: 'x' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].age_minutes).toBe(300);
  });
  it('defaults missing queue and clamps negatives', () => {
    const [r] = parseHealthRows([{ ...good, owner_queue: undefined, age_minutes: -5 }]);
    expect(r.owner_queue).toBe('unassigned');
    expect(r.age_minutes).toBe(0);
  });
});

describe('formatAge', () => {
  it('formats minutes, hours and days', () => {
    expect(formatAge(5)).toBe('5m');
    expect(formatAge(125)).toBe('2h');
    expect(formatAge(60 * 49)).toBe('2d');
  });
});

describe('summarizeHealth', () => {
  it('counts breaches and queues', () => {
    const rows = parseHealthRows([good, { ...good, job_id: 'j2', breached: false, owner_queue: 'dispatch', age_minutes: 900 }]);
    const s = summarizeHealth(rows);
    expect(s).toEqual({ total: 2, breached: 1, byQueue: { billing: 1, dispatch: 1 }, oldestMinutes: 900 });
  });
});

describe('rowKey / validateTakeoverReason', () => {
  it('builds distinct keys per stage and job', () => {
    const [a] = parseHealthRows([good]);
    expect(rowKey(a)).not.toBe(rowKey({ ...a, job_id: 'j2' }));
  });
  it('validates reason length', () => {
    expect(validateTakeoverReason('  ')).not.toBeNull();
    expect(validateTakeoverReason('called customer')).toBeNull();
    expect(validateTakeoverReason('x'.repeat(501))).not.toBeNull();
  });
});
