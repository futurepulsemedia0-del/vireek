// Supabase access for Regional Packs. Every function throws an Error whose message is safe to show.
// Tenant scoping and write permission are enforced in SQL (migration 20271021000000_regional_packs.sql).
import { supabase } from '@/lib/supabase';
import { getAccountOwnerId } from '@/lib/salesTaxApi';
import { PACK_CODES, type PackCode, type TaxRegistration, type TaxScheme } from '@/lib/regionalPacks/packTypes';
import type { CustomClosure } from '@/lib/regionalPacks/packHolidays';
import { parsePortabilityPackage, type ConsentEvidence, type PortabilityPackage } from '@/lib/regionalPacks/packPrivacy';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new Error('You need the “edit business profile” permission for this.');
  if (error?.code === '23505') throw new Error('That entry already exists.');
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

/* ------------------------------ packs ------------------------------- */

export async function fetchEnabledPacks(): Promise<PackCode[]> {
  const { data, error } = await supabase.from('regional_pack_enablements').select('pack_code, enabled').eq('enabled', true);
  if (error) fail(error, 'Could not load regional packs.');
  return ((data ?? []) as { pack_code: PackCode }[]).map((r) => r.pack_code).filter((c) => PACK_CODES.includes(c));
}

export async function setRegionalPack(pack: PackCode, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_regional_pack', { p_pack: pack, p_enabled: enabled });
  if (error) fail(error, `Could not ${enabled ? 'enable' : 'disable'} the pack.`);
}

/* --------------------------- tax registrations ---------------------- */

export interface TaxRegistrationRow extends TaxRegistration {
  id: string;
  legalName: string | null;
}
interface RegDb {
  id: string; scheme: TaxScheme; country: string; subdivision: string | null; registration_number: string;
  legal_name: string | null; valid_from: string | null; valid_to: string | null; status: 'active' | 'pending' | 'deregistered';
}
const REG_COLS = 'id, scheme, country, subdivision, registration_number, legal_name, valid_from, valid_to, status';
const fromDb = (r: RegDb): TaxRegistrationRow => ({
  id: r.id, scheme: r.scheme, country: r.country, subdivision: r.subdivision, number: r.registration_number,
  legalName: r.legal_name, validFrom: r.valid_from, validTo: r.valid_to, status: r.status,
});

export async function fetchTaxRegistrations(): Promise<TaxRegistrationRow[]> {
  const { data, error } = await supabase.from('tax_registrations').select(REG_COLS).order('country').order('scheme');
  if (error) fail(error, 'Could not load tax registrations.');
  return ((data ?? []) as RegDb[]).map(fromDb);
}

export interface TaxRegistrationInput {
  id?: string;
  scheme: TaxScheme; country: string; subdivision?: string | null; number: string;
  legalName?: string | null; validFrom?: string | null; validTo?: string | null; status?: 'active' | 'pending' | 'deregistered';
}

export async function saveTaxRegistration(i: TaxRegistrationInput): Promise<void> {
  const row = {
    scheme: i.scheme, country: i.country.toUpperCase(), subdivision: i.subdivision?.toUpperCase() || null,
    registration_number: i.number.trim(), legal_name: i.legalName?.trim() || null,
    valid_from: i.validFrom || null, valid_to: i.validTo || null, status: i.status ?? 'active',
  };
  const { error } = i.id
    ? await supabase.from('tax_registrations').update(row).eq('id', i.id)
    : await supabase.from('tax_registrations').insert(row);
  if (error) fail(error, 'Could not save the registration.');
}

export async function deleteTaxRegistration(id: string): Promise<void> {
  const { error } = await supabase.from('tax_registrations').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the registration.');
}

/* ------------------------------ closures ---------------------------- */

export interface ClosureRow extends CustomClosure { id: string; country: string; name: string }

export async function fetchClosures(country: string): Promise<ClosureRow[]> {
  const { data, error } = await supabase
    .from('regional_custom_closures').select('id, country, closure_date, name, closed').eq('country', country.toUpperCase()).order('closure_date');
  if (error) fail(error, 'Could not load custom closures.');
  return ((data ?? []) as { id: string; country: string; closure_date: string; name: string; closed: boolean }[])
    .map((r) => ({ id: r.id, country: r.country, date: r.closure_date, name: r.name, closed: r.closed }));
}

export async function addClosure(country: string, date: string, name: string, closed: boolean): Promise<void> {
  const { error } = await supabase.from('regional_custom_closures').insert({ country: country.toUpperCase(), closure_date: date, name: name.trim(), closed });
  if (error) fail(error, 'Could not save the closure.');
}

export async function deleteClosure(id: string): Promise<void> {
  const { error } = await supabase.from('regional_custom_closures').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the closure.');
}

/* ------------------------------ privacy ----------------------------- */

export interface CustomerHit { id: string; name: string; email: string | null }

export async function searchCustomers(query: string): Promise<CustomerHit[]> {
  const q = query.trim().replace(/[%,()]/g, ' ').slice(0, 60);
  if (q.length < 2) return [];
  const { data, error } = await supabase.from('customers').select('id, name, email').or(`name.ilike.%${q}%,email.ilike.%${q}%`).limit(8);
  if (error) fail(error, 'Customer search failed.');
  return (data ?? []) as CustomerHit[];
}

export async function exportCustomerData(customerId: string): Promise<PortabilityPackage> {
  const { data, error } = await supabase.rpc('export_customer_personal_data', { p_customer_id: customerId });
  if (error) fail(error, 'Could not build the export.');
  return parsePortabilityPackage(data);
}

export interface ErasurePreview { counts: Record<string, number>; invoiced_jobs: number; last_invoice_on: string | null }

export async function fetchErasurePreview(customerId: string): Promise<ErasurePreview> {
  const { data, error } = await supabase.rpc('regional_erasure_preview', { p_customer_id: customerId });
  if (error) fail(error, 'Could not preview the erasure.');
  const d = (data ?? {}) as Partial<ErasurePreview>;
  return { counts: d.counts ?? {}, invoiced_jobs: Number(d.invoiced_jobs ?? 0), last_invoice_on: d.last_invoice_on ?? null };
}

export interface CustomerConsent extends ConsentEvidence { id: string; regime: string | null; basis: string | null }

export async function fetchCustomerConsents(customerId: string): Promise<CustomerConsent[]> {
  const { data, error } = await supabase
    .from('consent_records').select('id, consent_type, granted, created_at, expires_at, regime, basis')
    .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100);
  if (error) fail(error, 'Could not load consent records.');
  return (data ?? []) as CustomerConsent[];
}

/** Appends a consent event (the ledger is append-only: withdrawal = a new row with granted=false). */
export async function recordRegionalConsent(p: {
  customerId: string; channel: 'email' | 'sms'; granted: boolean; regime: string; basis: 'express' | 'withdrawn';
  source?: 'manual' | 'web_form' | 'import'; policyVersion?: string; notes?: string;
}): Promise<void> {
  const userId = await getAccountOwnerId();
  const { error } = await supabase.from('consent_records').insert({
    user_id: userId, customer_id: p.customerId, consent_type: p.channel === 'email' ? 'marketing_email' : 'marketing_sms',
    granted: p.granted, source: p.source ?? 'manual', regime: p.regime, basis: p.basis,
    policy_version: p.policyVersion ?? null, notes: p.notes ?? null,
  });
  if (error) fail(error, 'Could not record consent.');
}

/** Browser download helper for the portability bundle. */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
