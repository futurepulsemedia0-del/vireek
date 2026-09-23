import { supabase } from '@/lib/supabase';

export interface PricePolicy {
  id: string;
  service_name: string;
  category: string | null;
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
  enforcement: 'mandatory' | 'recommended_floor' | 'recommended';
}

export interface Territory {
  id: string;
  location_id: string;
  zip_codes: string[];
  exclusive: boolean;
}

export interface Requirement {
  id: string;
  requirement_type: 'brand' | 'compliance' | 'safety' | 'legal';
  title: string;
  description: string | null;
  is_required: boolean;
}

export interface ComplianceSummary {
  location_id: string;
  label: string;
  total_requirements: number;
  compliant_count: number;
  non_compliant_count: number;
  pending_count: number;
  compliance_pct: number | null;
}

export interface BenchmarkRow {
  location_id: string;
  label: string;
  revenue_30d: number;
  jobs_30d: number;
  avg_rating: number | null;
  revenue_percentile: number;
  jobs_percentile: number;
  rating_percentile: number;
}

export interface RoyaltyStatement {
  id: string;
  location_id: string;
  period_start: string;
  period_end: string;
  gross_revenue_cents: number;
  royalty_rate_pct: number;
  royalty_amount_cents: number;
  status: 'issued' | 'paid' | 'waived';
}

export interface ApprovedVendor {
  id: string;
  name: string;
  category: string | null;
  is_mandatory: boolean;
  active: boolean;
}

// --- Pricing ---
export async function fetchPricePolicies(groupId: string): Promise<PricePolicy[]> {
  const { data, error } = await supabase.from('franchise_price_policies').select('*').eq('franchise_group_id', groupId).order('service_name');
  if (error) throw error;
  return data ?? [];
}

export async function createPricePolicy(groupId: string, policy: Omit<PricePolicy, 'id'>): Promise<void> {
  const { error } = await supabase.from('franchise_price_policies').insert({ franchise_group_id: groupId, ...policy });
  if (error) throw error;
}

export async function pushPricePolicy(policyId: string): Promise<number> {
  const { data, error } = await supabase.rpc('push_price_policy_to_locations', { p_policy_id: policyId });
  if (error) throw error;
  return data ?? 0;
}

// --- Territory ---
export async function fetchTerritories(groupId: string): Promise<Territory[]> {
  const { data, error } = await supabase.from('franchise_territories').select('*').eq('franchise_group_id', groupId);
  if (error) throw error;
  return data ?? [];
}

export async function upsertTerritory(groupId: string, locationId: string, zipCodes: string[], exclusive: boolean): Promise<void> {
  const { error } = await supabase
    .from('franchise_territories')
    .upsert({ franchise_group_id: groupId, location_id: locationId, zip_codes: zipCodes, exclusive }, { onConflict: 'location_id' });
  if (error) throw error;
}

// --- Brand + Compliance ---
export async function fetchRequirements(groupId: string): Promise<Requirement[]> {
  const { data, error } = await supabase.from('franchise_requirements').select('*').eq('franchise_group_id', groupId).order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function createRequirement(groupId: string, req: Omit<Requirement, 'id'>): Promise<void> {
  const { error } = await supabase.from('franchise_requirements').insert({ franchise_group_id: groupId, ...req });
  if (error) throw error;
}

export async function fetchComplianceSummary(groupId: string): Promise<ComplianceSummary[]> {
  const { data, error } = await supabase.rpc('get_franchise_compliance_summary', { p_group_id: groupId });
  if (error) throw error;
  return data ?? [];
}

export async function reviewComplianceRecord(recordId: string, status: 'compliant' | 'non_compliant' | 'waived', note?: string): Promise<void> {
  const { error } = await supabase.rpc('review_compliance_record', { p_record_id: recordId, p_status: status, p_note: note ?? null });
  if (error) throw error;
}

// --- Benchmark ---
export async function fetchBenchmark(groupId: string): Promise<BenchmarkRow[]> {
  const { data, error } = await supabase.rpc('get_franchise_benchmark', { p_group_id: groupId });
  if (error) throw error;
  return data ?? [];
}

// --- Royalty ---
export async function fetchRoyaltyStatements(groupId: string): Promise<RoyaltyStatement[]> {
  const { data, error } = await supabase.from('franchise_royalty_statements').select('*').eq('franchise_group_id', groupId).order('period_start', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function generateAndNotifyRoyalty(groupId: string, periodStart: string, periodEnd: string): Promise<{ issued: number; notified: number }> {
  const { data, error } = await supabase.functions.invoke('franchise-royalty-issue', {
    body: { group_id: groupId, period_start: periodStart, period_end: periodEnd },
  });
  if (error) throw error;
  return data;
}

export async function markRoyaltyStatus(statementId: string, status: 'issued' | 'paid' | 'waived'): Promise<void> {
  const { error } = await supabase.rpc('mark_royalty_statement_status', { p_statement_id: statementId, p_status: status });
  if (error) throw error;
}

// --- Procurement ---
export async function fetchApprovedVendors(groupId: string): Promise<ApprovedVendor[]> {
  const { data, error } = await supabase.from('franchise_approved_vendors').select('*').eq('franchise_group_id', groupId).order('name');
  if (error) throw error;
  return data ?? [];
}

export async function createApprovedVendor(groupId: string, vendor: Omit<ApprovedVendor, 'id'> & { contact_name?: string; phone?: string; email?: string; negotiated_terms?: string }): Promise<void> {
  const { error } = await supabase.from('franchise_approved_vendors').insert({ franchise_group_id: groupId, ...vendor });
  if (error) throw error;
}

export async function pushVendor(vendorId: string): Promise<number> {
  const { data, error } = await supabase.rpc('push_vendor_to_locations', { p_vendor_id: vendorId });
  if (error) throw error;
  return data ?? 0;
}
