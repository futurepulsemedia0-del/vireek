import { supabase } from '@/lib/supabase';
import type {
  Complexity,
  RiskLevel,
  Severity,
  TechnicianLevel,
  TruthContext,
  TruthReport,
  TruthVerdict,
} from '../../supabase/functions/_shared/quote-truth/engine';

/**
 * Vireek Quote Truth Engine — dashboard client.
 *
 * All analysis is computed server-side (supabase/functions/quote-truth-engine)
 * by a deterministic engine. This module only invokes it, reads/writes the
 * account's own tuning data, and holds display metadata. Types are imported
 * (type-only) from the engine so the client can never drift from the server.
 */

export type { Complexity, RiskLevel, Severity, TechnicianLevel, TruthContext, TruthReport, TruthVerdict };

export const DEFAULT_TRUTH_CONTEXT: TruthContext = {
  technician_level: 'standard',
  complexity: 'routine',
  after_hours: false,
  travel_miles: null,
};

export const TECHNICIAN_LEVEL_OPTIONS: { value: TechnicianLevel; label: string }[] = [
  { value: 'junior', label: 'Junior' },
  { value: 'standard', label: 'Standard' },
  { value: 'senior', label: 'Senior' },
  { value: 'master', label: 'Master' },
];

export const COMPLEXITY_OPTIONS: { value: Complexity; label: string }[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'complex', label: 'Complex' },
  { value: 'emergency', label: 'Emergency' },
];

export interface TruthAnalysisResult {
  analysisId: string | null;
  persisted: boolean;
  report: TruthReport;
}

async function extractInvokeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error.message : 'Could not analyze this quote.';
}

