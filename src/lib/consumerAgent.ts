import { supabase } from '@/lib/supabase';

// ============================================================
// Consumer Agent surface (owner side): types, pure helpers and thin data access.
// The public endpoints live in supabase/functions/consumer-agent; this file only
// talks to the owner RPCs (all gated by can_manage_service_areas() in the database).
// ============================================================

export const SECTION_KEYS = ['services', 'service_area', 'hours', 'prices', 'reviews', 'policies', 'contact'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface ConsumerAgentSettings {
  user_id: string;
  enabled: boolean;
  kill_switch: boolean;
  publish_services: boolean;
  publish_service_area: boolean;
  publish_hours: boolean;
  publish_prices: boolean;
  publish_reviews: boolean;
  publish_policies: boolean;
  publish_contact: boolean;
  public_phone: string | null;
  public_email: string | null;
  public_website: string | null;
  policies_text: string | null;
  request_mode: 'pending' | 'hold';
  hold_minutes: number;
  daily_request_cap: number;
  sla_minutes: number;
  auto_accept_enabled: boolean;
  auto_accept_services: string[];
  auto_accept_min_lead_hours: number;
}

export type SettingsPatch = Partial<Omit<ConsumerAgentSettings, 'user_id'>>;

export interface Preview {
  live: boolean;
  blockers: string[];
  profile: Record<string, unknown> | null;
  never_exposed: string[];
}

export type SlaState = 'ok' | 'due_soon' | 'overdue' | 'closed';
export type RequestStatus = 'pending' | 'held' | 'accepted' | 'declined' | 'expired';

export interface AgentRequest {
  id: string;
  status: RequestStatus;
  agent_label: string | null;
  principal_kind: 'anonymous' | 'registered';
  service_type: string;
  requested_start: string;
  contact_name: string;
  contact_phone: string | null;
  contact_email: string | null;
  postal_code: string;
  address_line: string | null;
  description_untrusted: string | null;
  risk_flags: string[];
  area_verified: boolean;
  sla_due_at: string;
  sla_state: SlaState;
  hold_expires_at: string | null;
  expires_at: string;
  decision: string | null;
  decline_reason: string | null;
  accept_error: string | null;
  job_id: string | null;
  created_at: string;
}

export interface Activity {
  calls_24h: number; calls_7d: number; denied_7d: number; flagged_7d: number;
  requests_7d: number; accepted_7d: number; open_now: number; overdue_now: number;
}

export interface PriceItem { id: string; service_name: string; agent_published: boolean }
export type DeclineReason = 'unavailable' | 'outside_area' | 'not_offered' | 'other';
export const DECLINE_REASONS: DeclineReason[] = ['unavailable', 'outside_area', 'not_offered', 'other'];

export type SaveResult = { ok: true; settings: ConsumerAgentSettings } | { ok: false; reason: 'not_ready' | 'forbidden' | 'kill_switch_on' | 'invalid' | 'unknown' };

/** Maps a Postgres error message to a stable reason code (no raw database text reaches the UI). */
export function reasonFromError(message: string | undefined): 'not_ready' | 'forbidden' | 'kill_switch_on' | 'invalid' | 'unknown' {
  const m = message ?? '';
  if (m.includes('not_ready')) return 'not_ready';
  if (m.includes('forbidden')) return 'forbidden';
  if (m.includes('kill_switch_on')) return 'kill_switch_on';
  if (m.includes('violates check constraint') || m.includes('invalid')) return 'invalid';
  return 'unknown';
}

export function parseServiceList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 120)))].slice(0, 20);
}

export type StatusKey = 'live' | 'off' | 'killed' | 'blocked';
export function statusKey(settings: ConsumerAgentSettings, preview: Preview | null): StatusKey {
  if (settings.kill_switch) return 'killed';
  if (preview && preview.blockers.length > 0) return 'blocked';
  return settings.enabled && preview?.live ? 'live' : 'off';
}

export function publicUrls(slug: string): { profile: string; llms: string; jsonld: string; card: string; mcp: string } {
  const base = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/$/, '');
  const b = `${base}/functions/v1/consumer-agent/v1/b/${encodeURIComponent(slug)}`;
  return { profile: `${b}/profile.json`, llms: `${b}/llms.txt`, jsonld: `${b}/jsonld`, card: `${b}/agent-card.json`, mcp: `${b}/mcp` };
}

export const hasFlags = (r: Pick<AgentRequest, 'risk_flags'>): boolean => r.risk_flags.length > 0;

// ------------------------------------------------------------
export async function loadSettings(): Promise<ConsumerAgentSettings> {
  const { data, error } = await supabase.rpc('get_consumer_agent_settings');
  if (error || !data) throw new Error(error?.message ?? 'settings_unavailable');
  return data as ConsumerAgentSettings;
}

export async function saveSettings(patch: SettingsPatch): Promise<SaveResult> {
  const { data, error } = await supabase.rpc('update_consumer_agent_settings', { p: patch });
  if (error) return { ok: false, reason: reasonFromError(error.message) };
  return { ok: true, settings: data as ConsumerAgentSettings };
}

export async function setKillSwitch(on: boolean): Promise<SaveResult> {
  const { data, error } = await supabase.rpc('consumer_agent_set_kill_switch', { p_on: on });
  if (error) return { ok: false, reason: reasonFromError(error.message) };
  return { ok: true, settings: data as ConsumerAgentSettings };
}

export async function loadPreview(): Promise<Preview> {
  const { data, error } = await supabase.rpc('consumer_agent_preview');
  if (error || !data) throw new Error(error?.message ?? 'preview_unavailable');
  return data as Preview;
}

export async function loadRequests(limit = 50): Promise<AgentRequest[]> {
  const { data, error } = await supabase.rpc('list_consumer_agent_requests', { p_status: null, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentRequest[];
}

export async function loadActivity(): Promise<Activity> {
  const { data, error } = await supabase.rpc('consumer_agent_activity');
  if (error || !data) throw new Error(error?.message ?? 'activity_unavailable');
  return data as Activity;
}

export async function decideRequest(id: string, action: 'accept' | 'decline', reason?: DeclineReason): Promise<{ ok: true } | { ok: false; code: string }> {
  const { data, error } = await supabase.rpc('decide_consumer_agent_request', { p_id: id, p_action: action, p_decline_reason: reason ?? null });
  if (error) return { ok: false, code: reasonFromError(error.message) };
  const res = data as { ok?: boolean; error?: string } | null;
  return res?.ok ? { ok: true } : { ok: false, code: res?.error ?? 'unknown' };
}

export async function loadPriceItems(ownerId: string): Promise<PriceItem[]> {
  const { data, error } = await supabase.from('price_book_items').select('id, service_name, agent_published')
    .eq('user_id', ownerId).eq('active', true).order('sort_order').order('service_name').limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as PriceItem[];
}

export async function setPricePublished(id: string, published: boolean): Promise<boolean> {
  const { error } = await supabase.from('price_book_items').update({ agent_published: published }).eq('id', id);
  return !error;
}
