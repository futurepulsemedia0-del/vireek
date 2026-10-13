/**
 * Audit trail for bulk actions. One audit row per bulk operation (not per
 * record) carrying the affected ids + counts in `metadata`. Prefers the
 * server-side `log_bulk_audit_event` RPC (resolves the account owner itself,
 * so a client cannot forge another account's trail) and falls back to the
 * legacy `log_audit_event` if the new migration has not been applied yet.
 */
export const AUDIT_ID_CAP = 500;

export type BulkAuditAction =
  | 'bulk_delete'
  | 'bulk_status_change'
  | 'bulk_assign'
  | 'bulk_tag_add'
  | 'bulk_tag_remove'
  | 'bulk_export';

export interface BulkAuditInput {
  action: BulkAuditAction;
  table: string;
  ids: string[];
  metadata?: Record<string, unknown>;
}

export type AuditRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;

export function buildBulkAuditPayload(input: BulkAuditInput) {
  return {
    p_action: input.action,
    p_target_table: input.table,
    p_target_ids: input.ids.slice(0, AUDIT_ID_CAP),
    p_metadata: { count: input.ids.length, truncated: input.ids.length > AUDIT_ID_CAP, ...input.metadata },
  };
}

/** Never throws. Resolves true when an audit row was written. */
export async function logBulkAudit(input: BulkAuditInput, rpc: AuditRpc, fallbackUserId?: string): Promise<boolean> {
  try {
    const { error } = await rpc('log_bulk_audit_event', buildBulkAuditPayload(input));
    if (!error) return true;
  } catch {
    /* fall through to legacy */
  }
  if (!fallbackUserId) return false;
  try {
    const { error } = await rpc('log_audit_event', {
      p_user_id: fallbackUserId,
      p_action: input.action,
      p_target_table: input.table,
      p_target_id: input.ids.slice(0, 20).join(',').slice(0, 1000) + (input.ids.length > 20 ? ` (+${input.ids.length - 20} more)` : ''),
    });
    return !error;
  } catch {
    return false;
  }
}