/** Runs the Truth Engine for a saved quote. Throws with a user-facing message. */
export async function analyzeQuoteTruth(quoteId: string, context: TruthContext = DEFAULT_TRUTH_CONTEXT): Promise<TruthAnalysisResult> {
  const { data, error } = await supabase.functions.invoke('quote-truth-engine', { body: { quoteId, context } });
  if (error) throw new Error(await extractInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  if (!data?.report) throw new Error('The Truth Engine returned no result.');
  return { analysisId: data.analysis_id ?? null, persisted: data.persisted !== false, report: data.report as TruthReport };
}

// ---------------------------------------------------------------------------
// Settings (owner-editable)
// ---------------------------------------------------------------------------

export interface TruthSettings {
  region_label: string | null;
  regional_price_index: number;
  max_premium_pct: number;
}

export const DEFAULT_TRUTH_SETTINGS: TruthSettings = { region_label: null, regional_price_index: 1, max_premium_pct: 12 };

/** RLS scopes the read to the caller's account owner, so no user filter is needed (works for team members too). */
export async function fetchTruthSettings(): Promise<TruthSettings> {
  const { data, error } = await supabase
    .from('quote_truth_settings')
    .select('region_label, regional_price_index, max_premium_pct')
    .maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_TRUTH_SETTINGS;
  return {
    region_label: data.region_label ?? null,
    regional_price_index: Number(data.regional_price_index ?? 1),
    max_premium_pct: Number(data.max_premium_pct ?? 12),
  };
}

export async function saveTruthSettings(ownerId: string, s: TruthSettings): Promise<void> {
  if (!Number.isFinite(s.regional_price_index) || s.regional_price_index < 0.5 || s.regional_price_index > 2) {
    throw new Error('Regional price index must be between 0.50 and 2.00.');
  }
  if (!Number.isFinite(s.max_premium_pct) || s.max_premium_pct < 0 || s.max_premium_pct > 100) {
    throw new Error('Fair-price tolerance must be between 0 and 100%.');
  }
  const { error } = await supabase.from('quote_truth_settings').upsert(
    {
      user_id: ownerId,
      region_label: s.region_label?.trim() || null,
      regional_price_index: s.regional_price_index,
      max_premium_pct: s.max_premium_pct,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Competitor benchmarks (owner-entered)
// ---------------------------------------------------------------------------

export interface CompetitorBenchmarkRow {
  id: string;
  service_keyword: string;
  region_label: string | null;
  low_cents: number;
  high_cents: number;
  source_label: string | null;
  notes: string | null;
  observed_at: string;
}

export async function fetchCompetitorBenchmarks(): Promise<CompetitorBenchmarkRow[]> {
  const { data, error } = await supabase
    .from('quote_competitor_benchmarks')
    .select('id, service_keyword, region_label, low_cents, high_cents, source_label, notes, observed_at')
    .order('observed_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as CompetitorBenchmarkRow[]) ?? [];
}

export interface CompetitorBenchmarkForm {
  service_keyword: string;
  region_label: string;
  low: string;
  high: string;
  source_label: string;
  notes: string;
}

export const EMPTY_BENCHMARK_FORM: CompetitorBenchmarkForm = {
  service_keyword: '',
  region_label: '',
  low: '',
  high: '',
  source_label: '',
  notes: '',
};

export async function addCompetitorBenchmark(ownerId: string, form: CompetitorBenchmarkForm): Promise<void> {
  const keyword = form.service_keyword.trim();
  if (keyword.length < 2) throw new Error('Describe the job (for example "AC compressor replacement").');
  const lowCents = Math.round(Number(form.low) * 100);
  const highCents = Math.round(Number(form.high) * 100);
  if (!Number.isFinite(lowCents) || lowCents <= 0) throw new Error('Enter a valid low price.');
  if (!Number.isFinite(highCents) || highCents < lowCents) throw new Error('The high price must be at or above the low price.');
  const { error } = await supabase.from('quote_competitor_benchmarks').insert({
    user_id: ownerId,
    service_keyword: keyword,
    region_label: form.region_label.trim() || null,
    low_cents: lowCents,
    high_cents: highCents,
    source_label: form.source_label.trim() || null,
    notes: form.notes.trim() || null,
  });
  if (error) throw error;
}

export async function deleteCompetitorBenchmark(id: string): Promise<void> {
  const { error } = await supabase.from('quote_competitor_benchmarks').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface TruthAnalysisRow {
  id: string;
  quote_id: string;
  verdict: TruthVerdict;
  subtotal_cents: number;
  expected_low_cents: number;
  expected_high_cents: number;
  rejection_probability: number;
  overcharge_level: RiskLevel;
  recommended_subtotal_cents: number | null;
  created_at: string;
  quotes: { customer_name: string } | null;
}

export async function fetchRecentTruthAnalyses(limit = 50): Promise<TruthAnalysisRow[]> {
  const { data, error } = await supabase
    .from('quote_truth_analyses')
    .select(
      'id, quote_id, verdict, subtotal_cents, expected_low_cents, expected_high_cents, rejection_probability, overcharge_level, recommended_subtotal_cents, created_at, quotes:quote_id (customer_name)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as TruthAnalysisRow[]) ?? [];
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const s = abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return `${dollars < 0 ? '-' : ''}$${s}`;
}

export function formatPct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export const VERDICT_META: Record<TruthVerdict, { label: string; tone: string; summary: string }> = {
  well_priced: { label: 'Well priced', tone: 'bg-success-500/10 text-success-500', summary: 'Inside the expected range with no serious flags.' },
  fair: { label: 'Fair', tone: 'bg-accent/10 text-accent', summary: 'Reasonable, with something worth a second look.' },
  high: { label: 'High', tone: 'bg-warning-500/10 text-warning-500', summary: 'Above the expected range — expect pushback.' },
  overpriced: { label: 'Overpriced', tone: 'bg-danger/10 text-danger', summary: 'Well above what the evidence supports.' },
  underpriced: { label: 'Underpriced', tone: 'bg-warning-500/10 text-warning-500', summary: 'Below the expected range — you may be leaving money on the table.' },
  low_evidence: { label: 'Low evidence', tone: 'bg-bg-tertiary text-text-secondary', summary: 'Not enough data to judge confidently. Add costs, history or benchmarks.' },
};

export const RISK_LEVEL_META: Record<RiskLevel, { label: string; tone: string; bar: string }> = {
  low: { label: 'Low', tone: 'bg-success-500/10 text-success-500', bar: 'bg-success-500' },
  moderate: { label: 'Moderate', tone: 'bg-accent/10 text-accent', bar: 'bg-accent' },
  high: { label: 'High', tone: 'bg-warning-500/10 text-warning-500', bar: 'bg-warning-500' },
  severe: { label: 'Severe', tone: 'bg-danger/10 text-danger', bar: 'bg-danger' },
};

export const SEVERITY_META: Record<Severity, { label: string; tone: string }> = {
  critical: { label: 'Critical', tone: 'bg-danger/10 text-danger' },
  warning: { label: 'Warning', tone: 'bg-warning-500/10 text-warning-500' },
  info: { label: 'Note', tone: 'bg-bg-tertiary text-text-secondary' },
};

export const ANCHOR_GROUP: Record<string, 'Historical' | 'Market' | 'Catalog' | 'Model'> = {
  history: 'Historical',
  competitor: 'Market',
  cohort: 'Market',
  price_book: 'Catalog',
  cost_plus: 'Model',
};
