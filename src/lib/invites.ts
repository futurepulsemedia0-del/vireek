import { supabase } from '@/lib/supabase';

export interface PublicInviteInfo {
  member_email: string;
  member_name: string | null;
  role: string;
  invite_status: 'pending' | 'active';
  is_expired: boolean;
  company_name: string | null;
  inviter_name: string | null;
}

export type AcceptInviteError =
  | 'not_authenticated'
  | 'not_found'
  | 'already_accepted'
  | 'expired'
  | 'email_mismatch'
  | 'existing_owner'
  | 'unknown';

export interface AcceptInviteResult {
  success: boolean;
  error?: AcceptInviteError;
  accountOwnerId?: string;
  companyName?: string | null;
}

export async function fetchInviteForToken(token: string): Promise<PublicInviteInfo | null> {
  const { data, error } = await supabase.rpc('get_invite_for_token', { p_token: token });
  if (error || !data || data.length === 0) return null;
  return data[0] as PublicInviteInfo;
}

export async function acceptTeamInvite(token: string): Promise<AcceptInviteResult> {
  const { data, error } = await supabase.rpc('accept_team_invite', { p_token: token });
  if (error || !data) return { success: false, error: 'unknown' };
  return {
    success: Boolean(data.success),
    error: data.error as AcceptInviteError | undefined,
    accountOwnerId: data.account_owner_id ?? undefined,
    companyName: data.company_name ?? null,
  };
}

export const INVITE_ERROR_MESSAGES: Record<AcceptInviteError, string> = {
  not_authenticated: 'Please sign in first.',
  not_found: "This invite link isn't valid.",
  already_accepted: 'This invite has already been accepted — try logging in instead.',
  expired: 'This invite link has expired. Ask the account owner to resend it.',
  email_mismatch: "You're signed in with a different email than this invite was sent to.",
  existing_owner: "This account already owns its own Vireek workspace and can't join another one.",
  unknown: 'Something went wrong. Please try again.',
};
