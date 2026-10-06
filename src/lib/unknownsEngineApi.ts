/**
 * Vireek Unknowns Engine — data access + React hook.
 *
 * Read-only gathering of the evidence that already exists for a job, plus the
 * two human actions (verify / waive) and "reopen". All scoring lives in the
 * pure module `unknownsEngine.ts`; nothing here recomputes it.
 *
 * Every evidence source is loaded independently: if one table or column has
 * moved in your schema, only that dimension reports "could not be loaded"
 * (treated as unknown) instead of breaking the whole panel.
 *
 * Server counterpart: supabase/migrations/20270210000000_unknowns_engine.sql
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Job } from '@/lib/supabase';
import { fetchComplianceReview } from '@/lib/permitCompliance';
import { fetchNetworkEvidence } from '@/lib/unknownsNetworkApi';
import {
  assessJobUnknowns,
  type Loaded,
  type RawComplianceReview,
  type RawDiagnosisSession,
  type RawEquipment,
  type RawJobPart,
  type RawNoSurprise,
  type RawResolution,
  type RawSite,
  type ResolutionKind,
  type UnknownDimensionKey,
  type UnknownsInput,
  type UnknownsReport,
} from '@/lib/unknownsEngine';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function safe<T>(fn: () => PromiseLike<T>, fallback: T): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch {
    return { ok: false, data: fallback };
  }
}

async function loadDiagnosis(jobId: string): Promise<RawDiagnosisSession[]> {
  const { data, error } = await supabase
    .from('diagnosis_sessions')
    .select('id, equipment_id, confidence, severity, ai_result, created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
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
      missing_info: Array.isArray(ai.missing_info) ? ai.missing_info.filter((m): m is string => typeof m === 'string') : [],
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
  });
}

async function loadEquipment(jobId: string): Promise<RawEquipment[]> {
  const { data, error } = await supabase
    .from('job_equipment')
    .select('equipment:equipment_id(id, equipment_type, make, model, serial_number, install_date, status)')
    .eq('job_id', jobId);
  if (error) throw error;
  const out: RawEquipment[] = [];
  for (const row of (data ?? []) as unknown as { equipment: RawEquipment | RawEquipment[] | null }[]) {
    const e = Array.isArray(row.equipment) ? row.equipment[0] : row.equipment;
    if (e) out.push(e);
  }
  return out;
}

async function loadParts(jobId: string): Promise<RawJobPart[]> {
  const { data, error } = await supabase.from('job_parts_required').select('status').eq('job_id', jobId);
  if (error) throw error;
  return (data ?? []) as RawJobPart[];
}

async function loadSite(siteId: string | null): Promise<RawSite | null> {
  if (!siteId) return null;
  const { data, error } = await supabase
    .from('customer_sites')
    .select('address, access_notes, site_contact_name, site_contact_phone')
    .eq('id', siteId)
    .maybeSingle();
  if (error) throw error;
  return (data as RawSite | null) ?? null;
}

async function loadCompliance(jobId: string): Promise<RawComplianceReview | null> {
  const review = await fetchComplianceReview(jobId);
  if (!review) return null;
  return {
    permit_likelihood: review.permit_likelihood,
    jurisdiction_basis: review.jurisdiction?.basis ?? null,
    jurisdiction_coverage: review.jurisdiction?.coverage ?? null,
    requirements: (review.requirements ?? []).map((r) => ({ key: r.key, category: r.category, severity: r.severity })),
    item_progress: review.item_progress ?? {},
    verify_questions: review.verify_questions ?? [],
  };
}

/** Optional signal: any failure just means "no signal", never a false alarm. */
async function loadNoSurprise(jobId: string): Promise<RawNoSurprise | null> {
  try {
    const { data, error } = await supabase.from('no_surprise_requests').select('status').eq('job_id', jobId);
    if (error) return null;
    const rows = (data ?? []) as { status: string }[];
    return {
      pending: rows.filter((r) => r.status === 'pending').length,
      approved: rows.filter((r) => r.status === 'approved').length,
    };
  } catch {
    return null;
  }
}

export async function fetchResolutions(jobId: string): Promise<RawResolution[]> {
  const { data, error } = await supabase
    .from('job_unknown_resolutions')
    .select('dimension, resolution, value, note, resolved_by, resolved_at')
    .eq('job_id', jobId);
  if (error) throw error;
  return (data ?? []) as RawResolution[];
}

