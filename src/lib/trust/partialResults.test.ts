import { describe, expect, it } from 'vitest';
import type { BulkResult } from '@/lib/bulk/engine';
import { csvCell, failuresToCsv, mergeRetry, reasonRows, retryFailedOnly, summarizePartial } from './partialResults';

const run1: BulkResult = {
  requested: 5,
  succeeded: ['a', 'b'],
  failed: [{ id: 'c', reason: 'Failed to fetch' }, { id: 'd', reason: 'permission denied for table jobs' }],
  skipped: [{ id: 'e', reason: 'Job is already invoiced.' }],
};

describe('summarizePartial', () => {
  it('counts and outcome', () => {
    expect(summarizePartial(run1)).toEqual({ requested: 5, succeeded: 2, failed: 2, skipped: 1, outcome: 'partial' });
    expect(summarizePartial({ requested: 2, succeeded: ['a', 'b'], failed: [], skipped: [] }).outcome).toBe('all');
    expect(summarizePartial({ requested: 1, succeeded: [], failed: [{ id: 'a', reason: 'x' }], skipped: [] }).outcome).toBe('none');
  });
});

describe('reasonRows', () => {
  it('maps failures to kinds (no raw text) and keeps our own skip rules', () => {
    const rows = reasonRows(run1, (id) => id.toUpperCase());
    expect(rows.map((r) => [r.id, r.status, r.kind, r.retryable])).toEqual([
      ['c', 'failed', 'network', true],
      ['d', 'failed', 'permission', false],
      ['e', 'skipped', 'validation', false],
    ]);
    expect(rows[2].rule).toBe('Job is already invoiced.');
    expect(JSON.stringify(rows.slice(0, 2))).not.toContain('permission denied for table');
  });
});

describe('retryFailedOnly', () => {
  it('re-runs only failed ids and merges without losing earlier successes', async () => {
    let asked: string[] = [];
    const out = await retryFailedOnly(run1, async (ids) => {
      asked = ids;
      return { requested: ids.length, succeeded: ['c'], failed: [{ id: 'd', reason: 'permission denied' }], skipped: [] };
    });
    expect(asked).toEqual(['c', 'd']);
    expect(out.succeeded.sort()).toEqual(['a', 'b', 'c']);
    expect(out.failed.map((f) => f.id)).toEqual(['d']);
    expect(out.skipped).toHaveLength(1);
    expect(out.requested).toBe(5);
  });
  it('is a no-op when nothing failed', async () => {
    const ok: BulkResult = { requested: 1, succeeded: ['a'], failed: [], skipped: [] };
    expect(await retryFailedOnly(ok, async () => { throw new Error('must not run'); })).toBe(ok);
  });
  it('does not double-count ids that succeed in both runs', () => {
    const m = mergeRetry({ requested: 2, succeeded: ['a'], failed: [{ id: 'b', reason: 'x' }], skipped: [] }, { requested: 1, succeeded: ['a', 'b'], failed: [], skipped: [] });
    expect(m.succeeded.sort()).toEqual(['a', 'b']);
  });
});

describe('csv', () => {
  it('quotes and neutralises formula injection', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1+1')).toBe("'-1+1");
  });
  it('builds a BOM-prefixed CSV with translated reasons', () => {
    const csv = failuresToCsv(run1, { id: 'ID', name: 'Name', status: 'Status', reason: 'Reason', failed: 'Failed', skipped: 'Skipped', reasonFor: (k) => `R:${k}` }, (id) => `=${id}`);
    expect(csv.startsWith('﻿ID,Name,Status,Reason\r\n')).toBe(true);
    expect(csv).toContain("c,'=c,Failed,R:network");
    expect(csv).toContain("e,'=e,Skipped,Job is already invoiced.");
  });
});
