// supabase/functions/_shared/compliance/authUserErasure.ts
//
// Final step of a FULL-ACCOUNT erasure run by data-retention-sweep (which executes DSAR erasures too):
// delete the auth user AFTER all data has been erased. delete-account already does this for self-service
// deletion; the sweep path used to stop one step short and leave a login behind.
//
// Guarantees
//   * Idempotent: a user that is already gone (404 / user_not_found) counts as success ("already_absent").
//   * Fail closed: a legal hold, a failed hold check or an invalid id means we do NOT delete.
//   * Crash safe: the audit record is written AFTER the outcome is known. If the process dies between
//     deleteUser and the audit write, the retry sees "already_absent" and writes the audit record then.
//   * Never leaks internals: only short machine codes are returned (they end up on a row the owner can read).

export interface AuthAdminError { message?: string; status?: number; code?: string }

export interface AuthErasureClient {
  auth: { admin: { deleteUser: (id: string) => PromiseLike<{ error: AuthAdminError | null }> } };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type AuthErasureState = 'deleted' | 'already_absent' | 'blocked_legal_hold' | 'failed';

export interface AuthErasureOutcome {
  state: AuthErasureState;
  /** Short machine code, only set when state is 'failed'. */
  code?: string;
  /** False when the audit write failed; the deletion_requests row is then the only durable record. */
  audited: boolean;
}

/** Thrown by the sweep to mark "everything is erased except the login": retried by lease, not user-cancellable. */
export class AuthUserErasureIncomplete extends Error {
  constructor(public readonly code: string) {
    super(`auth_user_erasure_incomplete:${code}`);
    this.name = 'AuthUserErasureIncomplete';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserNotFound(err: AuthAdminError | null | undefined): boolean {
  if (!err) return false;
  return err.status === 404 || err.code === 'user_not_found' || /user\s+not\s+found/i.test(err.message ?? '');
}

/** Reduces any thrown value to a short code that is safe to store on an owner-readable row. */
export function safeErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  return /^[a-z0-9_]+(:[a-z0-9_.,-]+)?$/.test(msg) && msg.length <= 120 ? msg : 'internal_error';
}

async function audit(admin: AuthErasureClient, userId: string, requestId: string, state: AuthErasureState, attempt: number, code?: string): Promise<boolean> {
  try {
    const { error } = await admin.rpc('log_audit_event', {
      p_user_id: userId,
      p_action: `auth_user_erasure:${state}`,
      p_target_table: 'deletion_requests',
      p_target_id: requestId,
      p_metadata: { outcome: state, attempt, ...(code ? { code } : {}) },
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Deletes the auth user for a completed erasure. Call ONLY after every data-erasure step succeeded.
 * `userId` must be the request's own user_id (never client-supplied).
 */
export async function eraseAuthUser(
  admin: AuthErasureClient,
  opts: { userId: string; requestId: string; attempt: number },
): Promise<AuthErasureOutcome> {
  const { userId, requestId, attempt } = opts;
  const finish = async (state: AuthErasureState, code?: string): Promise<AuthErasureOutcome> => ({
    state,
    ...(code ? { code } : {}),
    audited: await audit(admin, userId, requestId, state, attempt, code),
  });

  if (!UUID.test(userId)) return { state: 'failed', code: 'invalid_user_id', audited: false };

  // A hold can be placed while the erasure runs. Re-check immediately before the irreversible step.
  let held: unknown;
  try {
    const r = await admin.rpc('has_active_legal_hold', { p_user_id: userId, p_dataset: null });
    if (r.error) return finish('failed', 'legal_hold_check_failed');
    held = r.data;
  } catch {
    return finish('failed', 'legal_hold_check_failed');
  }
  if (held) return finish('blocked_legal_hold');

  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (!error) return finish('deleted');
    if (isUserNotFound(error)) return finish('already_absent');
    return finish('failed', `auth_delete_${error.status ?? 'error'}`);
  } catch {
    return finish('failed', 'auth_delete_unreachable');
  }
}
