// Agent Readiness — one account scan, shared by the on-demand function and the weekly cron.
import { buildFixes, scoreAccount, type ScanResult, type Fix, type Snapshot } from './engine.ts';
import { fetchPublicPage, type FetchDeps } from './fetchPage.ts';
import { buildFacts, type ScanFacts, type ScanSite } from './monitoring.ts';
import { auditHtml, type SiteAudit } from './siteAudit.ts';
import type { GbpResult } from './gbp.ts';
import { getGbpResult, type GbpDeps, type GbpStore } from './gbpProvider.ts';

export const ENGINE_VERSION = 1;
interface Rpc { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }

/** What is kept of a GBP read inside a stored scan. Deliberately no NAP fields and no tokens. */
export interface GbpSummary { status: GbpResult['status']; stale: boolean; fetched_at: string | null; primary_category: string | null; additional_categories: number | null; photos: number | null; open_status: string | null; voice_of_merchant: boolean | null }
export function summarizeGbp(g: GbpResult): GbpSummary {
  const f = g.facts;
  return {
    status: g.status, stale: g.stale, fetched_at: g.fetchedAt, primary_category: f?.primaryCategory ?? null,
    additional_categories: f ? f.additionalCategories : null, photos: f?.photoCount ?? null, open_status: f?.openStatus ?? null, voice_of_merchant: f?.voiceOfMerchant ?? null,
  };
}

export interface StoredScanPayload extends ScanResult { fixes: Fix[]; facts: ScanFacts & { gbp?: GbpSummary }; site: ScanSite & { audit?: SiteAudit }; engine_version: number }

export async function runAccountScan(admin: Rpc, ownerId: string, source: 'manual' | 'weekly', deps: FetchDeps, gbp?: { store: GbpStore; deps: GbpDeps }):
  Promise<{ ok: true; scanId: string; payload: StoredScanPayload } | { ok: false; code: 'no_business_profile' | 'snapshot_failed' | 'store_failed' }> {
  const snap = await admin.rpc('agent_readiness_snapshot_internal', { p_user: ownerId });
  if (snap.error) return { ok: false, code: 'snapshot_failed' };
  if (!snap.data) return { ok: false, code: 'no_business_profile' };
  const snapshot = snap.data as Snapshot;

  let audit: SiteAudit | null = null;
  let site: StoredScanPayload['site'] = { ok: false, code: 'no_website' };
  if (snapshot.business.website) {
    const page = await fetchPublicPage(snapshot.business.website, deps);
    if (page.ok) {
      audit = auditHtml(page.html, page.finalUrl, { fetchMs: page.ms, bytes: page.bytes });
      site = { ok: true, local_business: audit.localBusiness.present, audit };
    } else site = { ok: false, code: page.code };
  }
   // The GBP read never fails a scan: any problem becomes a not-measured check (see getGbpResult).
  const gbpResult: GbpResult | null = gbp ? await getGbpResult(gbp.store, ownerId, gbp.deps).catch((): GbpResult => ({ status: 'unavailable', facts: null, stale: false, fetchedAt: null })) : null;
  const result = scoreAccount(snapshot, audit, null, gbpResult);
  const facts: StoredScanPayload['facts'] = { ...buildFacts(snapshot), ...(gbpResult && gbpResult.status !== 'disabled' ? { gbp: summarizeGbp(gbpResult) } : {}) };
  const payload: StoredScanPayload = { ...result, fixes: buildFixes(snapshot, result.checks), facts, site, engine_version: ENGINE_VERSION };
  const stored = await admin.rpc('agent_readiness_insert_scan', { p_user: ownerId, p_source: source, p_result: payload });
  if (stored.error || typeof stored.data !== 'string') return { ok: false, code: 'store_failed' };
  return { ok: true, scanId: stored.data, payload };
}
