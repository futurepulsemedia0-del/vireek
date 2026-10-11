import { supabase } from '@/lib/supabase';
import { fetchHomeLifetimeGraph } from '@/lib/homeLifetimeGraphApi';
import { fetchPropertyIntelligence, fetchPredictions } from '@/lib/propertyIntelligence';
import type { PioPrediction, PropertyIntelligence } from '@/lib/propertyIntelligence';
import { fetchPassport, normalizePassportCode } from '@/lib/equipmentPassport';
import { fetchChainReport } from '@/lib/jobEvidenceChain';
import type { ChainReport } from '@/lib/jobEvidenceChain';
import { completedHistory } from '@/lib/homeLifetimeGraph';
import type { EquipmentPassportLite, JobOutcomeLite, PassportInputs } from '@/lib/homePassport';

/**
 * IO layer for the Home Passport Network. Reuses the existing fetchers; adds only
 * three small bulk reads (passport codes, job outcomes) that no existing module exposes.
 * Every secondary source is optional: a missing table, RLS denial or timeout degrades
 * the passport (fewer records, lower trust) instead of failing the page.
 */

const CHUNK = 150;
const CONCURRENCY = 5;
/** Evidence reports are one RPC per job — cap to the newest jobs that matter. */
const MAX_EVIDENCE_JOBS = 30;
const MAX_LEDGERS = 25;

export interface PassportLoadWarnings { sources: string[] }
export interface LoadedPassport { inputs: PassportInputs; warnings: PassportLoadWarnings }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchPassportCodes(equipmentIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < equipmentIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('equipment_passport_links')
      .select('equipment_id, verified, passport:passport_id (public_code)')
      .in('equipment_id', equipmentIds.slice(i, i + CHUNK))
      .eq('status', 'active');
    if (error) throw error;
    for (const row of (data as unknown as Array<{
      equipment_id: string | null; verified: boolean;
      passport: { public_code: string } | { public_code: string }[] | null;
    }> | null) ?? []) {
      if (!row.equipment_id || !row.verified || !row.passport) continue;
      const code = Array.isArray(row.passport) ? row.passport[0]?.public_code : row.passport.public_code;
      if (code) out[row.equipment_id] = code;
    }
  }
  return out;
}

async function fetchOutcomes(jobIds: string[]): Promise<JobOutcomeLite[]> {
  const out: JobOutcomeLite[] = [];
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('job_outcomes')
      .select('job_id, resolution, is_rework, caused_callback, customer_rating, root_cause_key, recorded_at')
      .in('job_id', jobIds.slice(i, i + CHUNK));
    if (error) throw error;
    out.push(...((data as JobOutcomeLite[] | null) ?? []));
  }
  return out;
}

export async function loadHomePassport(siteId: string): Promise<LoadedPassport | null> {
  const graph = await fetchHomeLifetimeGraph(siteId);
  if (!graph) return null;
  const warnings: string[] = [];

  const equipmentIds = graph.twin.equipment.map((e) => e.id);
  const history = completedHistory(graph);
  const majorJobIds = history
    .filter((h) => h.category === 'repair' || h.category === 'replacement' || h.category === 'installation')
    .sort((a, b) => (b.job.scheduled_datetime ?? '').localeCompare(a.job.scheduled_datetime ?? ''))
    .slice(0, MAX_EVIDENCE_JOBS)
    .map((h) => h.job.id);
  const allJobIds = graph.twin.jobs.map((j) => j.id);

  const [intelRes, predRes, codesRes, outcomesRes] = await Promise.allSettled([
    fetchPropertyIntelligence(siteId, false),
    fetchPredictions(),
    equipmentIds.length ? fetchPassportCodes(equipmentIds) : Promise.resolve({} as Record<string, string>),
    allJobIds.length ? fetchOutcomes(allJobIds) : Promise.resolve([] as JobOutcomeLite[]),
  ]);

  const intel: PropertyIntelligence | null = intelRes.status === 'fulfilled' ? intelRes.value : null;
  if (intelRes.status === 'rejected') warnings.push('Property Intelligence');
  const predictions: PioPrediction[] = predRes.status === 'fulfilled' ? predRes.value : [];
  if (predRes.status === 'rejected') warnings.push('AI predictions');
  const codes = codesRes.status === 'fulfilled' ? codesRes.value : {};
  if (codesRes.status === 'rejected') warnings.push('Equipment Passports');
  const outcomes = outcomesRes.status === 'fulfilled' ? outcomesRes.value : [];
  if (outcomesRes.status === 'rejected') warnings.push('Job outcomes');

  const ledgerTargets = Object.entries(codes).slice(0, MAX_LEDGERS);
  const [ledgerResults, evidenceResults] = await Promise.all([
    mapLimit(ledgerTargets, CONCURRENCY, async ([equipmentId, code]) => {
      const data = await fetchPassport(normalizePassportCode(code));
      if (!data.found) return null;
      const lite: EquipmentPassportLite = { code, integrity: data.integrity ?? null, events: data.events ?? [] };
      return [equipmentId, lite] as const;
    }),
    mapLimit(majorJobIds, CONCURRENCY, async (jobId) => [jobId, await fetchChainReport(jobId)] as const),
  ]);

  const passports: Record<string, EquipmentPassportLite> = {};
  let ledgerFailed = false;
  for (const r of ledgerResults) {
    if (r.status === 'rejected') { ledgerFailed = true; continue; }
    if (r.value) passports[r.value[0]] = r.value[1];
  }
  if (ledgerFailed) warnings.push('some device ledgers');

  const evidence: Record<string, ChainReport> = {};
  let evidenceFailed = false;
  for (const r of evidenceResults) {
    if (r.status === 'rejected') { evidenceFailed = true; continue; }
    const [jobId, report] = r.value;
    // Jobs with no chain entries yet report score 0 / not_started — not evidence.
    if (report && report.level !== 'not_started') evidence[jobId] = report;
  }
  if (evidenceFailed) warnings.push('some evidence chains');

  return { inputs: { graph, intel, predictions, passports, evidence, outcomes }, warnings: { sources: warnings } };
}
