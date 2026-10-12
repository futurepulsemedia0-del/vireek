// src/lib/landingPages.ts
//
// Data layer for the landing-page builder. Every dashboard query is scoped by
// the ACCOUNT OWNER's id (never the logged-in team member's own id) on top of
// RLS, so a team member and an owner always see the same account data.

import { supabase } from '@/lib/supabase';
import {
  cleanSections,
  mapSubmitError,
  parseStoredAttribution,
  serializeStoredAttribution,
} from '@/lib/landingPageUtils';
import type {
  Attribution,
  CtaMode,
  DomainStatus,
  LandingDomain,
  LandingPage,
  LandingPageDraft,
  LandingSection,
  LandingStatus,
  SubmitFailure,
} from '@/lib/landingPageUtils';

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

export type LandingErrorCode =
  | 'slug_taken'
  | 'domain_exists'
  | 'domain_limit'
  | 'page_limit'
  | 'permission'
  | 'unknown';

export class LandingApiError extends Error {
  code: LandingErrorCode;
  constructor(code: LandingErrorCode, message: string) {
    super(message);
    this.name = 'LandingApiError';
    this.code = code;
  }
}

function toApiError(err: { code?: string; message?: string }): LandingApiError {
  const msg = err.message ?? '';
  if (err.code === '23505' && msg.includes('uq_landing_pages_slug')) {
    return new LandingApiError('slug_taken', 'That URL is already taken.');
  }
  if (err.code === '23505' && msg.includes('uq_landing_domains')) {
    return new LandingApiError('domain_exists', 'That domain is already added.');
  }
  if (msg.includes('page_limit_reached')) {
    return new LandingApiError('page_limit', 'You have reached the limit of 50 landing pages.');
  }
  if (msg.includes('domain_limit_reached')) {
    return new LandingApiError('domain_limit', 'You have reached the limit of 10 custom domains.');
  }
  if (err.code === '42501') {
    return new LandingApiError('permission', 'You do not have permission to do that.');
  }
  return new LandingApiError('unknown', msg || 'Something went wrong. Please try again.');
}

// ------------------------------------------------------------------
// Dashboard: pages
// ------------------------------------------------------------------

const PAGE_COLUMNS =
  'id,user_id,slug,title,headline,subheadline,body,sections,cta_label,cta_mode,accent_color,seo_title,seo_description,status,published_at,created_at,updated_at';

function draftToRow(d: LandingPageDraft) {
  return {
    slug: d.slug,
    title: d.title.trim(),
    headline: d.headline.trim(),
    subheadline: d.subheadline.trim() || null,
    body: d.body.trim() || null,
    sections: cleanSections(d.sections),
    cta_label: d.cta_label.trim(),
    cta_mode: d.cta_mode,
    accent_color: d.accent_color,
    seo_title: d.seo_title.trim() || null,
    seo_description: d.seo_description.trim() || null,
  };
}

