// src/lib/lifecycleApi.ts — Supabase calls for Customer Lifecycle Touches (pure logic lives in lifecycle.ts).
import { supabase } from '@/lib/supabase';
import {
  defaultSetupTemplates,
  type CalendarRow,
  type Channel,
  type ConsentSource,
  type LifecycleProfile,
  type ProfileForm,
  type TouchSettings,
  type TouchType,
} from '@/lib/lifecycle';

export interface TemplateStep {
  id: string;
  campaign_id: string;
  step_order: number;
  channel: Channel;
  subject: string | null;
  body: string;
}

export interface CampaignInfo {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
}

export interface LogEntry {
  id: string;
  touch_type: TouchType;
  channel: Channel;
  status: 'claimed' | 'sent' | 'deferred' | 'failed' | 'skipped';
  skip_reason: string | null;
  error: string | null;
  occurrence_date: string;
  years_count: number | null;
  offer_code: string | null;
  offer_label: string | null;
  offer_expires_at: string | null;
  redeemed_at: string | null;
  sent_at: string | null;
  created_at: string;
  customers: { name: string } | null;
}

export interface TouchStats {
  touch_type: TouchType;
  touches_sent: number;
  offers_sent: number;
  offers_redeemed: number;
}

export type RedeemResult =
  | { ok: true; offer: string | null; terms: string | null; customer_name: string | null; touch_type: TouchType; expires_at: string | null }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_redeemed' };

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Request failed');
}

/** Idempotent: creates the 4 touch settings and their (draft) marketing campaigns with default templates. */
export async function ensureSetup(): Promise<TouchSettings[]> {
  const { data, error } = await supabase.rpc('ensure_lifecycle_touch_setup', { p_templates: defaultSetupTemplates() });
  if (error) fail(error);
  return (data ?? []) as TouchSettings[];
}

export async function listCampaigns(ids: string[]): Promise<CampaignInfo[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('marketing_campaigns').select('id, name, status').in('id', ids);
  if (error) fail(error);
  return (data ?? []) as CampaignInfo[];
}

export async function listSteps(campaignIds: string[]): Promise<TemplateStep[]> {
  if (campaignIds.length === 0) return [];
  const { data, error } = await supabase
    .from('marketing_campaign_steps')
    .select('id, campaign_id, step_order, channel, subject, body')
    .in('campaign_id', campaignIds)
    .order('step_order', { ascending: true });
  if (error) fail(error);
  return (data ?? []) as TemplateStep[];
}

/** The campaign status is the on/off switch of the touch. */
export async function setTouchActive(campaignId: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('marketing_campaigns').update({ status: active ? 'active' : 'paused' }).eq('id', campaignId);
  if (error) fail(error);
}

export type SettingsPatch = Partial<Omit<TouchSettings, 'id' | 'touch_type' | 'campaign_id'>>;

export async function saveSettings(id: string, patch: SettingsPatch): Promise<void> {
  const { error } = await supabase.from('lifecycle_touch_settings').update(patch).eq('id', id);
  if (error) fail(error);
}

/** Updates the template of one channel; creates the step if the owner removed it from the campaign. */
export async function saveTemplate(args: {
  campaignId: string;
  existing: TemplateStep | undefined;
  allSteps: TemplateStep[];
  channel: Channel;
  subject: string | null;
  body: string;
}): Promise<void> {
  const { existing, campaignId, channel, subject, body, allSteps } = args;
  if (existing) {
    const { error } = await supabase.from('marketing_campaign_steps').update({ subject, body }).eq('id', existing.id);
    if (error) fail(error);
    return;
  }
  const nextOrder = Math.max(0, ...allSteps.map((s) => s.step_order)) + 1;
  const { error } = await supabase
    .from('marketing_campaign_steps')
    .insert({ campaign_id: campaignId, step_order: nextOrder, delay_hours: 0, channel, subject, body });
  if (error) fail(error);
}

export async function removeStep(stepId: string): Promise<void> {
  const { error } = await supabase.from('marketing_campaign_steps').delete().eq('id', stepId);
  if (error) fail(error);
}

export async function getCalendar(from: string, to: string): Promise<CalendarRow[]> {
  const { data, error } = await supabase.rpc('get_lifecycle_calendar', { p_from: from, p_to: to });
  if (error) fail(error);
  return (data ?? []) as CalendarRow[];
}

export async function getRecentLog(limit = 100): Promise<LogEntry[]> {
  const { data, error } = await supabase
    .from('lifecycle_touch_log')
    .select('id, touch_type, channel, status, skip_reason, error, occurrence_date, years_count, offer_code, offer_label, offer_expires_at, redeemed_at, sent_at, created_at, customers(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error);
  return (data ?? []) as unknown as LogEntry[];
}

export async function getCustomerLog(customerId: string, limit = 5): Promise<LogEntry[]> {
  const { data, error } = await supabase
    .from('lifecycle_touch_log')
    .select('id, touch_type, channel, status, skip_reason, error, occurrence_date, years_count, offer_code, offer_label, offer_expires_at, redeemed_at, sent_at, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error);
  return (data ?? []) as unknown as LogEntry[];
}

export async function getStats(days = 90): Promise<TouchStats[]> {
  const { data, error } = await supabase.rpc('get_lifecycle_stats', { p_days: days });
  if (error) fail(error);
  return ((data ?? []) as TouchStats[]).map((r) => ({ ...r, touches_sent: Number(r.touches_sent), offers_sent: Number(r.offers_sent), offers_redeemed: Number(r.offers_redeemed) }));
}

export async function redeemOffer(code: string): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_lifecycle_offer', { p_code: code });
  if (error) fail(error);
  return data as RedeemResult;
}

export async function getProfile(customerId: string): Promise<LifecycleProfile | null> {
  const { data, error } = await supabase.from('customer_lifecycle_profiles').select('*').eq('customer_id', customerId).maybeSingle();
  if (error) fail(error);
  return (data as LifecycleProfile | null) ?? null;
}

export async function saveProfile(customerId: string, f: ProfileForm): Promise<LifecycleProfile> {
  const { data, error } = await supabase.rpc('set_customer_lifecycle_profile', {
    p_customer_id: customerId,
    p_birth_month: f.birthMonth ? Number(f.birthMonth) : null,
    p_birth_day: f.birthDay ? Number(f.birthDay) : null,
    p_home_purchase_date: f.homePurchaseDate || null,
    p_opted_in_touches: f.touches,
    p_email_consent: f.email,
    p_sms_consent: f.sms,
    p_consent_source: (f.source || null) as ConsentSource | null,
  });
  if (error) fail(error);
  return data as LifecycleProfile;
}
