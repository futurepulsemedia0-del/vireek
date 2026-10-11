import { supabase } from '@/lib/supabase';
import {
  normalizeAddress,
  normalizeState,
  normalizeZip,
  type ExemptionStatus,
  type ExemptionType,
  type RateImportRow,
  type ServiceAddress,
  type TaxClass,
  type TaxExemption,
  type TaxExemptSaleRow,
  type TaxJurisdictionRow,
  type TaxLevel,
  type TaxRateComponent,
  type TaxSettings,
  type TaxSummaryRow,
} from '@/lib/salesTax';

// ------------------------------------------------------------------ helpers

let ownerIdPromise: Promise<string> | null = null;

/** The account owner's id (team members write under their owner). Cached for the session. */
export function getAccountOwnerId(): Promise<string> {
  if (!ownerIdPromise) {
    ownerIdPromise = (async () => {
      const { data, error } = await supabase.rpc('get_account_owner_id');
      if (error || !data) throw error ?? new Error('Could not resolve the account.');
      return data as string;
    })().catch((e) => {
      ownerIdPromise = null;
      throw e;
    });
  }
  return ownerIdPromise;
}

const num = (v: unknown) => Number(v) || 0;

// ------------------------------------------------------------------- rates

interface RateLookupRow {
  rate_id: string;
  jurisdiction_level: TaxLevel;
  jurisdiction_name: string;
  rate_percent: number | string;
  source: string;
  is_account_rate: boolean;
  verified_at: string | null;
  updated_at: string | null;
}

