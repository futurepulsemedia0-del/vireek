// Recreated: verify against original intent
// src/lib/homePassportNetwork.ts
//
// Client for the universal Home Passport network (migration 20270410000000_universal_home_passport_network.sql).
// Every call is a SECURITY DEFINER RPC that derives the caller's company from the session, so nothing here is
// the authority on access: scopes, verification and ownership are enforced in the database.
// (The older single-company passport lives in homePassport.ts / homePassportApi.ts and is a different feature.)

import { supabase } from '@/lib/supabase';

export const PASSPORT_SCOPES = ['identity', 'equipment', 'service', 'permits', 'warranty', 'risks', 'evidence'] as const;
export type PassportScope = (typeof PASSPORT_SCOPES)[number];

export const SCOPE_LABELS: Record<PassportScope, string> = {
  identity: 'Address & identity',
  equipment: 'Equipment',
  service: 'Service history',
  permits: 'Permits',
  warranty: 'Warranty',
  risks: 'Property risks',
  evidence: 'Documents & evidence',
};

export const EVENT_TYPES = [
  'service_visit', 'repair', 'inspection', 'failure', 'outcome', 'note',
  'installation', 'permit', 'warranty_event', 'document',
] as const;
export type ManualEventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<string, string> = {
  registered: 'Registered', ownership_change: 'Ownership change', access_change: 'Access change', correction: 'Correction',
  installation: 'Installation', equipment_linked: 'Equipment linked', service_visit: 'Service visit', repair: 'Repair',
  inspection: 'Inspection', failure: 'Failure', outcome: 'Outcome', note: 'Note', permit: 'Permit',
  warranty_event: 'Warranty event', risk_assessment: 'Risk assessment', document: 'Document',
};

export interface PassportListItem {
  passport_id: string;
  code: string | null;
  status: string;
  address_line: string | null;
  city: string | null;
  region: string | null;
  property_type: string | null;
  site_id: string | null;
  site_name: string | null;
  customer_name: string | null;
  role: string;
  verified: boolean;
  verified_via: string | null;
  scopes: PassportScope[];
  linked_at: string;
  show_contractor_publicly: boolean;
  event_count: number | null;
  last_event_at: string | null;
  last_service_at: string | null;
}

export interface SitePassportState {
  has_passport: boolean;
  verified?: boolean;
  code?: string | null;
  event_count?: number | null;
  last_event_at?: string | null;
}

export interface PassportEventProvenance {
  source_type: string;
  source_ref: string | null;
  confidence: number;
  verification_level: string;
  evidence_count: number;
  evidence_digest: string | null;
  confirmations: number;
  disputes: number;
  my_stance: 'confirm' | 'dispute' | null;
}

export interface PassportEvent {
  id: string;
  seq: number;
  event_type: string;
  scope: PassportScope;
  title: string;
  detail: string | null;
  occurred_at: string;
  recorded_at: string;
  contributor_name: string | null;
  is_mine: boolean;
  visibility: 'network' | 'restricted';
  entry_hash: string;
  superseded: boolean;
  provenance: PassportEventProvenance;
}

export interface PassportEquipmentItem {
  code: string | null;
  equipment_type: string | null;
  make: string | null;
  model: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  status: string;
  linked_at: string;
}

export interface PassportDetail {
  found: boolean;
  access?: 'member' | 'public';
  passport?: {
    code: string; status: string; property_type: string | null; city: string | null; region: string | null;
    country_code: string | null; year_built: number | null; created_at: string; address_line?: string | null; postal_code?: string | null;
  };
  link?: { role: string; verified: boolean; verified_via: string | null; scopes: PassportScope[]; show_contractor_publicly: boolean; site_id: string | null } | null;
  scopes?: PassportScope[];
  stats?: {
    event_count: number; contributor_count: number; service_count: number; evidence_backed_count: number;
    first_event_at: string | null; last_event_at: string | null; last_service_at: string | null; avg_confidence: number | null; equipment_count: number;
  };
  integrity?: unknown;
  equipment?: PassportEquipmentItem[];
  events?: PassportEvent[];
  risks?: Array<{ layer: string; status: string; source: string | null; confidence: number | null; as_of: string | null }>;
}

