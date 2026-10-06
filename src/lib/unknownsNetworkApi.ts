/**
 * Vireek Unknowns Engine — network / catalog evidence loader.
 *
 * Bridges the OEM intelligence layer (oem_equipment_models, oem_parts,
 * oem_failure_patterns, equipment_oem_link) — and later the Failure Atlas,
 * which can write to the same tables — into `RawNetworkEvidence` for the pure
 * engine. Batch-first: a fixed handful of `IN (...)` queries for any number of
 * jobs.
 *
 * Optional signal by design: any failure returns an empty map, which the engine
 * reads as "no network evidence" — never as certainty and never as doubt.
 * Reference tables are readable by any authenticated user; per-account tables
 * (job_equipment, equipment_oem_link, job_parts_required) are scoped by RLS.
 */

import { supabase } from '@/lib/supabase';
import type { RawNetworkEvidence } from '@/lib/unknownsEngine';

type Row = Record<string, unknown>;

export interface NetworkSourceRows {
  jobEquipment: { job_id: string; equipment_id: string }[];
  links: { equipment_id: string; model_id: string; match_confidence: number | null }[];
  models: { id: string; model_number: string | null; source: 'oem_api' | 'internal' }[];
  patterns: { model_id: string; failure_mode: string; sample_size: number }[];
  catalogParts: { model_id: string; part_number: string }[];
  jobParts: { job_id: string; part_number: string | null }[];
}

/** Uppercase alphanumerics only, so "ab-123 / X" and "AB123X" compare equal. */
export function normalizePartNumber(v: string | null | undefined): string | null {
  const n = (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length >= 3 ? n : null;
}

/** Pure. Picks each job's best-matched linked model and cross-references its parts. */
export function buildNetworkEvidence(src: NetworkSourceRows, jobIds: string[]): Map<string, RawNetworkEvidence> {
  const out = new Map<string, RawNetworkEvidence>();
  const modelById = new Map(src.models.map((m) => [m.id, m] as const));
  const linkByEquipment = new Map(src.links.map((l) => [l.equipment_id, l] as const));

  for (const jobId of jobIds) {
    let best: { model_id: string; match_confidence: number | null } | null = null;
    for (const je of src.jobEquipment) {
      if (je.job_id !== jobId) continue;
      const link = linkByEquipment.get(je.equipment_id);
      if (!link || !modelById.has(link.model_id)) continue;
      if (!best || (link.match_confidence ?? 0) > (best.match_confidence ?? 0)) best = link;
    }
    if (!best) continue;

    const model = modelById.get(best.model_id)!;
    const catalog = new Set(
      src.catalogParts.filter((p) => p.model_id === model.id).map((p) => normalizePartNumber(p.part_number)).filter((n): n is string => n !== null),
    );
    const jobParts = src.jobParts.filter((p) => p.job_id === jobId);
    const matched = jobParts.filter((p) => {
      const n = normalizePartNumber(p.part_number);
      return n !== null && catalog.has(n);
    }).length;

    out.set(jobId, {
      model_label: model.model_number,
      model_source: model.source,
      match_confidence: best.match_confidence,
      parts_total: jobParts.length,
      parts_catalog_matched: matched,
      failure_patterns: src.patterns
        .filter((p) => p.model_id === model.id)
        .map((p) => ({ failure_mode: p.failure_mode, sample_size: p.sample_size })),
    });
  }
  return out;
}

async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Never throws. Missing key in the result = no network signal for that job. */
export async function fetchNetworkEvidence(jobIds: string[]): Promise<Map<string, RawNetworkEvidence>> {
  if (jobIds.length === 0) return new Map();
  try {
    const [je, jp] = await Promise.all([
      rows(supabase.from('job_equipment').select('job_id, equipment_id').in('job_id', jobIds)),
      rows(supabase.from('job_parts_required').select('job_id, part:part_id(part_number)').in('job_id', jobIds)),
    ]);
    const equipmentIds = [...new Set(je.map((r) => String(r.equipment_id)))];
    if (equipmentIds.length === 0) return new Map();

    const linkRows = await rows(
      supabase
        .from('equipment_oem_link')
        .select('equipment_id, model_id, match_confidence, enrichment_status')
        .in('equipment_id', equipmentIds)
        .eq('enrichment_status', 'matched'),
    );
    const modelIds = [...new Set(linkRows.map((r) => str(r.model_id)).filter((v): v is string => v !== null))];
    if (modelIds.length === 0) return new Map();

    const [models, patterns, catalog] = await Promise.all([
      rows(supabase.from('oem_equipment_models').select('id, model_number, source').in('id', modelIds)),
      rows(supabase.from('oem_failure_patterns').select('model_id, failure_mode, sample_size').in('model_id', modelIds)),
      rows(supabase.from('oem_parts').select('model_id, part_number').in('model_id', modelIds)),
    ]);

    return buildNetworkEvidence(
      {
        jobEquipment: je.map((r) => ({ job_id: String(r.job_id), equipment_id: String(r.equipment_id) })),
        links: linkRows.flatMap((r) => {
          const model_id = str(r.model_id);
          return model_id ? [{ equipment_id: String(r.equipment_id), model_id, match_confidence: num(r.match_confidence) }] : [];
        }),
        models: models.map((r) => ({
          id: String(r.id),
          model_number: str(r.model_number),
          source: r.source === 'oem_api' ? ('oem_api' as const) : ('internal' as const),
        })),
        patterns: patterns.map((r) => ({
          model_id: String(r.model_id),
          failure_mode: String(r.failure_mode),
          sample_size: num(r.sample_size) ?? 0,
        })),
        catalogParts: catalog.map((r) => ({ model_id: String(r.model_id), part_number: String(r.part_number) })),
        jobParts: jp.map((r) => {
          const part = r.part as { part_number?: string | null } | { part_number?: string | null }[] | null;
          const one = Array.isArray(part) ? part[0] : part;
          return { job_id: String(r.job_id), part_number: one?.part_number ?? null };
        }),
      },
      jobIds,
    );
  } catch {
    return new Map();
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
