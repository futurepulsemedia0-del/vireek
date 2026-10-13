import { describe, it, expect } from 'vitest';
import { AUDIT_ID_CAP, buildBulkAuditPayload, logBulkAudit, type AuditRpc } from './audit';

describe('bulk audit', () => {
  it('builds one payload with count and caps the id list', () => {
    const ids = Array.from({ length: AUDIT_ID_CAP + 5 }, (_, i) => `id${i}`);
    const p = buildBulkAuditPayload({ action: 'bulk_delete', table: 'jobs', ids, metadata: { labels: ['x'] } });
    expect(p.p_target_ids).toHaveLength(AUDIT_ID_CAP);
    expect(p.p_metadata).toMatchObject({ count: AUDIT_ID_CAP + 5, truncated: true, labels: ['x'] });
  });

  it('uses the bulk RPC when available', async () => {
    const seen: string[] = [];
    const rpc: AuditRpc = async (fn) => (seen.push(fn), { error: null });
    expect(await logBulkAudit({ action: 'bulk_export', table: 'calls', ids: ['a'] }, rpc, 'u1')).toBe(true);
    expect(seen).toEqual(['log_bulk_audit_event']);
  });

  it('falls back to the legacy RPC when the migration is missing', async () => {
    const seen: string[] = [];
    const rpc: AuditRpc = async (fn) => (seen.push(fn), { error: fn === 'log_bulk_audit_event' ? { message: 'missing' } : null });
    expect(await logBulkAudit({ action: 'bulk_assign', table: 'leads', ids: ['a', 'b'] }, rpc, 'u1')).toBe(true);
    expect(seen).toEqual(['log_bulk_audit_event', 'log_audit_event']);
  });

  it('never throws and reports false when both fail', async () => {
    const rpc: AuditRpc = async () => { throw new Error('offline'); };
    expect(await logBulkAudit({ action: 'bulk_delete', table: 'jobs', ids: ['a'] }, rpc, 'u1')).toBe(false);
  });
});
