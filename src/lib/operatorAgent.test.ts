import { describe, expect, it } from 'vitest';
import { canUndo, describeResult, isPreview } from './operatorAgent';

const NOW = Date.parse('2026-10-23T12:00:00Z');

describe('operatorAgent helpers', () => {
  it('offers undo only for finished runs inside 24 hours', () => {
    expect(canUndo({ status: 'completed', finished_at: '2026-10-23T08:00:00Z' }, NOW)).toBe(true);
    expect(canUndo({ status: 'partial', finished_at: '2026-10-22T08:00:00Z' }, NOW)).toBe(false);
    expect(canUndo({ status: 'refused', finished_at: '2026-10-23T08:00:00Z' }, NOW)).toBe(false);
    expect(canUndo({ status: 'completed', finished_at: null }, NOW)).toBe(false);
  });
  it('tells previews from refusals', () => {
    expect(isPreview({ status: 'refused', message: 'no' })).toBe(false);
    expect(isPreview({ status: 'ready' } as never)).toBe(true);
  });
  it('describes results in plain language', () => {
    expect(describeResult({ status: 'cancelled' })).toContain('nothing');
    expect(describeResult({ status: 'partial', summary: { status: 'partial', applied: 3, failed: 1, skipped: 2, steps: [] } })).toBe('3 changes applied · 2 skipped, 1 failed');
    expect(describeResult({ status: 'failed', summary: { status: 'failed', applied: 0, failed: 0, skipped: 2, steps: [] } })).toBe('Nothing was changed.');
  });
});
