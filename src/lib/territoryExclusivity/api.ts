// src/lib/territoryExclusivity/api.ts - thin client. All authorisation, locking and conflict checks are enforced in the database.
import { supabase } from '@/lib/supabase';
import type { Conflict, LatLng, ZoneType } from './core';

export interface ShapeInput { trade: string; zoneType: ZoneType; zipCodes: string[]; polygon: LatLng[] | null }
export interface TermInput {
  termStart: string; termEnd: string; autoRenew?: boolean; renewalNoticeDays?: number | null; renewalTermMonths?: number | null;
  contractReference?: string; feeCents?: number | null; feeCurrency?: string; legalTermsRef?: string; notes?: string;
}

export interface StaffTerritory {
  id: string; account_owner_id: string; account_name: string; trade: string; label: string; zone_type: ZoneType; zip_codes: string[]; polygon_points: number | null;
  status: 'draft' | 'active' | 'suspended' | 'ended'; term_start: string; term_end: string; auto_renew: boolean; renewal_notice_days: number | null;
  renewal_term_months: number | null; contract_reference: string | null; fee_cents: number | null; fee_currency: string | null; legal_terms_ref: string | null;
  notes: string | null; ended_at: string | null; ended_reason: string | null; days_left: number;
}
export interface StaffWait {
  id: string; account_owner_id: string; account_name: string; trade: string; label: string; zone_type: ZoneType; zip_codes: string[];
  status: 'waiting' | 'offered' | 'accepted'; offered_at: string | null; offer_expires_at: string | null; created_at: string; available_now: boolean;
}
export interface AuditRow { id: number; occurred_at: string; actor_kind: string; actor_email: string | null; account_name: string; action: string; reason: string | null; details: Record<string, unknown> }

export function friendlyTerritoryError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '42501') return e.message?.includes('staff') ? 'Vireek staff only.' : e.message || 'You do not have permission for this.';
  if (e?.code && ['P0001', '22023', 'P0002', '54000', '23514', '23505'].includes(e.code)) return e.message || 'The values are not allowed.';
  return 'Something went wrong. Please try again.';
}

const shapeBody = (s: ShapeInput) => ({ trade: s.trade, zone_type: s.zoneType, zip_codes: s.zipCodes, polygon: s.polygon });
const termBody = (t: TermInput) => ({
  term_start: t.termStart, term_end: t.termEnd, auto_renew: t.autoRenew ?? false, renewal_notice_days: t.renewalNoticeDays ?? null, renewal_term_months: t.renewalTermMonths ?? null,
  contract_reference: t.contractReference ?? null, fee_cents: t.feeCents ?? null, fee_currency: t.feeCurrency ? t.feeCurrency.toUpperCase() : null,
  legal_terms_ref: t.legalTermsRef ?? null, notes: t.notes ?? null,
});

