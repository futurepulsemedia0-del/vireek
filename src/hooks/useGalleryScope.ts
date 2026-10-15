import { useAuth } from '@/contexts/AuthContext';

/**
 * Who the gallery belongs to + what the caller may do.
 *
 * - accountOwnerId: owner's profile id, or `account_owner_id` for team members.
 *   Photos/storage are keyed by the OWNER so technicians and office staff share
 *   one gallery (using user.id here would split it per person).
 * - canManage: owner or `can_edit_business_profile` — may edit/delete ANY photo.
 *   Everyone else can upload and edit only photos they uploaded themselves.
 *   The database enforces the same rules (can_manage_job_photos()).
 */
export function useGalleryScope() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || Boolean(permissions?.can_edit_business_profile);
  return { accountOwnerId, userId: user?.id ?? null, canManage, ready: Boolean(accountOwnerId) };
}
