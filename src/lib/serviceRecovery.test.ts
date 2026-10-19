import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  SEVERITY_COLORS,
  SEVERITY_LABELS,
  SIGNAL_TYPE_LABELS,
  SIGNAL_TYPE_OPTIONS,
  STATUS_COLORS,
  STATUS_LABELS,
  bySeverityThenRecency,
  formatRelativeTime,
  isOpenSignal,
} from './serviceRecovery';

describe('serviceRecovery helpers', () => {
  it('has a label for every signal type, severity and status', () => {
    expect(Object.keys(SEVERITY_LABELS)).toEqual(['low', 'medium', 'high', 'critical']);
    expect(Object.keys(SEVERITY_COLORS)).toEqual(Object.keys(SEVERITY_LABELS));
    expect(Object.keys(STATUS_COLORS)).toEqual(Object.keys(STATUS_LABELS));
    for (const t of SIGNAL_TYPE_OPTIONS) expect(SIGNAL_TYPE_LABELS[t]).toBeTruthy();
  });

  it('treats only unanswered statuses as open', () => {
    expect(isOpenSignal('open')).toBe(true);
    expect(isOpenSignal('playbook_enrolled')).toBe(true);
    expect(isOpenSignal('escalated')).toBe(true);
    expect(isOpenSignal('action_queued')).toBe(true);
    expect(isOpenSignal('action_sent')).toBe(false);
    expect(isOpenSignal('resolved')).toBe(false);
    expect(isOpenSignal('ignored')).toBe(false);
  });

  it('sorts by severity, then newest first, without mutating the input', () => {
    const rows = [
      { id: 'a', severity: 'medium' as const, detected_at: '2027-01-01T10:00:00Z' },
      { id: 'b', severity: 'critical' as const, detected_at: '2027-01-01T08:00:00Z' },
      { id: 'c', severity: 'medium' as const, detected_at: '2027-01-01T12:00:00Z' },
      { id: 'd', severity: 'low' as const, detected_at: '2027-01-02T00:00:00Z' },
    ];
    const snapshot = rows.map((r) => r.id);
    expect(bySeverityThenRecency(rows).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it('formats relative times', () => {
    const now = Date.parse('2027-03-10T12:00:00Z');
    expect(formatRelativeTime('2027-03-10T11:59:45Z', now)).toBe('just now');
    expect(formatRelativeTime('2027-03-10T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2027-03-10T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2027-03-08T12:00:00Z', now)).toBe('2d ago');
    expect(formatRelativeTime('not a date', now)).toBe('');
    expect(formatRelativeTime('2027-03-10T12:00:30Z', now)).toBe('just now'); // clock skew never goes negative
  });
});
