// RCS Business Messaging + Apple Messages for Business: tenant settings data layer.
// Schema: supabase/migrations/20271201000000_rich_messaging_rcs_amb.sql.
// Tenants can only edit display + behaviour columns (column-level GRANT); approval state,
// provider app id and agent / MBA ids are operator-controlled and read-only here.

import { supabase } from '@/lib/supabase';

export type ProviderStatus =
  'not_started' | 'requested' | 'in_review' | 'approved' | 'rejected' | 'suspended';

export interface RichAccount {
  userId: string;
  rcsStatus: ProviderStatus;
  rcsAgentId: string | null;
  ambStatus: ProviderStatus;
  ambBusinessId: string | null;
  rcsEnabled: boolean;
  ambEnabled: boolean;
  brandName: string;
  brandLogoUrl: string;
  brandColor: string;
  verifiedSenderName: string | null;
  fallbackToSms: boolean;
  fallbackAfterSeconds: number;
  attemptOnUnknown: boolean;
}

export type EditableSettings = Pick<
  RichAccount,
  | 'rcsEnabled'
  | 'ambEnabled'
  | 'brandName'
  | 'brandLogoUrl'
  | 'brandColor'
  | 'fallbackToSms'
  | 'fallbackAfterSeconds'
  | 'attemptOnUnknown'
>;

export const STATUS_LABEL: Record<ProviderStatus, string> = {
  not_started: 'Not started',
  requested: 'Requested',
  in_review: 'In carrier / Apple review',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

export const FALLBACK_SECONDS = { min: 10, max: 900 } as const;

export function mapAccountRow(r: Record<string, unknown>): RichAccount {
  return {
    userId: r.user_id as string,
    rcsStatus: r.rcs_status as ProviderStatus,
    rcsAgentId: (r.rcs_agent_id as string | null) ?? null,
    ambStatus: r.amb_status as ProviderStatus,
    ambBusinessId: (r.amb_business_id as string | null) ?? null,
    rcsEnabled: r.rcs_enabled === true,
    ambEnabled: r.amb_enabled === true,
    brandName: (r.brand_name as string | null) ?? '',
    brandLogoUrl: (r.brand_logo_url as string | null) ?? '',
    brandColor: (r.brand_color as string | null) ?? '',
    verifiedSenderName: (r.verified_sender_name as string | null) ?? null,
    fallbackToSms: r.fallback_to_sms !== false,
    fallbackAfterSeconds: Number(r.fallback_after_seconds ?? 45),
    attemptOnUnknown: r.attempt_on_unknown !== false,
  };
}

/** Returns a user-facing error, or null when the settings can be saved. Mirrors the DB CHECK constraints. */
export function validateSettings(s: EditableSettings): string | null {
  if (s.brandColor && !/^#[0-9A-Fa-f]{6}$/.test(s.brandColor))
    return 'Brand colour must look like #1A2B3C.';
  if (s.brandLogoUrl) {
    try {
      if (new URL(s.brandLogoUrl).protocol !== 'https:') return 'Logo URL must start with https://';
    } catch {
      return 'Logo URL is not a valid URL.';
    }
  }
  if (
    !Number.isInteger(s.fallbackAfterSeconds) ||
    s.fallbackAfterSeconds < FALLBACK_SECONDS.min ||
    s.fallbackAfterSeconds > FALLBACK_SECONDS.max
  ) {
    return `SMS fallback delay must be between ${FALLBACK_SECONDS.min} and ${FALLBACK_SECONDS.max} seconds.`;
  }
  return null;
}

export async function fetchRichAccount(): Promise<RichAccount | null> {
  const { data, error } = await supabase.from('rich_messaging_accounts').select('*').maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapAccountRow(data) : null;
}

export async function requestRichAccess(): Promise<RichAccount> {
  const { data, error } = await supabase.rpc('request_rich_messaging_access');
  if (error) throw new Error(error.message);
  return mapAccountRow(data as Record<string, unknown>);
}

export async function saveRichSettings(userId: string, s: EditableSettings): Promise<void> {
  const invalid = validateSettings(s);
  if (invalid) throw new Error(invalid);
  const { error } = await supabase
    .from('rich_messaging_accounts')
    .update({
      rcs_enabled: s.rcsEnabled,
      amb_enabled: s.ambEnabled,
      brand_name: s.brandName.trim() || null,
      brand_logo_url: s.brandLogoUrl.trim() || null,
      brand_color: s.brandColor.trim() || null,
      fallback_to_sms: s.fallbackToSms,
      fallback_after_seconds: s.fallbackAfterSeconds,
      attempt_on_unknown: s.attemptOnUnknown,
    })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}
