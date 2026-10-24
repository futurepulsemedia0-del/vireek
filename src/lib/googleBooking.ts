import { supabase } from '@/lib/supabase';

// ============================================================
// Google agentic-booking readiness — types, pure helpers (readiness checklist,
// schema.org JSON-LD) and thin data access. The pure parts have no network.
// ============================================================

export type PartnerStatus = 'not_applied' | 'applied' | 'sandbox' | 'approved';
export const PARTNER_LABELS: Record<PartnerStatus, string> = {
  not_applied: 'Not applied', applied: 'Applied — waiting for Google', sandbox: 'Sandbox testing', approved: 'Approved by Google',
};

export interface GoogleBookingSettings {
  user_id: string;
  feed_enabled: boolean;
  structured_data_enabled: boolean;
  partner_status: PartnerStatus;
  horizon_days: number;
}

export type BlockReason = 'feed_disabled' | 'booking_disabled' | 'timezone_missing' | 'timezone_invalid' | 'hours_missing' | 'no_services';
export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  feed_disabled: 'The feed is switched off.',
  booking_disabled: 'Online booking is turned off in Booking Settings.',
  timezone_missing: 'Set your business timezone so availability can be verified.',
  timezone_invalid: 'Your business timezone is not a valid timezone.',
  hours_missing: 'Add booking or business hours.',
  no_services: 'Add at least one visible service.',
};

export interface FeedSlotPreview { start: string; local_date: string; local_time: string }
export interface FeedPreview {
  preview: true;
  blocked: BlockReason | null;
  timezone: string | null;
  capacity_mode: 'technician_capacity' | 'business_wide';
  published_slots: number;
  next_slots: FeedSlotPreview[];
  services: string[];
  slug: string | null;
}

export type ProposalKind = 'services' | 'service_areas';
export type ProposalStatus = 'pending' | 'approved' | 'applying' | 'applied' | 'rejected' | 'superseded' | 'failed';
export interface GbpProposal {
  id: string;
  kind: ProposalKind;
  desired: unknown;
  status: ProposalStatus;
  applied_via: 'api' | 'manual' | null;
  last_error: string | null;
  created_at: string;
}

export interface ReadinessCheck { id: string; label: string; ok: boolean; hint?: string }

export function buildReadiness(input: {
  preview: FeedPreview | null;
  settings: GoogleBookingSettings | null;
  activeAreaCount: number;
}): ReadinessCheck[] {
  const { preview, settings, activeAreaCount } = input;
  // The engine reports the FIRST failing step; later steps are not verifiable until it is fixed.
  const steps: { label: string; reasons: BlockReason[] }[] = [
    { label: 'Online booking enabled', reasons: ['booking_disabled'] },
    { label: 'Business timezone set and valid', reasons: ['timezone_missing', 'timezone_invalid'] },
    { label: 'Booking hours configured', reasons: ['hours_missing'] },
    { label: 'Services listed', reasons: ['no_services'] },
  ];
  const failing = preview?.blocked && preview.blocked !== 'feed_disabled'
    ? steps.findIndex((s) => s.reasons.includes(preview.blocked as BlockReason))
    : steps.length;
  const checks: ReadinessCheck[] = steps.map((step, i) => {
    const ok = !!preview && i < failing;
    let hint: string | undefined;
    if (!ok) hint = !preview ? 'Preview unavailable.' : i === failing ? BLOCK_MESSAGES[preview.blocked as BlockReason] : 'Fix the step above first.';
    return { id: `step_${i}`, label: step.label, ok, hint };
  });
  checks.push({
    id: 'slots', ok: (preview?.published_slots ?? 0) > 0, label: 'Verified open slots available',
    hint: 'No bookable slots in the publish window — check hours, capacity and lead time.',
  });
  checks.push({
    id: 'areas', ok: activeAreaCount > 0, label: 'Service areas defined',
    hint: 'Add at least one active service area.',
  });
  checks.push({
    id: 'partner', ok: settings?.partner_status === 'approved', label: 'Google partner approval',
    hint: 'Real-time booking through Google only opens after Google approves your integration.',
  });
  return checks;
}

// ------------------------------------------------------------
// schema.org JSON-LD (rendered on the public booking page)
// ------------------------------------------------------------
export interface StructuredDataInput {
  name: string;
  services: string[];
  areas: string[];
  hours: Record<string, { open: string; close: string }> | null;
}