/** Resolves a service address to rate components (state + county + city + district). */
export async function lookupTaxRates(address: Partial<ServiceAddress>, onDate?: string): Promise<TaxRateComponent[]> {
  const state = normalizeState(address.state);
  const zip = normalizeZip(address.postal_code);
  if (!state || !zip) return [];
  const { data, error } = await supabase.rpc('lookup_tax_rates', {
    p_state: state,
    p_postal_code: zip,
    p_city: address.city?.trim() || null,
    p_county: address.county?.trim() || null,
    p_on_date: onDate ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw error;
  return ((data as RateLookupRow[]) ?? []).map((r) => ({
    id: r.rate_id,
    level: r.jurisdiction_level,
    name: r.jurisdiction_name,
    ratePercent: num(r.rate_percent),
    source: r.source,
    isAccountRate: r.is_account_rate,
    verifiedAt: r.verified_at,
    updatedAt: r.updated_at,
  }));
}

export interface TaxRateRow {
  id: string;
  user_id: string | null;
  state: string;
  county: string | null;
  city: string | null;
  postal_code: string | null;
  jurisdiction_level: TaxLevel;
  jurisdiction_name: string;
  rate_percent: number;
  effective_from: string;
  effective_to: string | null;
  source: 'reference' | 'manual' | 'import' | 'provider';
  verified_at: string | null;
  updated_at: string;
}

export async function fetchTaxRates(state?: string): Promise<TaxRateRow[]> {
  let query = supabase
    .from('tax_rates')
    .select('*')
    .order('state')
    .order('jurisdiction_level')
    .order('jurisdiction_name')
    .limit(2000);
  if (state) query = query.eq('state', state);
  const { data, error } = await query;
  if (error) throw error;
  return ((data as TaxRateRow[]) ?? []).map((r) => ({ ...r, rate_percent: num(r.rate_percent) }));
}

export interface TaxRateInput {
  id?: string;
  state: string;
  jurisdiction_level: TaxLevel;
  jurisdiction_name: string;
  rate_percent: number;
  county?: string;
  city?: string;
  postal_code?: string;
  effective_from?: string;
}

export async function saveTaxRate(input: TaxRateInput): Promise<void> {
  const state = normalizeState(input.state);
  if (!state) throw new Error('Choose a valid state.');
  if (!input.jurisdiction_name.trim()) throw new Error('Name the jurisdiction.');
  if (!(input.rate_percent >= 0 && input.rate_percent <= 25)) throw new Error('Rate must be between 0% and 25%.');
  const zip = input.postal_code?.trim();
  if (zip && !/^\d{5}$/.test(zip)) throw new Error('ZIP must be 5 digits.');

  const row = {
    state,
    jurisdiction_level: input.jurisdiction_level,
    jurisdiction_name: input.jurisdiction_name.trim(),
    rate_percent: input.rate_percent,
    county: input.county?.trim() || null,
    city: input.city?.trim() || null,
    postal_code: zip || null,
    effective_from: input.effective_from || '2000-01-01',
    source: 'manual' as const,
    verified_at: new Date().toISOString(),
  };
  const { error } = input.id
    ? await supabase.from('tax_rates').update(row).eq('id', input.id)
    : await supabase.from('tax_rates').insert(row);
  if (error) throw error.code === '23505' ? new Error('That rate already exists for this jurisdiction and start date.') : error;
}

export async function deleteTaxRate(id: string): Promise<void> {
  const { error } = await supabase.from('tax_rates').delete().eq('id', id);
  if (error) throw error;
}

export async function importTaxRates(rows: RateImportRow[]): Promise<number> {
  const { data, error } = await supabase.rpc('import_tax_rates', { p_rows: rows });
  if (error) throw error;
  return num(data);
}

// ---------------------------------------------------------------- settings

export async function fetchTaxSettings(): Promise<TaxSettings> {
  const { data, error } = await supabase.from('tax_settings').select('collect_in_states, rate_stale_after_days').maybeSingle();
  if (error) throw error;
  return {
    collectInStates: (data?.collect_in_states as string[] | undefined) ?? [],
    rateStaleAfterDays: (data?.rate_stale_after_days as number | undefined) ?? 180,
  };
}

export async function saveTaxSettings(settings: TaxSettings): Promise<void> {
  const user_id = await getAccountOwnerId();
  const { error } = await supabase.from('tax_settings').upsert({
    user_id,
    collect_in_states: [...new Set(settings.collectInStates.map((s) => s.toUpperCase()))].sort(),
    rate_stale_after_days: settings.rateStaleAfterDays,
  });
  if (error) throw error;
}

// ----------------------------------------------------------------- classes

interface ClassRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_taxable: boolean;
  is_system: boolean;
  sort_order: number;
}

export interface TaxClassDetail extends TaxClass {
  description: string | null;
  isSystem: boolean;
}

export async function fetchTaxClasses(): Promise<TaxClassDetail[]> {
  await supabase.rpc('ensure_default_tax_classes');
  const [classes, rules] = await Promise.all([
    supabase.from('tax_classes').select('*').order('sort_order').order('name'),
    supabase.from('tax_class_state_rules').select('tax_class_id, state, taxable'),
  ]);
  if (classes.error) throw classes.error;
  if (rules.error) throw rules.error;

  const byClass = new Map<string, Record<string, boolean>>();
  for (const r of (rules.data as { tax_class_id: string; state: string; taxable: boolean }[]) ?? []) {
    byClass.set(r.tax_class_id, { ...(byClass.get(r.tax_class_id) ?? {}), [r.state]: r.taxable });
  }
  return ((classes.data as ClassRow[]) ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    defaultTaxable: c.default_taxable,
    isSystem: c.is_system,
    stateRules: byClass.get(c.id) ?? {},
  }));
}

export async function saveTaxClass(input: { id?: string; code: string; name: string; description?: string; defaultTaxable: boolean }): Promise<void> {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(code)) throw new Error('Code must be 2–40 characters: lowercase letters, numbers, underscores.');
  if (!input.name.trim()) throw new Error('Give the class a name.');
  const row = { code, name: input.name.trim(), description: input.description?.trim() || null, default_taxable: input.defaultTaxable };
  const { error } = input.id
    ? await supabase.from('tax_classes').update({ name: row.name, description: row.description, default_taxable: row.default_taxable }).eq('id', input.id)
    : await supabase.from('tax_classes').insert(row);
  if (error) throw error.code === '23505' ? new Error(`A class with the code "${code}" already exists.`) : error;
  invalidateTaxClassCache();
}

export async function deleteTaxClass(id: string): Promise<void> {
  const { error } = await supabase.from('tax_classes').delete().eq('id', id);
  if (error) throw error;
  invalidateTaxClassCache();
}

/** taxable = true/false sets a per-state rule; null removes it (falls back to the class default). */
export async function setTaxClassStateRule(classId: string, state: string, taxable: boolean | null): Promise<void> {
  const code = normalizeState(state);
  if (!code) throw new Error('Choose a valid state.');
  const { error } =
    taxable === null
      ? await supabase.from('tax_class_state_rules').delete().eq('tax_class_id', classId).eq('state', code)
      : await supabase.from('tax_class_state_rules').upsert({ tax_class_id: classId, state: code, taxable }, { onConflict: 'tax_class_id,state' });
  if (error) throw error;
  invalidateTaxClassCache();
}

