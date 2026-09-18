import { supabase, Call } from '@/lib/supabase';

/**
 * Price Book Enforcement — dashboard client library.
 *
 * Reads what the webhook's deterministic checker
 * (_shared/ai-core/priceEnforcement.ts) already wrote onto each `calls`
 * row: price_accuracy_status, price_accuracy_details,
 * price_lookups_performed. This module does no analysis of its own — it
 * only fetches and summarizes what's already been computed server-side.
 */

export interface PriceMismatchDetail {
  stated_text: string;
  stated_cents: number;
  context_snippet: string;
  closest_catalog_match: {
    service_name: string;
    price_cents: number;
    price_max_cents: number | null;
  } | null;
}

export interface PriceAccuracySummary {
  totalCallsWithPricing: number;
  verifiedCount: number;
  mismatchCount: number;
  unverifiedCount: number;
  accuracyRate: number | null;
  groundedRate: number | null;
}

export function summarizePriceAccuracy(calls: Call[]): PriceAccuracySummary {
  const relevant = calls.filter(
    (c) => c.price_accuracy_status && c.price_accuracy_status !== 'not_applicable',
  );
  const verifiedCount = relevant.filter((c) => c.price_accuracy_status === 'verified').length;
  const mismatchCount = relevant.filter((c) => c.price_accuracy_status === 'mismatch').length;
  const unverifiedCount = relevant.filter((c) => c.price_accuracy_status === 'unverified').length;

  const totalCallsWithPricing = relevant.length;
  const accuracyRate = totalCallsWithPricing > 0
    ? Math.round(((totalCallsWithPricing - mismatchCount) / totalCallsWithPricing) * 1000) / 10
    : null;
  const groundedRate = totalCallsWithPricing > 0
    ? Math.round((verifiedCount / totalCallsWithPricing) * 1000) / 10
    : null;

  return { totalCallsWithPricing, verifiedCount, mismatchCount, unverifiedCount, accuracyRate, groundedRate };
}

export function getFlaggedCalls(calls: Call[]): Call[] {
  return calls
    .filter((c) => c.price_accuracy_status === 'mismatch' || c.price_accuracy_status === 'unverified')
    .sort((a, b) => new Date(b.call_datetime).getTime() - new Date(a.call_datetime).getTime());
}

export async function fetchPriceLookupLog(externalCallId: string) {
  const { data, error } = await supabase
    .from('price_lookup_log')
    .select('*')
    .eq('external_call_id', externalCallId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return data as { id: string; query: string | null; matched_items: unknown[]; created_at: string }[];
}
