/**
 * Vireek Unknowns Engine — portfolio view (all active jobs).
 *
 * Loads the same evidence as the per-job panel, but with ONE query per source
 * (`job_id IN (...)`) instead of seven per job, then scores every job with the
 * pure engine (`assessJobUnknowns`). Nothing is recomputed here: the portfolio
 * can never disagree with a job's own panel.
 *
 * Reads rely on RLS for scoping (same as every other dashboard read). Each
 * source fails independently into `Loaded.ok = false`, which the engine treats
 * as "unknown" rather than silence.
 */

import { supabase } from '@/lib/supabase';
import { fetchNetworkEvidence } from '@/lib/unknownsNetworkApi';
import {
  DIMENSION_ORDER,
  UNKNOWNS_ELIGIBLE_STATUSES,
  assessJobUnknowns,
  type GateVerdict,
  type Loaded,
  type RawComplianceReview,
  type RawDiagnosisSession,
  type RawEquipment,
  type RawJobPart,
  type RawNoSurprise,
  type RawResolution,
  type RawSite,
  type UnknownDimensionKey,
  type UnknownsInput,
  type UnknownsReport,
} from '@/lib/unknownsEngine';

export const PORTFOLIO_JOB_LIMIT = 150;

export interface PortfolioJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string;
  report: UnknownsReport;
}

export interface DimensionRollup {
  key: UnknownDimensionKey;
  label: string;
  /** Jobs where this dimension is applicable. */
  applicable: number;
  /** Jobs where it is still open (not verified / waived) and not Known/Likely. */
  openCount: number;
  contradictoryCount: number;
}

export interface PortfolioSummary {
  total: number;
  byVerdict: Record<GateVerdict, number>;
  avgReadinessPct: number | null;
  dimensions: DimensionRollup[];
  /** Most urgent first: resolve_first, then caution, then clear; lowest readiness first inside a tier. */
  jobs: PortfolioJob[];
}

export interface PortfolioResult extends PortfolioSummary {
  truncated: boolean;
  generatedAt: string;
}