export interface PassportGrant {
  id: string;
  label: string | null;
  scopes: PassportScope[];
  consent_basis: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked_at: string | null;
  created_at: string;
  state: 'active' | 'revoked' | 'expired' | 'used';
}

const MESSAGES: Record<string, string> = {
  HOMEPASSPORT_UNAUTHORIZED: 'Please sign in again.',
  HOMEPASSPORT_FORBIDDEN: 'Your company is not verified for this passport.',
  HOMEPASSPORT_NOT_FOUND: 'No passport matches that code.',
  HOMEPASSPORT_RETIRED: 'This passport has been replaced or retired.',
  HOMEPASSPORT_SITE_NOT_FOUND: 'That site was not found.',
  HOMEPASSPORT_NO_SITE: 'Link a site first.',
  HOMEPASSPORT_RATE_LIMITED: 'Too many attempts. Wait a little and try again.',
  HOMEPASSPORT_CONFLICT: 'That conflicts with the current passport. Refresh and try again.',
  HOMEPASSPORT_IMMUTABLE: 'Passport history cannot be edited. Add a correction instead.',
  HOMEPASSPORT_GRANT_INVALID: 'That access link is not valid.',
  HOMEPASSPORT_INVALID: 'Please check what you entered.',
};

/** Turns the database's HOMEPASSPORT_* error into plain English. Anything unknown stays generic. */
export function passportErrorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const raw = (err as { message?: string })?.message ?? '';
  const m = raw.match(/HOMEPASSPORT_[A-Z_]+/);
  if (!m) return fallback;
  const detail = raw.split(`${m[0]}:`)[1]?.trim();
  if (m[0] === 'HOMEPASSPORT_INVALID' && detail) return detail.slice(0, 200);
  return MESSAGES[m[0]] ?? fallback;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const normalizeCode = (raw: string): string => raw.trim().toUpperCase().replace(/\s+/g, '');

export const listPassports = () => rpc<PassportListItem[]>('list_home_passports');
export const getPassportForSite = (siteId: string) => rpc<SitePassportState>('get_home_passport_for_site', { p_site_id: siteId });
export const issuePassport = (siteId: string) => rpc<SitePassportState>('issue_home_passport', { p_site_id: siteId });
export const claimPassport = (code: string, siteId?: string | null) => rpc<PassportDetail>('claim_home_passport', { p_code: normalizeCode(code), p_site_id: siteId ?? null });
export const getPassport = (code: string) => rpc<PassportDetail>('get_home_passport', { p_code: normalizeCode(code) });
export const syncPassport = (code: string) => rpc<{ jobs_scanned: number; events_added: number }>('sync_home_passport', { p_code: normalizeCode(code) });
export const setPassportSharing = (code: string, showContractor: boolean) => rpc<void>('set_home_passport_sharing', { p_code: normalizeCode(code), p_show_contractor: showContractor });
export const attestEvent = (eventId: string, stance: 'confirm' | 'dispute', note?: string) =>
  rpc<unknown>('attest_home_passport_event', { p_event_id: eventId, p_stance: stance, p_note: note?.trim() || null });
export const addPassportEvent = (i: { code: string; type: ManualEventType; title: string; detail?: string; occurredAt?: string; restricted?: boolean }) =>
  rpc<string>('add_home_passport_event', {
    p_code: normalizeCode(i.code), p_type: i.type, p_title: i.title.trim(), p_detail: i.detail?.trim() || null,
    p_occurred_at: i.occurredAt ?? null, p_restricted: i.restricted ?? false, p_evidence_count: 0, p_source_ref: null,
  });
export const listGrants = (code: string) => rpc<PassportGrant[]>('list_home_passport_grants', { p_code: normalizeCode(code) });
export const createGrant = (i: { code: string; scopes: PassportScope[]; ttlHours: number; label?: string; maxUses: number }) =>
  rpc<{ id: string; token: string; expires_at: string; scopes: PassportScope[] }>('create_home_passport_grant', {
    p_code: normalizeCode(i.code), p_scopes: i.scopes, p_ttl_hours: i.ttlHours, p_label: i.label?.trim() || null, p_max_uses: i.maxUses, p_consent_basis: 'homeowner_consent',
  });
export const revokeGrant = (id: string) => rpc<void>('revoke_home_passport_grant', { p_grant_id: id });
