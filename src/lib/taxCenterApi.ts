import { supabase } from '@/lib/supabase';
import {
  DEFAULT_TAX_SETTINGS,
  type ReportInvoiceRow,
  type TaxClass,
  type TaxExemption,
  type TaxJurisdiction,
  type TaxSettings,
} from '@/lib/taxCenter';

/**
 * Every query is filtered by the ACCOUNT OWNER's id (never the logged-in
 * user's own id — team members must read/write the owner's books). RLS
 * enforces the same rule server-side; the explicit filter keeps queries
 * indexed and makes the scoping visible at the call site.
 */

type JurisdictionInput = Omit<TaxJurisdiction, 'id' | 'source'> & { id?: string };
type ClassInput = Omit<TaxClass, 'id'> & { id?: string };
type ExemptionInput = Omit<TaxExemption, 'id'> & { id?: string };

export interface ServiceTaxRow {
  id: string;
  service_name: string;
  category: string | null;
  tax_class_id: string | null;
  active: boolean;
}

function fail(action: string, error: { message?: string } | null): never {
  throw new Error(error?.message ? `${action}: ${error.message}` : action);
}

export async function fetchTaxSettings(ownerId: string): Promise<TaxSettings> {
  const { data, error } = await supabase.from('tax_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) fail('Could not load tax settings', error);
  return data ? { ...DEFAULT_TAX_SETTINGS, ...(data as Partial<TaxSettings>) } : DEFAULT_TAX_SETTINGS;
}

export async function saveTaxSettings(ownerId: string, patch: Partial<TaxSettings>): Promise<void> {
  const { error } = await supabase.from('tax_settings').upsert({ user_id: ownerId, ...patch }, { onConflict: 'user_id' });
  if (error) fail('Could not save tax settings', error);
}

export async function fetchJurisdictions(ownerId: string): Promise<TaxJurisdiction[]> {
  const { data, error } = await supabase
    .from('tax_jurisdictions').select('*').eq('user_id', ownerId).order('state').order('level').order('name').limit(2000);
  if (error) fail('Could not load jurisdictions', error);
  return (data ?? []) as TaxJurisdiction[];
}

export async function saveJurisdiction(ownerId: string, input: JurisdictionInput): Promise<void> {
  const row = { ...input, user_id: ownerId, source: 'manual' as const };
  const { error } = input.id
    ? await supabase.from('tax_jurisdictions').update(row).eq('id', input.id).eq('user_id', ownerId)
    : await supabase.from('tax_jurisdictions').insert(row);
  if (error) fail('Could not save jurisdiction', error);
}

export async function deleteJurisdiction(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('tax_jurisdictions').delete().eq('id', id).eq('user_id', ownerId);
  if (error) fail('Could not delete jurisdiction', error);
}

export async function fetchClasses(ownerId: string): Promise<TaxClass[]> {
  const { data, error } = await supabase.from('tax_classes').select('*').eq('user_id', ownerId).order('name');
  if (error) fail('Could not load tax classes', error);
  return (data ?? []) as TaxClass[];
}

export async function saveClass(ownerId: string, input: ClassInput): Promise<void> {
  const row = { ...input, user_id: ownerId };
  const { error } = input.id
    ? await supabase.from('tax_classes').update(row).eq('id', input.id).eq('user_id', ownerId)
    : await supabase.from('tax_classes').insert(row);
  if (error) {
    if (error.message?.includes('idx_tax_classes_user_name')) throw new Error('A tax class with that name already exists');
    fail('Could not save tax class', error);
  }
}

export async function deleteClass(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('tax_classes').delete().eq('id', id).eq('user_id', ownerId);
  if (error) fail('Could not delete tax class', error);
}

export async function fetchExemptions(ownerId: string): Promise<TaxExemption[]> {
  const { data, error } = await supabase.from('tax_exemptions').select('*').eq('user_id', ownerId).order('customer_name').limit(2000);
  if (error) fail('Could not load exemptions', error);
  return (data ?? []) as TaxExemption[];
}

export async function saveExemption(ownerId: string, input: ExemptionInput): Promise<void> {
  const row = { ...input, user_id: ownerId };
  const { error } = input.id
    ? await supabase.from('tax_exemptions').update(row).eq('id', input.id).eq('user_id', ownerId)
    : await supabase.from('tax_exemptions').insert(row);
  if (error) fail('Could not save exemption', error);
}

export async function deleteExemption(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('tax_exemptions').delete().eq('id', id).eq('user_id', ownerId);
  if (error) fail('Could not delete exemption', error);
}

export async function fetchServiceTaxRows(ownerId: string): Promise<ServiceTaxRow[]> {
  const { data, error } = await supabase
    .from('price_book_items').select('id, service_name, category, tax_class_id, active')
    .eq('user_id', ownerId).order('service_name').limit(2000);
  if (error) fail('Could not load services', error);
  return (data ?? []) as ServiceTaxRow[];
}

export async function setServiceTaxClass(ownerId: string, itemId: string, classId: string | null): Promise<void> {
  const { error } = await supabase.from('price_book_items').update({ tax_class_id: classId }).eq('id', itemId).eq('user_id', ownerId);
  if (error) fail('Could not update service tax class', error);
}

export async function fetchReportInvoices(from: string, to: string): Promise<ReportInvoiceRow[]> {
  const { data, error } = await supabase.rpc('get_tax_report_invoices', { p_from: from, p_to: to });
  if (error) fail('Could not load invoices for the report', error);
  return (data ?? []) as ReportInvoiceRow[];
}

/* --------------------- provider adapter (TaxJar) --------------------- */

export interface TaxProviderAdapter {
  id: 'taxjar';
  connect(apiKey: string): Promise<void>;
  syncRates(postalCodes: string[]): Promise<{ synced: number; skipped: string[] }>;
  disconnect(): Promise<void>;
}

async function invokeTaxJar<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tax-taxjar', { body });
  if (error) {
    // supabase-js hides the function's JSON error body inside the context.
    let message = 'TaxJar request failed.';
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep generic message */ }
    throw new Error(message);
  }
  return data as T;
}

/** Keys never travel back to the browser: they are validated and stored by the edge function. */
export const taxJarAdapter: TaxProviderAdapter = {
  id: 'taxjar',
  async connect(apiKey) {
    await invokeTaxJar({ action: 'connect', api_key: apiKey });
  },
  async syncRates(postalCodes) {
    return invokeTaxJar<{ synced: number; skipped: string[] }>({ action: 'sync_rates', postal_codes: postalCodes });
  },
  async disconnect() {
    await invokeTaxJar({ action: 'disconnect' });
  },
};

export interface CustomerOption { id: string; name: string }

export async function fetchCustomerOptions(ownerId: string): Promise<CustomerOption[]> {
  const { data, error } = await supabase.from('customers').select('id, name').eq('user_id', ownerId).order('name').limit(500);
  if (error) fail('Could not load customers', error);
  return (data ?? []) as CustomerOption[];
}
