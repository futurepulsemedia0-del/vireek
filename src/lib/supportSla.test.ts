import { describe, it, expect } from 'vitest';
import { isSeverity, overdueLabel, provisionalSeverity, SEVERITIES } from './supportSla';

describe('supportSla', () => {
  it('knows exactly four severities', () => {
    expect(SEVERITIES).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(isSeverity('S1')).toBe(true);
    expect(isSeverity('S5')).toBe(false);
    expect(isSeverity(null)).toBe(false);
  });
  it('maps customer priority to a provisional severity and never to S1', () => {
    expect(provisionalSeverity('urgent')).toBe('S2');
    expect(provisionalSeverity('high')).toBe('S2');
    expect(provisionalSeverity('normal')).toBe('S3');
    expect(provisionalSeverity('low')).toBe('S4');
  });
  it('formats overdue labels', () => {
    expect(overdueLabel({ overdue_kind: 'first_response', overdue_seconds: 4500 })).toBe('First response overdue by 1h 15m');
    expect(overdueLabel({ overdue_kind: 'resolution', overdue_seconds: 30 })).toBe('Resolution overdue by <1m');
  });
});