export async function listLandingPages(ownerId: string): Promise<LandingPage[]> {
  const { data, error } = await supabase
    .from('landing_pages')
    .select(PAGE_COLUMNS)
    .eq('user_id', ownerId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw toApiError(error);
  return (data ?? []) as unknown as LandingPage[];
}

export async function createLandingPage(
  ownerId: string,
  draft: LandingPageDraft,
  status: LandingStatus = 'draft',
): Promise<LandingPage> {
  const { data, error } = await supabase
    .from('landing_pages')
    .insert({ user_id: ownerId, ...draftToRow(draft), status })
    .select(PAGE_COLUMNS)
    .single();
  if (error) throw toApiError(error);
  return data as unknown as LandingPage;
}

export async function saveLandingPage(
  ownerId: string,
  id: string,
  draft: LandingPageDraft,
  status?: LandingStatus,
): Promise<LandingPage> {
  const { data, error } = await supabase
    .from('landing_pages')
    .update({ ...draftToRow(draft), ...(status ? { status } : {}) })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(PAGE_COLUMNS)
    .maybeSingle();
  if (error) throw toApiError(error);
  if (!data) throw new LandingApiError('permission', 'This page could not be updated.');
  return data as unknown as LandingPage;
}

export async function setLandingPageStatus(
  ownerId: string,
  id: string,
  status: LandingStatus,
): Promise<LandingPage> {
  const { data, error } = await supabase
    .from('landing_pages')
    .update({ status })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(PAGE_COLUMNS)
    .maybeSingle();
  if (error) throw toApiError(error);
  if (!data) throw new LandingApiError('permission', 'This page could not be updated.');
  return data as unknown as LandingPage;
}

export async function deleteLandingPage(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('landing_pages').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw toApiError(error);
}

// ------------------------------------------------------------------
// Dashboard: domains
// ------------------------------------------------------------------

const DOMAIN_COLUMNS =
  'id,user_id,domain,landing_page_id,verification_token,status,verified_at,last_checked_at,last_error,created_at';

export interface VerifyResult {
  status: DomainStatus;
  txt_found: boolean;
  routing_ok: boolean;
  error?: string;
  throttled?: boolean;
}

export async function listLandingDomains(ownerId: string): Promise<LandingDomain[]> {
  const { data, error } = await supabase
    .from('landing_domains')
    .select(DOMAIN_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw toApiError(error);
  return (data ?? []) as unknown as LandingDomain[];
}

export async function addLandingDomain(
  ownerId: string,
  domain: string,
  pageId: string | null,
): Promise<LandingDomain> {
  const { data, error } = await supabase
    .from('landing_domains')
    .insert({ user_id: ownerId, domain, landing_page_id: pageId })
    .select(DOMAIN_COLUMNS)
    .single();
  if (error) throw toApiError(error);
  return data as unknown as LandingDomain;
}

export async function setLandingDomainPage(
  ownerId: string,
  id: string,
  pageId: string | null,
): Promise<LandingDomain> {
  const { data, error } = await supabase
    .from('landing_domains')
    .update({ landing_page_id: pageId })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(DOMAIN_COLUMNS)
    .maybeSingle();
  if (error) throw toApiError(error);
  if (!data) throw new LandingApiError('permission', 'This domain could not be updated.');
  return data as unknown as LandingDomain;
}

export async function verifyLandingDomain(id: string): Promise<VerifyResult> {
  const { data, error } = await supabase.functions.invoke('landing-domain-verify', {
    body: { action: 'verify', domain_id: id },
  });
  if (error) throw new LandingApiError('unknown', error.message);
  return data as VerifyResult;
}

export async function removeLandingDomain(id: string): Promise<void> {
  const { error } = await supabase.functions.invoke('landing-domain-verify', {
    body: { action: 'remove', domain_id: id },
  });
  if (error) throw new LandingApiError('unknown', error.message);
}

// ------------------------------------------------------------------
// Dashboard: analytics (SECURITY INVOKER RPCs — RLS scopes to the account)
// ------------------------------------------------------------------

export interface PageStats {
  landing_page_id: string;
  views: number;
  visitors: number;
  cta_clicks: number;
  leads: number;
  bookings: number;
}

export interface UtmRow {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  visitors: number;
  leads: number;
  bookings: number;
}

export interface DailyPoint {
  day: string;
  visitors: number;
  conversions: number;
}

export async function fetchLandingAnalytics(days: number): Promise<PageStats[]> {
  const { data, error } = await supabase.rpc('get_landing_page_analytics', { p_days: days });
  if (error) throw toApiError(error);
  return (data ?? []) as PageStats[];
}

export async function fetchUtmBreakdown(pageId: string | null, days: number): Promise<UtmRow[]> {
  const { data, error } = await supabase.rpc('get_landing_utm_breakdown', { p_page_id: pageId, p_days: days });
  if (error) throw toApiError(error);
  return (data ?? []) as UtmRow[];
}

export async function fetchDailySeries(pageId: string | null, days: number): Promise<DailyPoint[]> {
  const { data, error } = await supabase.rpc('get_landing_daily_series', { p_page_id: pageId, p_days: days });
  if (error) throw toApiError(error);
  return (data ?? []) as DailyPoint[];
}

// ------------------------------------------------------------------
// Public: visitor identity + attribution storage
// ------------------------------------------------------------------

const VISITOR_KEY = 'vk_lp_vid';
let memoryVisitorId: string | null = null;

// Honor Global Privacy Control: no persistent identifiers when it is on.
function privacySignalOn(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

function newVisitorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function getVisitorId(): string {
  if (memoryVisitorId) return memoryVisitorId;
  const persist = !privacySignalOn();
  if (persist) {
    try {
      const stored = localStorage.getItem(VISITOR_KEY);
      if (stored && stored.length >= 8 && stored.length <= 64) {
        memoryVisitorId = stored;
        return stored;
      }
    } catch {
      // Storage blocked (private mode / disabled) — fall through to in-memory id.
    }
  }
  const id = newVisitorId();
  memoryVisitorId = id;
  if (persist) {
    try {
      localStorage.setItem(VISITOR_KEY, id);
    } catch {
      // Ignore: the in-memory id still works for this session.
    }
  }
  return id;
}

const attributionKey = (pageId: string) => `vk_lp_attr:${pageId}`;

export function loadStoredAttribution(pageId: string): Attribution | null {
  if (privacySignalOn()) return null;
  try {
    return parseStoredAttribution(localStorage.getItem(attributionKey(pageId)), Date.now());
  } catch {
    return null;
  }
}

export function storeAttribution(pageId: string, attribution: Attribution): void {
  if (privacySignalOn()) return;
  try {
    localStorage.setItem(attributionKey(pageId), serializeStoredAttribution(attribution, Date.now()));
  } catch {
    // Ignore: attribution still travels with this visit's events.
  }
}

// ------------------------------------------------------------------
// Public: page + events + submissions (anon-safe RPCs)
// ------------------------------------------------------------------

export interface PublicLandingPageData {
  id: string;
  slug: string;
  title: string;
  headline: string;
  subheadline: string | null;
  body: string | null;
  sections: LandingSection[];
  cta_label: string;
  cta_mode: CtaMode;
  accent_color: string;
  seo_title: string | null;
  seo_description: string | null;
  business_name: string | null;
  services_offered: string[] | null;
  booking_slug: string | null;
}

/** Returns null when not found / unpublished; THROWS on transport errors so the UI can offer a retry. */
export async function fetchPublicLandingPage(params: {
  slug?: string;
  host?: string;
}): Promise<PublicLandingPageData | null> {
  if (!params.slug && !params.host) return null;
  const { data, error } = await supabase.rpc('get_published_landing_page', {
    p_slug: params.host ? null : (params.slug ?? null),
    p_host: params.host ?? null,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return {
    ...(row as PublicLandingPageData),
    sections: Array.isArray(row.sections) ? (row.sections as LandingSection[]) : [],
  };
}

/** Best-effort: analytics must never break the page. */
export async function trackLandingEvent(args: {
  pageId: string;
  type: 'view' | 'cta_click';
  attribution: Attribution;
}): Promise<void> {
  try {
    await supabase.rpc('track_landing_event', {
      p_page_id: args.pageId,
      p_visitor_id: getVisitorId(),
      p_event_type: args.type,
      p_attribution: args.attribution,
      p_host: window.location.hostname,
    });
  } catch {
    // Intentionally swallowed.
  }
}

export type SubmitResult = { ok: true } | { ok: false; reason: SubmitFailure };

export interface LeadInput {
  pageId: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  message: string;
  attribution: Attribution;
}

export async function submitLandingLead(input: LeadInput): Promise<SubmitResult> {
  try {
    const { error } = await supabase.rpc('submit_landing_lead', {
      p_page_id: input.pageId,
      p_visitor_id: getVisitorId(),
      p_name: input.name.trim(),
      p_phone: input.phone.trim() || null,
      p_email: input.email.trim() || null,
      p_service: input.service || null,
      p_message: input.message.trim() || null,
      p_attribution: input.attribution,
      p_host: window.location.hostname,
    });
    if (error) return { ok: false, reason: mapSubmitError(error.message) };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

export interface BookingInput {
  pageId: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  scheduledDatetime: Date;
  notes: string;
  attribution: Attribution;
}

export async function submitLandingBooking(input: BookingInput): Promise<SubmitResult> {
  try {
    const { error } = await supabase.rpc('submit_landing_booking', {
      p_page_id: input.pageId,
      p_visitor_id: getVisitorId(),
      p_name: input.name.trim(),
      p_phone: input.phone.trim() || null,
      p_email: input.email.trim() || null,
      p_service: input.service || null,
      p_scheduled_datetime: input.scheduledDatetime.toISOString(),
      p_notes: input.notes.trim() || null,
      p_attribution: input.attribution,
      p_host: window.location.hostname,
    });
    if (error) return { ok: false, reason: mapSubmitError(error.message) };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}
