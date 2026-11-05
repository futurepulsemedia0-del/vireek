/**
 * Mass Incident Mode — client library.
 *
 * Reads incidents / contacts / evidence through RLS (SELECT only) and performs every write through the
 * permission-checked RPCs defined in supabase/migrations/20281103000000_mass_incident_mode.sql.
 * Clustering, scoring and honest-triage rules live in the shared pure core and are re-exported here.
 */

import { supabase } from '@/lib/supabase';
import type {
  CauseStatus,
  IncidentScope,
  IncidentStatus,
  SuspectedCause,
  SymptomClass,
  DirectoryService,
} from '../../supabase/functions/_shared/mass-incident/core';

export * from '../../supabase/functions/_shared/mass-incident/core';

export interface IncidentRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  status: IncidentStatus;
  title: string;
  symptom_class: SymptomClass;
  scope: IncidentScope;
  confidence: number;
  confidence_breakdown: Record<string, number>;
  suspected_cause: SuspectedCause;
  cause_status: CauseStatus;
  cause_confidence: number;
  cause_uncertainty: string;
  cause_basis: string[];
  alternatives: Array<{ cause: SuspectedCause; confidence: number }>;
  member_count: number;
  emergency_count: number;
  first_contact_at: string;
  last_contact_at: string;
  owner_confirmed_cause: SuspectedCause | null;
  resolved_at: string | null;
  resolution_note: string | null;
  updated_at: string;
}

export interface ContactRow {
  [key: string]: unknown;
  id: string;
  incident_id: string | null;
  source: 'call' | 'sms' | 'lead' | 'manual';
  call_id: string | null;
  contact_phone: string | null;
  contact_at: string;
  postal_code: string | null;
  geo_precision: 'address' | 'postal' | 'none';
  symptom_class: SymptomClass;
  symptom_text: string;
  is_emergency: boolean;
  hazards: string[];
  triage_decision: 'escalate_emergency' | 'upstream_likely' | 'book_normally' | null;
  detached: boolean;
  job_id: string | null;
}

export interface SignalRow {
  id: string;
  kind: 'weather_alert' | 'utility_outage' | 'municipal_notice' | 'manual';
  source: 'nws' | 'owner_entered';
  headline: string;
  area_desc: string | null;
  postal_codes: string[];
  source_url: string | null;
  verified: boolean;
  expires_at: string | null;
}

export interface DirectoryRow {
  id: string;
  user_id: string | null;
  country: string;
  region: string | null;
  postal_prefix: string | null;
  service: DirectoryService;
  name: string;
  phone: string | null;
  website: string | null;
  source_url: string;
  verified_at: string;
  verified_by: string;
  status: 'verified' | 'stale' | 'retired';
  notes: string | null;
}

export interface SettingsRow {
  enabled: boolean;
  window_minutes: number;
  radius_miles: number;
  min_contacts: number;
  notify_owner: boolean;
  auto_reply_sms: boolean;
}

export const DEFAULT_SETTINGS: SettingsRow = { enabled: false, window_minutes: 120, radius_miles: 3, min_contacts: 3, notify_owner: true, auto_reply_sms: false };

const INCIDENT_COLS =
  'id, user_id, status, title, symptom_class, scope, confidence, confidence_breakdown, suspected_cause, cause_status, cause_confidence, cause_uncertainty, cause_basis, alternatives, member_count, emergency_count, first_contact_at, last_contact_at, owner_confirmed_cause, resolved_at, resolution_note, updated_at';
const CONTACT_COLS =
  'id, incident_id, source, call_id, contact_phone, contact_at, postal_code, geo_precision, symptom_class, symptom_text, is_emergency, hazards, triage_decision, detached, job_id';

export class MassIncidentError extends Error {
  constructor(message: string, readonly code: 'forbidden' | 'not_found' | 'rate_limited' | 'invalid' | 'unknown') {
    super(message);
  }
}

function mapError(e: { code?: string; message?: string; status?: number } | null): MassIncidentError {
  if (e?.code === '42501' || e?.status === 403) return new MassIncidentError('forbidden', 'forbidden');
  if (e?.code === 'P0002' || e?.status === 404) return new MassIncidentError('not_found', 'not_found');
  if (e?.status === 429) return new MassIncidentError('rate_limited', 'rate_limited');
  if (e?.code === '23514' || e?.code === 'P0001' || e?.status === 400 || e?.status === 422) return new MassIncidentError(e?.message ?? 'invalid', 'invalid');
  return new MassIncidentError(e?.message ?? 'unknown', 'unknown');
}

export async function fetchSettings(): Promise<SettingsRow> {
  const { data, error } = await supabase.from('mass_incident_settings').select('enabled, window_minutes, radius_miles, min_contacts, notify_owner, auto_reply_sms').maybeSingle();
  if (error) throw mapError(error);
  return (data as SettingsRow | null) ?? DEFAULT_SETTINGS;
}