const SCHEMA_DAYS: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function buildLocalBusinessJsonLd(data: StructuredDataInput, bookingUrl: string): Record<string, unknown> | null {
  const name = data.name?.trim();
  if (!name || !/^https:\/\//.test(bookingUrl)) return null;
  const services = [...new Set((data.services ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  const areas = [...new Set((data.areas ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  const hours = Object.entries(data.hours ?? {})
    .filter(([k, v]) => SCHEMA_DAYS[k] && v && TIME_RE.test(v.open) && TIME_RE.test(v.close))
    .map(([k, v]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: SCHEMA_DAYS[k], opens: v.open, closes: v.close }));

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'HomeAndConstructionBusiness',
    name,
    url: bookingUrl,
    potentialAction: {
      '@type': 'ReserveAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: bookingUrl,
        actionPlatform: ['http://schema.org/DesktopWebPlatform', 'http://schema.org/MobileWebPlatform'],
      },
      result: { '@type': 'Reservation', name: 'Book an appointment' },
    },
  };
  if (areas.length) ld.areaServed = areas.map((a) => ({ '@type': 'Place', name: a }));
  if (hours.length) ld.openingHoursSpecification = hours;
  if (services.length) {
    ld.hasOfferCatalog = {
      '@type': 'OfferCatalog', name: 'Services',
      itemListElement: services.map((s) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: s } })),
    };
  }
  return ld;
}

/** JSON for an inline <script>: a "<" can never close the tag. */
export function serializeJsonLd(ld: Record<string, unknown>): string {
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

// ------------------------------------------------------------
// Data access
// ------------------------------------------------------------
export function feedUrl(slug: string): string {
  const base = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/$/, '');
  return `${base}/functions/v1/google-booking-feed?slug=${encodeURIComponent(slug)}`;
}

export async function fetchStructuredData(slug: string): Promise<StructuredDataInput | null> {
  const { data, error } = await supabase.rpc('get_google_structured_data', { p_slug: slug });
  if (error || !data) return null;
  return data as StructuredDataInput;
}

export async function loadGoogleBookingSettings(): Promise<GoogleBookingSettings> {
  const { data, error } = await supabase.rpc('get_google_booking_settings');
  if (error || !data) throw new Error(error?.message ?? 'settings_unavailable');
  return data as GoogleBookingSettings;
}

export async function updateGoogleBookingSettings(patch: Partial<Pick<GoogleBookingSettings,
  'feed_enabled' | 'structured_data_enabled' | 'partner_status' | 'horizon_days'>>): Promise<{ ok: true; settings: GoogleBookingSettings } | { ok: false; reason: 'not_ready' | 'forbidden' | 'unknown' }> {
  const { data, error } = await supabase.rpc('update_google_booking_settings', {
    p_feed_enabled: patch.feed_enabled ?? null,
    p_structured_data_enabled: patch.structured_data_enabled ?? null,
    p_partner_status: patch.partner_status ?? null,
    p_horizon_days: patch.horizon_days ?? null,
  });
  if (error) return { ok: false, reason: error.message.includes('not_ready') ? 'not_ready' : error.message.includes('forbidden') ? 'forbidden' : 'unknown' };
  return { ok: true, settings: data as GoogleBookingSettings };
}

export async function loadFeedPreview(): Promise<FeedPreview> {
  const { data, error } = await supabase.functions.invoke('google-booking-feed', { body: { preview: true } });
  if (error || !data) throw new Error(error?.message ?? 'preview_unavailable');
  return data as FeedPreview;
}

export async function countActiveAreas(ownerId: string): Promise<number> {
  const { count, error } = await supabase.from('service_areas').select('id', { count: 'exact', head: true })
    .eq('user_id', ownerId).eq('is_active', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function loadProposals(ownerId: string): Promise<GbpProposal[]> {
  const { data, error } = await supabase.from('gbp_sync_proposals')
    .select('id, kind, desired, status, applied_via, last_error, created_at')
    .eq('user_id', ownerId).in('status', ['pending', 'approved', 'applying', 'failed'])
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as GbpProposal[];
}

export async function proposeGbpSync(): Promise<{ kind: ProposalKind; result: string }[]> {
  const { data, error } = await supabase.rpc('gbp_propose_sync');
  if (error) throw new Error(error.message);
  return (data ?? []) as { kind: ProposalKind; result: string }[];
}

export async function decideProposal(id: string, decision: 'approve' | 'reject' | 'applied_manually'): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await supabase.rpc('gbp_decide_proposal', { p_id: id, p_decision: decision });
  if (error) return { ok: false, code: error.message.includes('forbidden') ? 'forbidden' : 'unknown' };
  return data as { ok: boolean; code?: string };
}

export async function applyProposal(id: string): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await supabase.functions.invoke('gbp-sync', { body: { proposal_id: id } });
  if (error) {
    // invoke surfaces non-2xx as an error; the JSON body (with our `code`) is on error.context
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.code) return { ok: false, code: String(body.code) };
    } catch { /* fall through */ }
    return { ok: false, code: 'unknown' };
  }
  return data as { ok: boolean; code?: string };
}
