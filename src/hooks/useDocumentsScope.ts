import { useAuth } from '@/contexts/AuthContext';

/**
 * Resolves WHO the documents vault belongs to and what the caller may do.
 *
 * - accountOwnerId: the owner's profile id for owners, `account_owner_id` for
 *   team members (documents/storage are always keyed by the OWNER, never by
 *   the logged-in team member — using user.id here would silently break
 *   storage + RLS for every team account).
 * - canManage: mirrors public.can_manage_documents() in the database
 *   (owner, or `can_edit_business_profile`). The DB enforces it too; this
 *   only decides what the UI shows.
 */
export function useDocumentsScope() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || Boolean(permissions?.can_edit_business_profile);
  return { accountOwnerId, canManage, ready: Boolean(accountOwnerId) };
}
