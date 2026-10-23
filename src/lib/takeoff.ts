/**
 * AI Takeoff — client data layer.
 *
 * All math, pricing, confidence and tiering lives in the shared pure engine
 * (supabase/functions/_shared/takeoff/engine.ts) so what staff see on screen is
 * exactly what the edge function priced and what lands on the quote.
 * This file only talks to Supabase.
 */

import { supabase } from '@/lib/supabase';
import {
  buildQuoteDraft,
  buildQuotePayload,
  evaluateReviewGate,
  type ItemPatch,
  type ProjectInfo,
  type ProjectSettings,
  type TakeoffItem,
  type TakeoffRoom,
} from '../../supabase/functions/_shared/takeoff/engine';

export * from '../../supabase/functions/_shared/takeoff/engine';

export type TakeoffStatus = 'draft' | 'analyzing' | 'review' | 'converted' | 'failed';

export interface TakeoffFile {
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface TakeoffProject {
  id: string;
  account_owner_id: string;
  name: string;
  trade: string | null;
  notes: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  lead_id: string | null;
  status: TakeoffStatus;
  source_files: TakeoffFile[];
  ai_summary: string | null;
  plan_quality: 'clear' | 'fair' | 'poor' | null;
  scale_note: string | null;
  overall_confidence: number | null;
  assumptions: string[];
  missing_info: string[];
  warnings: string[];
  model: string | null;
  analysis_error: string | null;
  analysis_started_at: string | null;
  analyzed_at: string | null;
  markup_percent: number;
  labor_rate_cents: number;
  labor_cost_rate_cents: number | null;
  tax_percent: number;
  labor_overrides: Record<string, number>;
  detail_level: 'itemized' | 'summary';
  quote_id: string | null;
  converted_at: string | null;
  created_at: string;
}

export const TAKEOFF_LIMITS = { files: 8, fileBytes: 25 * 1024 * 1024 } as const;
export const TAKEOFF_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif';
const ALLOWED_MIME = new Set(TAKEOFF_ACCEPT.split(','));

export const STATUS_LABELS: Record<TakeoffStatus, string> = {
  draft: 'Ready to analyze',
  analyzing: 'Analyzing…',
  review: 'In review',
  converted: 'Quote created',
  failed: 'Analysis failed',
};

/** An analysis that has been "running" for over 10 minutes crashed; let the user retry. */
export function isStaleAnalysis(p: Pick<TakeoffProject, 'status' | 'analysis_started_at'>, now = Date.now()): boolean {
  return p.status === 'analyzing' && !!p.analysis_started_at && now - new Date(p.analysis_started_at).getTime() > 10 * 60 * 1000;
}

export function projectSettings(p: TakeoffProject): ProjectSettings {
  return {
    markup_percent: Number(p.markup_percent) || 0,
    labor_rate_cents: Number(p.labor_rate_cents) || 0,
    labor_cost_rate_cents: p.labor_cost_rate_cents != null ? Number(p.labor_cost_rate_cents) : null,
    tax_percent: Number(p.tax_percent) || 0,
    labor_overrides: p.labor_overrides ?? {},
    detail_level: p.detail_level,
  };
}

export function projectInfo(p: TakeoffProject): ProjectInfo {
  return {
    name: p.name,
    customer_name: p.customer_name,
    customer_phone: p.customer_phone,
    customer_email: p.customer_email,
    lead_id: p.lead_id,
    overall_confidence: p.overall_confidence,
    ai_summary: p.ai_summary,
  };
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// ---- mapping (PostgREST may hand numerics back as strings) ----------------

const n = (v: unknown): number => Number(v) || 0;
const nn = (v: unknown): number | null => (v == null ? null : Number(v));

export function mapItem(r: Record<string, unknown>): TakeoffItem {
  return {
    id: r.id as string,
    room_id: (r.room_id as string) ?? null,
    sort_order: n(r.sort_order),
    kind: r.kind as TakeoffItem['kind'],
    description: r.description as string,
    category: (r.category as string) ?? 'General',
    unit: (r.unit as string) ?? 'ea',
    net_quantity: n(r.net_quantity),
    waste_percent: n(r.waste_percent),
    quantity: n(r.quantity),
    ai_quantity: nn(r.ai_quantity),
    basis: r.basis as TakeoffItem['basis'],
    confidence: n(r.confidence),
    evidence: (r.evidence as string) ?? '',
    source_ref: (r.source_ref as string) ?? null,
    source: r.source as TakeoffItem['source'],
    tier_scope: r.tier_scope as TakeoffItem['tier_scope'],
    labor_hours_each: nn(r.labor_hours_each),
    labor_included: Boolean(r.labor_included),
    price_source: r.price_source as TakeoffItem['price_source'],
    price_locked: Boolean(r.price_locked),
    price_book_item_id: (r.price_book_item_id as string) ?? null,
    inventory_part_id: (r.inventory_part_id as string) ?? null,
    vendor_id: (r.vendor_id as string) ?? null,
    vendor_name: (r.vendor_name as string) ?? null,
    vendor_sku: (r.vendor_sku as string) ?? null,
    lead_time_days: nn(r.lead_time_days),
    unit_cost_cents: nn(r.unit_cost_cents),
    unit_price_cents: nn(r.unit_price_cents),
    price_confidence: n(r.price_confidence),
    match_status: r.match_status as TakeoffItem['match_status'],
    match_candidates: Array.isArray(r.match_candidates) ? (r.match_candidates as TakeoffItem['match_candidates']) : [],
    flags: Array.isArray(r.flags) ? (r.flags as string[]) : [],
    review_status: r.review_status as TakeoffItem['review_status'],
  };
}

function mapRoom(r: Record<string, unknown>): TakeoffRoom {
  return {
    id: r.id as string,
    name: r.name as string,
    room_type: (r.room_type as string) ?? 'other',
    level: (r.level as string) ?? 'Main',
    length_ft: nn(r.length_ft),
    width_ft: nn(r.width_ft),
    height_ft: nn(r.height_ft),
    area_sqft: nn(r.area_sqft),
    confidence: n(r.confidence),
    evidence: (r.evidence as string) ?? '',
    source_ref: (r.source_ref as string) ?? null,
    flags: Array.isArray(r.flags) ? (r.flags as string[]) : [],
  };
}

function mapProject(r: Record<string, unknown>): TakeoffProject {
  return {
    ...(r as unknown as TakeoffProject),
    source_files: Array.isArray(r.source_files) ? (r.source_files as TakeoffFile[]) : [],
    assumptions: Array.isArray(r.assumptions) ? (r.assumptions as string[]) : [],
    missing_info: Array.isArray(r.missing_info) ? (r.missing_info as string[]) : [],
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    labor_overrides: (r.labor_overrides as Record<string, number>) ?? {},
    markup_percent: n(r.markup_percent),
    labor_rate_cents: n(r.labor_rate_cents),
    labor_cost_rate_cents: nn(r.labor_cost_rate_cents),
    tax_percent: n(r.tax_percent),
    overall_confidence: nn(r.overall_confidence),
  };
}

// ---- reads ---------------------------------------------------------------

export async function listTakeoffs(): Promise<TakeoffProject[]> {
  const { data, error } = await supabase.from('takeoff_projects').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error('Could not load your takeoffs.');
  return (data ?? []).map((r) => mapProject(r as Record<string, unknown>));
}

export async function loadTakeoff(id: string): Promise<{ project: TakeoffProject; rooms: TakeoffRoom[]; items: TakeoffItem[] } | null> {
  const [p, r, i] = await Promise.all([
    supabase.from('takeoff_projects').select('*').eq('id', id).maybeSingle(),
    supabase.from('takeoff_rooms').select('*').eq('project_id', id).order('sort_order'),
    supabase.from('takeoff_items').select('*').eq('project_id', id).order('sort_order'),
  ]);
  if (p.error || r.error || i.error) throw new Error('Could not load this takeoff.');
  if (!p.data) return null;
  return {
    project: mapProject(p.data as Record<string, unknown>),
    rooms: (r.data ?? []).map((x) => mapRoom(x as Record<string, unknown>)),
    items: (i.data ?? []).map((x) => mapItem(x as Record<string, unknown>)),
  };
}

// ---- create / upload / analyze -------------------------------------------

export function validatePlanFile(file: File): string | null {
  if (!ALLOWED_MIME.has(file.type)) return `"${file.name}" is not supported. Use PDF, PNG, JPG, WebP or HEIC (export CAD files to PDF).`;
  if (file.size > TAKEOFF_LIMITS.fileBytes) return `"${file.name}" is over 25 MB.`;
  return null;
}

export async function createTakeoff(input: {
  ownerId: string;
  name: string;
  customerName: string;
  trade: string;
  notes: string;
  files: File[];
}): Promise<string> {
  const { data, error } = await supabase
    .from('takeoff_projects')
    .insert({
      name: input.name.trim(),
      customer_name: input.customerName.trim(),
      trade: input.trade.trim() || null,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error('Could not create the takeoff.');
  const id = data.id as string;

  const uploaded: TakeoffFile[] = [];
  try {
    for (const file of input.files) {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const path = `${input.ownerId}/${id}/${crypto.randomUUID()}-${safe}`;
      const { error: upErr } = await supabase.storage.from('takeoff-plans').upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw new Error(`Could not upload "${file.name}".`);
      uploaded.push({ path, name: file.name, mime: file.type, bytes: file.size });
    }
    const { error: updErr } = await supabase.from('takeoff_projects').update({ source_files: uploaded }).eq('id', id);
    if (updErr) throw new Error('Could not attach the files.');
  } catch (e) {
    // Don't leave an empty shell behind.
    if (uploaded.length) await supabase.storage.from('takeoff-plans').remove(uploaded.map((f) => f.path));
    await supabase.from('takeoff_projects').delete().eq('id', id);
    throw new Error(errMsg(e, 'Upload failed.'));
  }
  return id;
}

async function functionError(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function analyzeTakeoff(projectId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('takeoff-analyze', { body: { projectId } });
  if (error) throw new Error(await functionError(error, 'Could not reach the AI estimator. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.error));
}

// ---- edits (all human corrections are audited by a database trigger) ------

export async function saveProjectSettings(id: string, patch: Partial<Pick<TakeoffProject,
  'name' | 'customer_name' | 'customer_phone' | 'customer_email' | 'markup_percent' | 'labor_rate_cents' |
  'labor_cost_rate_cents' | 'tax_percent' | 'labor_overrides' | 'detail_level'>>): Promise<void> {
  const { error } = await supabase.from('takeoff_projects').update(patch).eq('id', id);
  if (error) throw new Error('Could not save settings.');
}

export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  const rest: Record<string, unknown> = { ...patch };
  delete rest.id;
  const { error } = await supabase.from('takeoff_items').update(rest).eq('id', id);
  if (error) throw new Error('Could not save that change.');
}

export async function updateManyPrices(changes: { id: string; unit_price_cents: number }[]): Promise<void> {
  for (const c of changes) {
    const { error } = await supabase.from('takeoff_items').update({ unit_price_cents: c.unit_price_cents }).eq('id', c.id);
    if (error) throw new Error('Could not re-price some lines.');
  }
}

export async function addItem(projectId: string, item: Omit<TakeoffItem, 'id'>): Promise<TakeoffItem> {
  const { data, error } = await supabase
    .from('takeoff_items')
    .insert({ ...item, project_id: projectId })
    .select('*')
    .single();
  if (error || !data) throw new Error('Could not add that line.');
  return mapItem(data as Record<string, unknown>);
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await supabase.from('takeoff_items').delete().eq('id', id);
  if (error) throw new Error('Could not remove that line.');
}

export async function deleteTakeoff(project: TakeoffProject): Promise<void> {
  const paths = project.source_files.map((f) => f.path);
  const { error } = await supabase.from('takeoff_projects').delete().eq('id', project.id);
  if (error) throw new Error('Could not delete this takeoff.');
  if (paths.length) await supabase.storage.from('takeoff-plans').remove(paths);
}

export async function getPlanUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('takeoff-plans').createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}

// ---- convert to a tiered draft quote -------------------------------------

/** Re-checks the human-in-the-loop gate, then creates ONE draft quote for this takeoff. */
export async function convertToQuote(input: {
  userId: string;
  project: TakeoffProject;
  items: TakeoffItem[];
}): Promise<string> {
  const settings = projectSettings(input.project);
  const gate = evaluateReviewGate(input.items, settings, projectInfo(input.project));
  if (!gate.canConvert) throw new Error(gate.blockers[0]?.message ?? 'This takeoff still needs review.');

  const draft = buildQuoteDraft(input.items, settings, () => crypto.randomUUID());
  const payload = buildQuotePayload({
    userId: input.userId,
    projectId: input.project.id,
    project: projectInfo(input.project),
    settings,
    draft,
  });

  let quoteId: string | null = null;
  const { data, error } = await supabase.from('quotes').insert(payload).select('id').single();
  if (error) {
    // 23505 = this takeoff already has a quote (double click / second tab): reuse it.
    if ((error as { code?: string }).code === '23505') {
      const { data: existing } = await supabase.from('quotes').select('id').eq('takeoff_project_id', input.project.id).maybeSingle();
      quoteId = (existing?.id as string) ?? null;
    }
    if (!quoteId) throw new Error('Could not create the quote.');
  } else {
    quoteId = data.id as string;
  }

  const { error: linkErr } = await supabase
    .from('takeoff_projects')
    .update({ status: 'converted', quote_id: quoteId, converted_at: new Date().toISOString(), approved_by: input.userId, approved_at: new Date().toISOString() })
    .eq('id', input.project.id);
  if (linkErr) throw new Error('The quote was created, but the takeoff could not be marked as converted.');
  return quoteId;
}