/* ---------------- staff ---------------- */
export async function staffOverview(): Promise<{ exclusivities: StaffTerritory[]; waitlist: StaffWait[] }> {
  const { data, error } = await supabase.rpc('territory_staff_overview');
  if (error) throw error;
  return data as { exclusivities: StaffTerritory[]; waitlist: StaffWait[] };
}
export async function staffCheck(s: ShapeInput, t: Pick<TermInput, 'termStart' | 'termEnd'>, excludeId?: string): Promise<Conflict[]> {
  const { data, error } = await supabase.rpc('territory_staff_check', { p: { ...shapeBody(s), term_start: t.termStart, term_end: t.termEnd, exclude_id: excludeId ?? null } });
  if (error) throw error;
  return (data as { id: string; account_owner_id: string; kind: Conflict['kind']; shared_zips: string[] }[]).map((c) => ({ id: c.id, accountId: c.account_owner_id, kind: c.kind, sharedZips: c.shared_zips }));
}
export async function staffCreate(a: { accountId: string; label: string; shape: ShapeInput; terms: TermInput; reason: string; activate: boolean; acknowledgeUnverifiable: boolean }): Promise<{ id: string; status: string }> {
  const { data, error } = await supabase.rpc('territory_staff_create', {
    p: { account_owner_id: a.accountId, label: a.label, ...shapeBody(a.shape), ...termBody(a.terms), reason: a.reason, activate: a.activate, acknowledge_unverifiable: a.acknowledgeUnverifiable },
  });
  if (error) throw error;
  return data as { id: string; status: string };
}
export async function staffSetStatus(id: string, status: 'active' | 'suspended' | 'ended', reason: string, acknowledgeUnverifiable = false): Promise<{ waitlist_offered: string[] }> {
  const { data, error } = await supabase.rpc('territory_staff_set_status', { p_id: id, p_status: status, p_reason: reason, p_acknowledge_unverifiable: acknowledgeUnverifiable });
  if (error) throw error;
  return data as { waitlist_offered: string[] };
}
export async function staffUpdateTerms(id: string, t: TermInput, reason: string): Promise<void> {
  const { error } = await supabase.rpc('territory_staff_update_terms', { p_id: id, p: termBody(t), p_reason: reason });
  if (error) throw error;
}
export async function staffWaitlistOffer(trade: string): Promise<{ expired_terms: number; offered: string[] }> {
  const { data, error } = await supabase.rpc('territory_staff_waitlist_offer', { p_trade: trade });
  if (error) throw error;
  return data as { expired_terms: number; offered: string[] };
}
export async function staffActivateFromWaitlist(waitlistId: string, t: TermInput, reason: string): Promise<{ id: string }> {
  const { data, error } = await supabase.rpc('territory_staff_activate_from_waitlist', { p_waitlist_id: waitlistId, p: { ...termBody(t), reason } });
  if (error) throw error;
  return data as { id: string };
}
export async function staffAudit(limit = 200): Promise<AuditRow[]> {
  const { data, error } = await supabase.rpc('territory_staff_audit', { p_limit: limit });
  if (error) throw error;
  return data as AuditRow[];
}

/* ---------------- account ---------------- */
export interface MyTerritory { id: string; trade: string; label: string; zone_type: ZoneType; zip_codes: string[]; status: 'draft' | 'active' | 'suspended' | 'ended'; term_start: string; term_end: string; auto_renew: boolean; contract_reference: string | null }
export interface MyWait { id: string; trade: string; label: string; zone_type: ZoneType; zip_codes: string[]; status: string; offered_at: string | null; offer_expires_at: string | null; created_at: string }
export async function fetchMyTerritories(): Promise<{ territories: MyTerritory[]; waitlist: MyWait[] }> {
  const [t, w] = await Promise.all([
    supabase.from('territory_exclusivities').select('id, trade, label, zone_type, zip_codes, status, term_start, term_end, auto_renew, contract_reference').neq('status', 'draft').order('term_start', { ascending: false }),
    supabase.from('territory_waitlist').select('id, trade, label, zone_type, zip_codes, status, offered_at, offer_expires_at, created_at').in('status', ['waiting', 'offered', 'accepted']).order('created_at'),
  ]);
  if (t.error) throw t.error;
  if (w.error) throw w.error;
  return { territories: (t.data ?? []) as MyTerritory[], waitlist: (w.data ?? []) as MyWait[] };
}
export async function joinWaitlist(label: string, s: ShapeInput): Promise<void> {
  const { error } = await supabase.rpc('territory_waitlist_join', { p: { label, ...shapeBody(s) } });
  if (error) throw error;
}
export async function cancelWaitlist(id: string): Promise<void> {
  const { error } = await supabase.rpc('territory_waitlist_cancel', { p_id: id });
  if (error) throw error;
}
export async function respondToOffer(id: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('territory_waitlist_respond', { p_id: id, p_accept: accept });
  if (error) throw error;
}
export async function marketingGuard(trade: string, zips: string[]): Promise<{ checked: number; blocked_zips: string[] }> {
  const { data, error } = await supabase.rpc('territory_marketing_guard', { p_trade: trade, p_zips: zips });
  if (error) throw error;
  return data as { checked: number; blocked_zips: string[] };
}