const VERDICT_RANK: Record<GateVerdict, number> = { resolve_first: 0, proceed_with_caution: 1, clear: 2 };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure. Safe to unit test without Supabase. */
export function summarizePortfolio(jobs: PortfolioJob[]): PortfolioSummary {
  const byVerdict: Record<GateVerdict, number> = { clear: 0, proceed_with_caution: 0, resolve_first: 0 };
  const scores: number[] = [];
  for (const j of jobs) {
    byVerdict[j.report.verdict] += 1;
    if (j.report.readinessPct !== null) scores.push(j.report.readinessPct);
  }

  const dimensions: DimensionRollup[] = DIMENSION_ORDER.map((key) => {
    let applicable = 0;
    let openCount = 0;
    let contradictoryCount = 0;
    let label: string = key;
    for (const j of jobs) {
      const d = j.report.dimensions.find((x) => x.key === key);
      if (!d) continue;
      label = d.label;
      if (!d.applicable) continue;
      applicable += 1;
      if (d.state === 'open' && d.status !== 'known' && d.status !== 'likely') {
        openCount += 1;
        if (d.status === 'contradictory') contradictoryCount += 1;
      }
    }
    return { key, label, applicable, openCount, contradictoryCount };
  }).sort((a, b) => b.openCount - a.openCount);

  const sorted = [...jobs].sort((a, b) => {
    const v = VERDICT_RANK[a.report.verdict] - VERDICT_RANK[b.report.verdict];
    if (v !== 0) return v;
    const r = (a.report.readinessPct ?? 101) - (b.report.readinessPct ?? 101);
    if (r !== 0) return r;
    return (a.scheduled_datetime ?? '9999') < (b.scheduled_datetime ?? '9999') ? -1 : 1;
  });

  return {
    total: jobs.length,
    byVerdict,
    avgReadinessPct: scores.length ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : null,
    dimensions,
    jobs: sorted,
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

async function safe<T>(fn: () => PromiseLike<T>, fallback: T): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch {
    return { ok: false, data: fallback };
  }
}

type Row = Record<string, unknown>;

async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function fetchUnknownsPortfolio(): Promise<PortfolioResult> {
  const statuses = [...UNKNOWNS_ELIGIBLE_STATUSES];
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, customer_name, service_type, dispatch_note, address, latitude, longitude, site_id, customer_phone, quote_id, invoice_amount, technician_diagnosis, diagnosis_notes, before_photos, job_status, scheduled_datetime',
    )
    .in('job_status', statuses)
    .order('scheduled_datetime', { ascending: true, nullsFirst: false })
    .limit(PORTFOLIO_JOB_LIMIT + 1);
  if (error) throw error;

  const all = (data ?? []) as Row[];
  const truncated = all.length > PORTFOLIO_JOB_LIMIT;
  const jobRows = all.slice(0, PORTFOLIO_JOB_LIMIT);
  const generatedAt = new Date().toISOString();
  if (jobRows.length === 0) return { ...summarizePortfolio([]), truncated: false, generatedAt };

  const ids = jobRows.map((j) => String(j.id));
  const siteIds = [...new Set(jobRows.map((j) => str(j.site_id)).filter((s): s is string => s !== null))];

    const [diagnosis, equipment, parts, sites, compliance, noSurprise, network, resolutions] = await Promise.all([
    safe(
      async () =>
        groupBy(
          await rows(
            supabase
              .from('diagnosis_sessions')
              .select('id, job_id, equipment_id, confidence, severity, ai_result, created_at')
              .in('job_id', ids)
              .order('created_at', { ascending: false }),
          ),
          (r) => String(r.job_id),
        ),
      new Map<string, Row[]>(),
    ),
    safe(
      async () =>
        groupBy(
          await rows(
            supabase
              .from('job_equipment')
              .select('job_id, equipment:equipment_id(id, equipment_type, make, model, serial_number, install_date, status)')
              .in('job_id', ids),
          ),
          (r) => String(r.job_id),
        ),
      new Map<string, Row[]>(),
    ),
    safe(
      async () =>
        groupBy(await rows(supabase.from('job_parts_required').select('job_id, status').in('job_id', ids)), (r) =>
          String(r.job_id),
        ),
      new Map<string, Row[]>(),
    ),
    safe(
      async () =>
        siteIds.length === 0
          ? new Map<string, Row>()
          : new Map(
              (
                await rows(
                  supabase
                    .from('customer_sites')
                    .select('id, address, access_notes, site_contact_name, site_contact_phone')
                    .in('id', siteIds),
                )
              ).map((r) => [String(r.id), r] as const),
            ),
      new Map<string, Row>(),
    ),
    safe(
      async () =>
        new Map(
          (
            await rows(
              supabase
                .from('job_compliance_reviews')
                .select('job_id, permit_likelihood, jurisdiction, requirements, item_progress, verify_questions')
                .in('job_id', ids),
            )
          ).map((r) => [String(r.job_id), r] as const),
        ),
      new Map<string, Row>(),
    ),
    // Optional signal: failure means "no signal".
    (async (): Promise<Map<string, RawNoSurprise> | null> => {
      try {
        const list = await rows(supabase.from('no_surprise_requests').select('job_id, status').in('job_id', ids));
        const out = new Map<string, RawNoSurprise>();
        for (const r of list) {
          const k = String(r.job_id);
          const cur = out.get(k) ?? { pending: 0, approved: 0 };
          if (r.status === 'pending') cur.pending += 1;
          if (r.status === 'approved') cur.approved += 1;
          out.set(k, cur);
        }
        return out;
      } catch {
        return null;
      }
    })(),
    fetchNetworkEvidence(ids),
    (async () => {
      try {
        return groupBy(
          await rows(
            supabase
              .from('job_unknown_resolutions')
              .select('job_id, dimension, resolution, value, note, resolved_by, resolved_at')
              .in('job_id', ids),
          ),
          (r) => String(r.job_id),
        );
      } catch {
        return new Map<string, Row[]>();
      }
    })(),
  ]);

  const scored: PortfolioJob[] = jobRows.map((j) => {
    const id = String(j.id);

    const diag: Loaded<RawDiagnosisSession[]> = {
      ok: diagnosis.ok,
      data: (diagnosis.data.get(id) ?? []).slice(0, 5).map((r) => {
        const ai = (r.ai_result ?? {}) as {
          probable_causes?: { cause?: string; likelihood?: number }[];
          missing_info?: unknown;
          parts_needed?: { name?: string; necessity?: string }[];
        };
        const top = Array.isArray(ai.probable_causes) ? ai.probable_causes[0] : undefined;
        return {
          id: String(r.id),
          equipment_id: str(r.equipment_id),
          confidence: num(typeof r.confidence === 'string' ? Number(r.confidence) : r.confidence),
          severity: str(r.severity),
          top_cause: str(top?.cause),
          top_likelihood: num(top?.likelihood),
          missing_info: Array.isArray(ai.missing_info)
            ? ai.missing_info.filter((m): m is string => typeof m === 'string')
            : [],
          parts: (Array.isArray(ai.parts_needed) ? ai.parts_needed : [])
            .filter((p) => typeof p?.name === 'string')
            .map((p) => ({
              name: String(p.name),
              necessity: (p.necessity === 'likely' || p.necessity === 'possible' ? p.necessity : 'if_confirmed') as
                | 'likely'
                | 'possible'
                | 'if_confirmed',
            })),
          created_at: String(r.created_at),
        };
      }),
    };

    const equip: Loaded<RawEquipment[]> = {
      ok: equipment.ok,
      data: (equipment.data.get(id) ?? []).flatMap((r) => {
        const e = r.equipment as RawEquipment | RawEquipment[] | null;
        const one = Array.isArray(e) ? e[0] : e;
        return one ? [one] : [];
      }),
    };

    const partList: Loaded<RawJobPart[]> = { ok: parts.ok, data: (parts.data.get(id) ?? []) as unknown as RawJobPart[] };

    const siteId = str(j.site_id);
    const site: Loaded<RawSite | null> = {
      ok: sites.ok,
      data: siteId ? ((sites.data.get(siteId) as unknown as RawSite | undefined) ?? null) : null,
    };

    const cr = compliance.data.get(id);
    const comp: Loaded<RawComplianceReview | null> = {
      ok: compliance.ok,
      data: cr
        ? {
            permit_likelihood: cr.permit_likelihood as RawComplianceReview['permit_likelihood'],
            jurisdiction_basis:
              ((cr.jurisdiction as { basis?: RawComplianceReview['jurisdiction_basis'] } | null)?.basis) ?? null,
            jurisdiction_coverage:
              ((cr.jurisdiction as { coverage?: RawComplianceReview['jurisdiction_coverage'] } | null)?.coverage) ?? null,
            requirements: ((cr.requirements as RawComplianceReview['requirements'] | null) ?? []).map((r) => ({
              key: r.key,
              category: r.category,
              severity: r.severity,
            })),
            item_progress: (cr.item_progress as RawComplianceReview['item_progress'] | null) ?? {},
            verify_questions: (cr.verify_questions as string[] | null) ?? [],
          }
        : null,
    };

    const input: UnknownsInput = {
      job: {
        id,
        job_status: String(j.job_status),
        service_type: str(j.service_type),
        dispatch_note: str(j.dispatch_note),
        address: str(j.address),
        latitude: num(j.latitude),
        longitude: num(j.longitude),
        site_id: siteId,
        customer_phone: str(j.customer_phone),
        quote_id: str(j.quote_id),
        invoice_amount: num(j.invoice_amount),
        technician_diagnosis: str(j.technician_diagnosis),
        diagnosis_notes: str(j.diagnosis_notes),
        before_photo_count: Array.isArray(j.before_photos) ? j.before_photos.length : 0,
      },
      diagnosis: diag,
      equipment: equip,
      parts: partList,
      site,
      compliance: comp,
      noSurprise: noSurprise ? (noSurprise.get(id) ?? { pending: 0, approved: 0 }) : null,
      network: network.get(id) ?? null,
      resolutions: (resolutions.get(id) ?? []) as unknown as RawResolution[],
    };

    return {
      id,
      customer_name: str(j.customer_name) ?? 'Customer',
      service_type: str(j.service_type),
      scheduled_datetime: str(j.scheduled_datetime),
      job_status: String(j.job_status),
      report: assessJobUnknowns(input),
    };
  });

  return { ...summarizePortfolio(scored), truncated, generatedAt };
}
