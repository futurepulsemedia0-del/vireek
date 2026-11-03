/**
 * State of Home Service Calls — client library.
 * Public edition: GET /functions/v1/state-of-calls-public (frozen, published, k-anonymous aggregates only).
 * Contributor features: RPCs get_report_contribution / set_report_contribution / report_my_comparison (own org only).
 * If no real edition is published yet, the page shows the clearly labelled SYNTHETIC sample edition.
 */
import { supabase } from '@/lib/supabase';
import type { EditionDocument } from '../../supabase/functions/_shared/state-of-calls/edition';
import type { PublishedCell } from '../../supabase/functions/_shared/state-of-calls/schema';

export type { EditionDocument, PublishedCell };
export const REPORT_TERMS_VERSION = '2028-04-draft-1'; // bump when counsel's final text replaces the draft
export const REPORT_PATH = '/state-of-home-service-calls';

const FN_BASE = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/state-of-calls-public`;
export const publicUrl = (edition: string, format: 'json' | 'csv' | 'svg', extra = '') =>
  `${FN_BASE}?edition=${encodeURIComponent(edition)}&format=${format}${extra}`;

export async function loadEdition(): Promise<EditionDocument> {
  try {
    const res = await fetch(publicUrl('latest', 'json'));
    if (res.ok) return (await res.json()) as EditionDocument;
  } catch { /* fall through to the labelled sample */ }
  const sample = await fetch('/state-of-calls/sample-edition.json');
  if (!sample.ok) throw new Error('Report data is unavailable.');
  return (await sample.json()) as EditionDocument;
}

export const isRealEdition = (d: EditionDocument) => !d.synthetic;

export function formatValue(c: Pick<PublishedCell, 'unit' | 'value'>): string {
  if (c.value === null) return '—';
  return c.unit === 'percent' ? `${c.value}%` : c.unit === 'usd' ? `$${c.value}` : `${c.value} min`;
}

export function embedSnippet(edition: string, metric: string, dim: string, title: string): string {
  const src = publicUrl(edition, 'svg', `&metric=${encodeURIComponent(metric)}&dim=${encodeURIComponent(dim)}`);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<figure><img src="${esc(src)}" alt="${esc(title)}" width="720" loading="lazy"/><figcaption>Source: <a href="https://vireek.com${REPORT_PATH}">Vireek, State of Home Service Calls</a></figcaption></figure>`;
}

export interface ContributionState { status: 'granted' | 'revoked' | 'not_set'; terms_version: string | null; granted_at: string | null; revoked_at: string | null; can_manage: boolean }
export async function getContribution(): Promise<ContributionState> {
  const { data, error } = await supabase.rpc('get_report_contribution');
  if (error) throw error;
  return data as ContributionState;
}
export async function setContribution(grant: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_report_contribution', { p_grant: grant, p_terms_version: grant ? REPORT_TERMS_VERSION : null });
  if (error) throw error;
}

export interface ComparisonRow { metric_key: string; my_value: number | null; my_events: number; peer_dim: string; peer_value: string; peer_p25: number | null; peer_p50: number | null; peer_p75: number | null; peer_n_orgs: number }
export interface Comparison { edition: { slug: string; title: string; period_key: string } | null; rows: ComparisonRow[] }
export async function getMyComparison(): Promise<Comparison> {
  const { data, error } = await supabase.rpc('report_my_comparison', { p_slug: null });
  if (error) throw error;
  return data as Comparison;
}

/** Exactly what a contributor shares (shown in the consent card; must match the reviewed allowlist). */
export const SHARED_FIELDS: { label: string; detail: string }[] = [
  { label: 'Call counts by month', detail: 'How many calls, how many missed, emergency, booked, after-hours — as numbers only.' },
  { label: 'Language counts', detail: 'How many calls were detected in each language.' },
  { label: 'Lead response time', detail: 'The median minutes to first respond to leads.' },
  { label: 'Job ticket totals', detail: 'Number of completed invoiced jobs and their average amount.' },
  { label: 'Trade and US Census region', detail: 'Your trade and one of four broad regions — never city, state, ZIP or address.' },
];
export const NEVER_SHARED = ['Call recordings or transcripts', 'Caller or customer names, phone numbers, emails', 'Addresses or exact locations', 'Business name or account identity', 'Any individual call, lead or job'];
