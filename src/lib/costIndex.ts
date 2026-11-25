/**
 * Vireek Cost Index — client library (item 140).
 * Public data: GET /functions/v1/cost-index-public (frozen, published, anonymized aggregates only).
 */
import type { CostIndexDocument } from '../../supabase/functions/_shared/cost-index/release';
import type { PublishedCell } from '../../supabase/functions/_shared/cost-index/schema';

export type { CostIndexDocument, PublishedCell };
export const COST_INDEX_PATH = '/cost-index';

const FN_BASE = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/cost-index-public`;
export const costIndexUrl = (release: string, format: 'json' | 'csv') => `${FN_BASE}?release=${encodeURIComponent(release)}&format=${format}`;

export interface ReleaseNotice { slug: string; period_key: string; release_seq: number; status: string; published_at: string | null; changelog: string; withdrawn_reason: string | null }

/** Resolves to null when no release has been published yet (the page then shows methodology only, never sample numbers). */
export async function loadLatestRelease(): Promise<(CostIndexDocument & { superseded?: boolean }) | null> {
  const res = await fetch(costIndexUrl('latest', 'json'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Cost index unavailable.');
  return (await res.json()) as CostIndexDocument;
}

export async function loadReleaseHistory(): Promise<ReleaseNotice[]> {
  const res = await fetch(`${FN_BASE}?list=1`);
  if (!res.ok) return [];
  return ((await res.json()) as { releases: ReleaseNotice[] }).releases ?? [];
}

export const REGION_LABEL: Record<string, string> = { all: 'All regions', northeast: 'Northeast', midwest: 'Midwest', south: 'South', west: 'West' };
export const KIND_LABEL: Record<string, string> = { repair: 'Repair', install: 'Install' };
const REGION_ORDER = ['all', 'northeast', 'midwest', 'south', 'west'];

export function formatUsd(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export interface TradeRows { trade: string; rows: PublishedCell[] }
/** Groups published + suppressed cells for one job kind by trade, regions in a fixed order. Suppressed cells stay visible as "withheld". */
export function groupByTrade(cells: readonly PublishedCell[], kind: string): TradeRows[] {
  const by = new Map<string, PublishedCell[]>();
  for (const c of cells) if (c.job_kind === kind) by.set(c.trade, [...(by.get(c.trade) ?? []), c]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trade, rows]) => ({ trade, rows: [...rows].sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region)) }));
}

export const tradeLabel = (t: string) => t.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