export async function fetchIncidents(): Promise<IncidentRow[]> {
  const { data, error } = await supabase.from('mass_incidents').select(INCIDENT_COLS).order('last_contact_at', { ascending: false }).limit(200);
  if (error) throw mapError(error);
  return (data ?? []) as IncidentRow[];
}

export async function fetchContacts(incidentId: string): Promise<ContactRow[]> {
  const { data, error } = await supabase.from('mass_incident_contacts').select(CONTACT_COLS).eq('incident_id', incidentId).order('contact_at', { ascending: false }).limit(500);
  if (error) throw mapError(error);
  return (data ?? []) as ContactRow[];
}

/** Contacts that match no incident. They are never hidden: the owner can see every one. */
export async function fetchLooseContacts(): Promise<ContactRow[]> {
  const { data, error } = await supabase.from('mass_incident_contacts').select(CONTACT_COLS).is('incident_id', null).eq('detached', false)
    .gte('contact_at', new Date(Date.now() - 24 * 3_600_000).toISOString()).order('contact_at', { ascending: false }).limit(100);
  if (error) throw mapError(error);
  return (data ?? []) as ContactRow[];
}

export async function fetchSignals(): Promise<SignalRow[]> {
  const { data, error } = await supabase.from('mass_incident_signals').select('id, kind, source, headline, area_desc, postal_codes, source_url, verified, expires_at')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order('created_at', { ascending: false }).limit(50);
  if (error) throw mapError(error);
  return (data ?? []) as SignalRow[];
}

export async function fetchDirectory(): Promise<DirectoryRow[]> {
  const { data, error } = await supabase.from('mass_incident_directory')
    .select('id, user_id, country, region, postal_prefix, service, name, phone, website, source_url, verified_at, verified_by, status, notes').neq('status', 'retired').order('country').limit(500);
  if (error) throw mapError(error);
  return (data ?? []) as DirectoryRow[];
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw mapError(error);
  return data;
}

export const saveSettings = (s: SettingsRow) =>
  rpc('mass_incident_save_settings', { p_enabled: s.enabled, p_window_minutes: s.window_minutes, p_radius_miles: s.radius_miles, p_min_contacts: s.min_contacts, p_notify_owner: s.notify_owner });

export const setAutoReply = (enabled: boolean) => rpc('mass_incident_set_auto_reply', { p_enabled: enabled });

export const setIncidentStatus = (incidentId: string, status: 'active' | 'monitoring' | 'resolved' | 'dismissed', note?: string) =>
  rpc('mass_incident_set_status', { p_incident_id: incidentId, p_status: status, p_note: note ?? null });

export const confirmCause = (incidentId: string, cause: SuspectedCause) => rpc('mass_incident_confirm_cause', { p_incident_id: incidentId, p_cause: cause });
export const detachContact = (contactId: string) => rpc('mass_incident_detach_contact', { p_contact_id: contactId });

export const addNotice = (n: { kind: 'utility_outage' | 'municipal_notice' | 'manual'; headline: string; areaDesc: string; postalCodes: string[]; sourceUrl: string; corroborates: SuspectedCause[]; expiresAt: string | null }) =>
  rpc('mass_incident_add_notice', { p_kind: n.kind, p_headline: n.headline, p_area_desc: n.areaDesc, p_postal_codes: n.postalCodes, p_source_url: n.sourceUrl, p_corroborates: n.corroborates, p_expires_at: n.expiresAt });

export interface DirectoryInput {
  id: string | null; country: string; region: string; postalPrefix: string; service: DirectoryService; name: string;
  phone: string; website: string; sourceUrl: string; verifiedAt: string; verifiedBy: string; notes: string;
}
export const upsertDirectoryEntry = (d: DirectoryInput) =>
  rpc('mass_incident_directory_upsert', {
    p_id: d.id, p_country: d.country, p_region: d.region, p_postal_prefix: d.postalPrefix, p_service: d.service, p_name: d.name,
    p_phone: d.phone, p_website: d.website, p_source_url: d.sourceUrl, p_verified_at: d.verifiedAt, p_verified_by: d.verifiedBy, p_notes: d.notes,
  });
export const retireDirectoryEntry = (id: string) => rpc('mass_incident_directory_retire', { p_id: id });

export interface BroadcastPreview { eligible: number; sent: number; deferred: number; skipped: number; preview: string; dry_run: boolean }

export async function broadcast(incidentId: string, kind: 'update' | 'resolved', dryRun: boolean): Promise<BroadcastPreview> {
  const { data, error } = await supabase.functions.invoke('mass-incident', { body: { action: 'broadcast', incident_id: incidentId, kind, dry_run: dryRun } });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    throw mapError({ status, message: error.message });
  }
  return data as BroadcastPreview;
}