export async function fetchUnknownsInput(job: Job): Promise<UnknownsInput> {
  const [diagnosis, equipment, parts, site, compliance, noSurprise, resolutions] = await Promise.all([
    safe(() => loadDiagnosis(job.id), [] as RawDiagnosisSession[]),
    safe(() => loadEquipment(job.id), [] as RawEquipment[]),
    safe(() => loadParts(job.id), [] as RawJobPart[]),
    safe(() => loadSite(job.site_id ?? null), null as RawSite | null),
    safe(() => loadCompliance(job.id), null as RawComplianceReview | null),
    loadNoSurprise(job.id),
      fetchNetworkEvidence([job.id]),
    // Resolutions only ever add confidence, so on failure we fall back to none and stay conservative.
    fetchResolutions(job.id).catch(() => [] as RawResolution[]),
  ]);

  return {
    job: {
      id: job.id,
      job_status: job.job_status,
      service_type: str(job.service_type),
      dispatch_note: str(job.dispatch_note),
      address: str(job.address),
      latitude: num(job.latitude),
      longitude: num(job.longitude),
      site_id: job.site_id ?? null,
      customer_phone: str(job.customer_phone),
      quote_id: job.quote_id ?? null,
      invoice_amount: num(job.invoice_amount),
      technician_diagnosis: str(job.technician_diagnosis),
      diagnosis_notes: str(job.diagnosis_notes),
      before_photo_count: Array.isArray(job.before_photos) ? job.before_photos.length : 0,
    },
    diagnosis,
    equipment,
    parts,
    site,
    compliance,
    noSurprise,
    resolutions,
  };
}
network: network.get(job.id) ?? null,
export async function resolveUnknown(
  jobId: string,
  dimension: UnknownDimensionKey,
  kind: ResolutionKind,
  text: string,
): Promise<void> {
  const clean = text.trim();
  const row =
    kind === 'verified'
      ? { job_id: jobId, dimension, resolution: kind, value: clean, note: null }
      : { job_id: jobId, dimension, resolution: kind, value: null, note: clean };
  const { error } = await supabase.from('job_unknown_resolutions').upsert(row, { onConflict: 'job_id,dimension' });
  if (error) throw error;
}

export async function reopenUnknown(jobId: string, dimension: UnknownDimensionKey): Promise<void> {
  const { error } = await supabase
    .from('job_unknown_resolutions')
    .delete()
    .eq('job_id', jobId)
    .eq('dimension', dimension);
  if (error) throw error;
}

export interface UseJobUnknowns {
  report: UnknownsReport | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  resolve: (dimension: UnknownDimensionKey, kind: ResolutionKind, text: string) => Promise<void>;
  reopen: (dimension: UnknownDimensionKey) => Promise<void>;
}

/**
 * Loads evidence once per job (and when the job's status or evidence-bearing
 * fields change), keeps the latest request only, and re-scores locally after a
 * resolution so the UI updates without refetching every source.
 */
export function useJobUnknowns(job: Job, enabled: boolean): UseJobUnknowns {
  const [input, setInput] = useState<UnknownsInput | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [nonce, setNonce] = useState(0);

  const evidenceKey = [
    job.id,
    job.job_status,
    job.technician_diagnosis,
    job.diagnosis_notes,
    job.quote_id,
    job.invoice_amount,
    job.site_id,
    job.address,
    job.dispatch_note,
    Array.isArray(job.before_photos) ? job.before_photos.length : 0,
    nonce,
  ].join('|');

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetchUnknownsInput(job)
      .then((next) => {
        if (id === requestId.current) setInput(next);
      })
      .catch((e: unknown) => {
        if (id === requestId.current) setError(e instanceof Error ? e.message : 'Could not load unknowns.');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    return () => {
      requestId.current += 1;
    };
    // `job` is intentionally keyed through evidenceKey so unrelated job updates don't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, evidenceKey]);

  const report = useMemo(() => (input ? assessJobUnknowns(input) : null), [input]);

  const syncResolutions = useCallback(async () => {
    const resolutions = await fetchResolutions(job.id);
    setInput((prev) => (prev ? { ...prev, resolutions } : prev));
  }, [job.id]);

  const resolve = useCallback(
    async (dimension: UnknownDimensionKey, kind: ResolutionKind, text: string) => {
      await resolveUnknown(job.id, dimension, kind, text);
      await syncResolutions();
    },
    [job.id, syncResolutions],
  );

  const reopen = useCallback(
    async (dimension: UnknownDimensionKey) => {
      await reopenUnknown(job.id, dimension);
      await syncResolutions();
    },
    [job.id, syncResolutions],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { report, loading, error, refresh, resolve, reopen };
}
