import { supabase } from '@/lib/supabase';
import { buildThumbPath, docTotals, parseSketchDoc, type SketchDoc, type UnitSystem } from '@/lib/siteSketch';

export interface SketchListItem {
  id: string;
  title: string;
  unit: UnitSystem;
  job_id: string | null;
  quote_id: string | null;
  area_mm2: number;
  wall_mm: number;
  thumb: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface SiteSketchRecord extends SketchListItem {
  doc: SketchDoc;
}
export interface SaveSketchInput {
  id: string;
  title: string;
  doc: SketchDoc;
  jobId: string | null;
  quoteId: string | null;
  expectedRevision: number | null;
}
export interface AttachTarget { id: string; label: string }

const LIST_COLUMNS = 'id, title, unit, job_id, quote_id, area_mm2, wall_mm, thumb, revision, created_at, updated_at';
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

function toItem(r: Record<string, unknown>): SketchListItem {
  return {
    id: String(r.id),
    title: String(r.title ?? 'Untitled sketch'),
    unit: r.unit === 'metric' ? 'metric' : 'imperial',
    job_id: (r.job_id as string | null) ?? null,
    quote_id: (r.quote_id as string | null) ?? null,
    area_mm2: num(r.area_mm2),
    wall_mm: num(r.wall_mm),
    thumb: (r.thumb as string | null) ?? null,
    revision: num(r.revision) || 1,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function listSiteSketches(opts: { jobId?: string; quoteId?: string; search?: string; limit?: number } = {}): Promise<SketchListItem[]> {
  let q = supabase.from('site_sketches').select(LIST_COLUMNS).order('updated_at', { ascending: false }).limit(opts.limit ?? 100);
  if (opts.jobId) q = q.eq('job_id', opts.jobId);
  if (opts.quoteId) q = q.eq('quote_id', opts.quoteId);
  const term = opts.search?.trim();
  if (term) q = q.ilike('title', `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { data, error } = await q;
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map(toItem);
}

export async function fetchSiteSketch(id: string): Promise<SiteSketchRecord | null> {
  const { data, error } = await supabase.from('site_sketches').select(`${LIST_COLUMNS}, doc`).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const item = toItem(row);
  return { ...item, doc: parseSketchDoc(row.doc, item.unit) };
}

export async function saveSiteSketch(input: SaveSketchInput): Promise<{ id: string; revision: number; updatedAt: string }> {
  const totals = docTotals(input.doc);
  const { data, error } = await supabase.rpc('save_site_sketch', {
    p_id: input.id,
    p_title: input.title,
    p_doc: input.doc,
    p_job_id: input.jobId,
    p_quote_id: input.quoteId,
    p_area_mm2: Math.round(totals.floorAreaMm2),
    p_wall_mm: Math.round(totals.wallLengthMm),
    p_thumb: buildThumbPath(input.doc),
    p_unit: input.doc.unit,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { sketch_id: string; revision_no: number; saved_at: string } | null;
  if (!row) throw new Error('Save failed');
  return { id: row.sketch_id, revision: num(row.revision_no), updatedAt: row.saved_at };
}

export async function deleteSiteSketch(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_site_sketch', { p_id: id });
  if (error) throw error;
}

/** True when another device saved a newer revision first. */
export function isSketchConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'SK409' || /changed on another device/i.test(e?.message ?? '');
}

export function sketchErrorMessage(err: unknown): string {
  const m = (err as { message?: string } | null)?.message;
  return m && m.length < 160 ? m : 'Something went wrong. Please try again.';
}

export async function fetchAttachTargets(includeQuotes: boolean): Promise<{ jobs: AttachTarget[]; quotes: AttachTarget[] }> {
  const [jobs, quotes] = await Promise.all([
    supabase.from('jobs').select('id, customer_name').order('created_at', { ascending: false }).limit(50),
    includeQuotes
      ? supabase.from('quotes').select('id, customer_name').order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const map = (rows: unknown): AttachTarget[] =>
    ((rows as { id: string; customer_name: string | null }[] | null) ?? []).map((r) => ({ id: r.id, label: r.customer_name || 'Unnamed customer' }));
  return { jobs: map(jobs.data), quotes: map(quotes.data) };
}

export async function fetchTargetLabel(kind: 'job' | 'quote', id: string): Promise<string | null> {
  try {
    const { data } = await supabase.from(kind === 'job' ? 'jobs' : 'quotes').select('customer_name').eq('id', id).maybeSingle();
    return (data as { customer_name?: string | null } | null)?.customer_name ?? null;
  } catch {
    return null;
  }
}