// Shared cache so many line-item selects trigger one request.
let classCache: Promise<TaxClassDetail[]> | null = null;
const classListeners = new Set<() => void>();

export function loadTaxClasses(): Promise<TaxClassDetail[]> {
  if (!classCache) {
    classCache = fetchTaxClasses().catch((e) => {
      classCache = null;
      throw e;
    });
  }
  return classCache;
}

export function invalidateTaxClassCache(): void {
  classCache = null;
  classListeners.forEach((fn) => fn());
}

export function onTaxClassesInvalidated(fn: () => void): () => void {
  classListeners.add(fn);
  return () => void classListeners.delete(fn);
}

// --------------------------------------------------------------- customers

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export async function searchCustomers(query: string): Promise<CustomerOption[]> {
  const q = query.trim().replace(/[%,()]/g, ' ');
  let request = supabase.from('customers').select('id, name, email, phone, address').order('name').limit(8);
  if (q) request = request.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
  const { data, error } = await request;
  if (error) throw error;
  return (data as CustomerOption[]) ?? [];
}

export async function fetchCustomerOption(id: string): Promise<CustomerOption | null> {
  const { data, error } = await supabase.from('customers').select('id, name, email, phone, address').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as CustomerOption | null) ?? null;
}

// -------------------------------------------------------------- exemptions

export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;
const CERTIFICATE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
export const CERTIFICATE_ACCEPT = Object.keys(CERTIFICATE_TYPES).join(',');

interface ExemptionRow {
  id: string;
  customer_id: string;
  exemption_type: ExemptionType;
  certificate_number: string | null;
  issuing_state: string | null;
  applies_to_states: string[];
  applies_to_classes: string[];
  issued_on: string | null;
  expires_on: string | null;
  certificate_path: string | null;
  certificate_file_name: string | null;
  status: ExemptionStatus;
  verified_at: string | null;
  notes: string | null;
  created_at: string;
  customers?: { name: string } | null;
}

export interface ExemptionRecord extends TaxExemption {
  issuingState: string | null;
  certificatePath: string | null;
  certificateFileName: string | null;
  verifiedAt: string | null;
  notes: string | null;
  customerName: string | null;
  createdAt: string;
}

function mapExemption(r: ExemptionRow): ExemptionRecord {
  return {
    id: r.id,
    customerId: r.customer_id,
    exemptionType: r.exemption_type,
    certificateNumber: r.certificate_number,
    issuingState: r.issuing_state,
    appliesToStates: r.applies_to_states ?? [],
    appliesToClasses: r.applies_to_classes ?? [],
    issuedOn: r.issued_on,
    expiresOn: r.expires_on,
    certificatePath: r.certificate_path,
    certificateFileName: r.certificate_file_name,
    status: r.status,
    verifiedAt: r.verified_at,
    notes: r.notes,
    customerName: r.customers?.name ?? null,
    createdAt: r.created_at,
  };
}

export async function fetchExemptionsForCustomer(customerId: string): Promise<ExemptionRecord[]> {
  const { data, error } = await supabase.from('tax_exemptions').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
  if (error) throw error;
  return ((data as ExemptionRow[]) ?? []).map(mapExemption);
}

export async function fetchAllExemptions(): Promise<ExemptionRecord[]> {
  const { data, error } = await supabase
    .from('tax_exemptions')
    .select('*, customers(name)')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  return ((data as ExemptionRow[]) ?? []).map(mapExemption);
}

export interface ExemptionInput {
  customerId: string;
  exemptionType: ExemptionType;
  certificateNumber?: string;
  issuingState?: string;
  appliesToStates: string[];
  appliesToClasses: string[];
  issuedOn?: string;
  expiresOn?: string;
  notes?: string;
  file?: File | null;
}

export function validateCertificateFile(file: File): string | null {
  if (!CERTIFICATE_TYPES[file.type]) return 'Upload a PDF or an image (JPG, PNG, WebP, HEIC).';
  if (file.size > CERTIFICATE_MAX_BYTES) return 'The file is larger than 10 MB.';
  if (file.size === 0) return 'The file is empty.';
  return null;
}

