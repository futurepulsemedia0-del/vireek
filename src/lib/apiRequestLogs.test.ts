import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { percentile, statusRangeFor, statusTone, summarizeLogs } from '@/lib/apiRequestLogs';

describe('percentile', () => {
  it('returns null for empty input and uses nearest-rank otherwise', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('summarizeLogs', () => {
  it('returns nulls for no rows', () => {
    expect(summarizeLogs([])).toEqual({ total: 0, errors: 0, successRate: null, p50: null, p95: null });
  });

  it('counts 4xx/5xx as errors and computes latency percentiles', () => {
    const s = summarizeLogs([
      { status: 200, latency_ms: 120 },
      { status: 200, latency_ms: 80 },
      { status: 404, latency_ms: 40 },
      { status: 500, latency_ms: 900 },
    ]);
    expect(s.total).toBe(4);
    expect(s.errors).toBe(2);
    expect(s.successRate).toBe(50);
    expect(s.p50).toBe(80);
    expect(s.p95).toBe(900);
  });
});

describe('statusRangeFor / statusTone', () => {
  it('maps filters to half-open status ranges', () => {
    expect(statusRangeFor('all')).toBeNull();
    expect(statusRangeFor('success')).toEqual({ min: 200, max: 400 });
    expect(statusRangeFor('client_error')).toEqual({ min: 400, max: 500 });
    expect(statusRangeFor('server_error')).toEqual({ min: 500, max: 600 });
  });

  it('tones by class', () => {
    expect(statusTone(204)).toBe('success');
    expect(statusTone(403)).toBe('warning');
    expect(statusTone(500)).toBe('danger');
  });
});
