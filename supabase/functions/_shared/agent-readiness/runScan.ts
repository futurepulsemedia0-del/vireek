// Agent Readiness — one account scan, shared by the on-demand function and the weekly cron.
import { buildFixes, scoreAccount, type ScanResult, type Fix, type Snapshot } from './engine.ts';
import { fetchPublicPage, type FetchDeps } from './fetchPage.ts';
import { buildFacts, type ScanFacts, type ScanSite } from './monitoring.ts';
import { auditHtml, type SiteAudit } from './siteAudit.ts';

export const ENGINE_VERSION = 1;
interface Rpc { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }

export interface StoredScanPayload extends ScanResult { fixes: Fix[]; facts: ScanFacts; site: ScanSite & { audit?: SiteAudit }; engine_version: number }

export async function runAccountScan(admin: Rpc, ownerId: string, source: 'manual' | 'weekly', deps: FetchDeps):
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
  const result = scoreAccount(snapshot, audit);
  const payload: StoredScanPayload = { ...result, fixes: buildFixes(snapshot, result.checks), facts: buildFacts(snapshot), site, engine_version: ENGINE_VERSION };
  const stored = await admin.rpc('agent_readiness_insert_scan', { p_user: ownerId, p_source: source, p_result: payload });
  if (stored.error || typeof stored.data !== 'string') return { ok: false, code: 'store_failed' };
  return { ok: true, scanId: stored.data, payload };
}