export async function createExemption(input: ExemptionInput): Promise<void> {
  if (!input.certificateNumber?.trim() && !input.file) throw new Error('Add a certificate number or upload the certificate.');
  if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) throw new Error('The expiry date is before the issue date.');
  const issuingState = input.issuingState ? normalizeState(input.issuingState) : '';
  if (input.issuingState && !issuingState) throw new Error('Choose a valid issuing state.');

  let upload: { path: string; name: string; mime: string; size: number } | null = null;
  if (input.file) {
    const problem = validateCertificateFile(input.file);
    if (problem) throw new Error(problem);
    const ownerId = await getAccountOwnerId();
    const path = `${ownerId}/${input.customerId}/${crypto.randomUUID()}.${CERTIFICATE_TYPES[input.file.type]}`;
    const { error } = await supabase.storage.from('tax-exemption-certificates').upload(path, input.file, { contentType: input.file.type, upsert: false });
    if (error) throw error;
    upload = { path, name: input.file.name.slice(0, 200), mime: input.file.type, size: input.file.size };
  }

  const { error } = await supabase.from('tax_exemptions').insert({
    customer_id: input.customerId,
    exemption_type: input.exemptionType,
    certificate_number: input.certificateNumber?.trim() || null,
    issuing_state: issuingState || null,
    applies_to_states: input.appliesToStates.map((s) => s.toUpperCase()),
    applies_to_classes: input.appliesToClasses,
    issued_on: input.issuedOn || null,
    expires_on: input.expiresOn || null,
    notes: input.notes?.trim() || null,
    certificate_path: upload?.path ?? null,
    certificate_file_name: upload?.name ?? null,
    certificate_mime: upload?.mime ?? null,
    certificate_size_bytes: upload?.size ?? null,
  });
  if (error) {
    if (upload) await supabase.storage.from('tax-exemption-certificates').remove([upload.path]);
    throw error;
  }
}

export async function setExemptionStatus(id: string, status: ExemptionStatus): Promise<void> {
  const { error } = await supabase.from('tax_exemptions').update({ status }).eq('id', id);
  if (error) {
    if (error.code === '23514') throw new Error('Attach the certificate or enter its number before verifying.');
    throw error;
  }
}

export async function deleteExemption(exemption: Pick<ExemptionRecord, 'id' | 'certificatePath'>): Promise<void> {
  const { error } = await supabase.from('tax_exemptions').delete().eq('id', exemption.id);
  if (error) throw error;
  if (exemption.certificatePath) await supabase.storage.from('tax-exemption-certificates').remove([exemption.certificatePath]);
}

/** Private bucket: short-lived signed URL, never a public link. */
export async function getCertificateUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('tax-exemption-certificates').createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('Could not open the certificate.');
  return data.signedUrl;
}

// ----------------------------------------------------------------- reports

export type TaxReportBasis = 'invoiced' | 'paid';

export interface TaxReport {
  summary: TaxSummaryRow[];
  jurisdictions: TaxJurisdictionRow[];
  exemptSales: TaxExemptSaleRow[];
}

export async function fetchTaxReport(from: string, to: string, basis: TaxReportBasis): Promise<TaxReport> {
  const args = { p_from: from, p_to: to, p_basis: basis };
  const [summary, jurisdictions, exempt] = await Promise.all([
    supabase.rpc('tax_report_summary', args),
    supabase.rpc('tax_report_by_jurisdiction', args),
    supabase.rpc('tax_report_exempt_sales', args),
  ]);
  if (summary.error) throw summary.error;
  if (jurisdictions.error) throw jurisdictions.error;
  if (exempt.error) throw exempt.error;

  return {
    summary: ((summary.data as TaxSummaryRow[]) ?? []).map((r) => ({
      ...r,
      invoice_count: num(r.invoice_count), gross_cents: num(r.gross_cents), taxable_cents: num(r.taxable_cents),
      nontaxable_cents: num(r.nontaxable_cents), exempt_cents: num(r.exempt_cents), tax_cents: num(r.tax_cents),
    })),
    jurisdictions: ((jurisdictions.data as TaxJurisdictionRow[]) ?? []).map((r) => ({
      ...r, rate_percent: num(r.rate_percent), taxable_cents: num(r.taxable_cents), tax_cents: num(r.tax_cents), invoice_count: num(r.invoice_count),
    })),
    exemptSales: ((exempt.data as TaxExemptSaleRow[]) ?? []).map((r) => ({ ...r, exempt_cents: num(r.exempt_cents) })),
  };
}

// Re-export so UI code has one import for address normalisation.
export { normalizeAddress };
