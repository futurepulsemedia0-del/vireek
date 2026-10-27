/**
 * AR Product Visualizer - network layer.
 *
 * Technician side : RLS-scoped reads + SECURITY DEFINER RPCs.
 * Customer side   : ONLY the `quote-ar-public` edge function (no direct table / storage access).
 */

import { supabase } from '@/lib/supabase';
import {
  buildModelPath,
  friendlyArError,
  mimeForKind,
  validateDimensions,
  validateModelFiles,
  type ArCategory,
  type ArEvent,
  type ArModelRow,
  type ArPlacement,
  type ArPlatform,
  type ArPreviewRow,
  type Dimensions,
  type PublicArPreview,
} from '@/lib/quoteAr';

const BUCKET = 'quote-ar-models';
const PREVIEW_TTL_SECONDS = 600;

const MODEL_COLUMNS =
  'id, name, brand, model_number, category, placement, width_mm, depth_mm, height_mm, clearance_mm, glb_path, usdz_path, glb_size_bytes, usdz_size_bytes, created_at';
const PREVIEW_COLUMNS = `id, quote_id, model_id, option_id, view_count, ar_launch_count, first_viewed_at, last_viewed_at, last_ar_at, created_at, model:quote_ar_models(${MODEL_COLUMNS})`;

export class QuoteArError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'QuoteArError';
  }
}

function fail(code: string): never {
  throw new QuoteArError(code, friendlyArError(code));
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

// ============================================================
// TECHNICIAN
// ============================================================

export async function listArModels(ownerId: string): Promise<ArModelRow[]> {
  const { data, error } = await supabase
    .from('quote_ar_models')
    .select(MODEL_COLUMNS)
    .eq('user_id', ownerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ArModelRow[];
}

export async function listQuoteArPreviews(quoteId: string): Promise<ArPreviewRow[]> {
  const { data, error } = await supabase
    .from('quote_ar_previews')
    .select(PREVIEW_COLUMNS)
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ArPreviewRow[];
}

export interface UploadArModelInput {
  ownerId: string;
  name: string;
  brand: string;
  modelNumber: string;
  category: ArCategory;
  placement: ArPlacement;
  dimensions: Dimensions;
  clearanceMm: number;
  glb: File;
  usdz: File | null;
}

/** Uploads the file(s), then registers the model. The server re-verifies objects, paths and sizes. */
export async function uploadArModel(input: UploadArModelInput): Promise<ArModelRow> {
  const files = validateModelFiles(
    { fileName: input.glb.name, sizeBytes: input.glb.size },
    input.usdz ? { fileName: input.usdz.name, sizeBytes: input.usdz.size } : null,
  );
  if (!files.ok) fail(files.code);
  const dims = validateDimensions(input.dimensions, input.clearanceMm);
  if (!dims.ok) fail(dims.code);

  const id = randomId();
  const glbPath = buildModelPath(input.ownerId, id, 'glb');
  const usdzPath = input.usdz ? buildModelPath(input.ownerId, id, 'usdz') : null;
  const uploaded: string[] = [];
  const cleanup = () => supabase.storage.from(BUCKET).remove(uploaded).catch(() => undefined);

  const put = async (path: string, file: File, kind: 'glb' | 'usdz') => {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: false, contentType: mimeForKind(kind), cacheControl: '3600' });
    if (error) {
      await cleanup();
      fail('UPLOAD_FAILED');
    }
    uploaded.push(path);
  };

  await put(glbPath, input.glb, 'glb');
  if (usdzPath && input.usdz) await put(usdzPath, input.usdz, 'usdz');

  const { data, error } = await supabase.rpc('create_quote_ar_model', {
    p_name: input.name.trim(),
    p_brand: input.brand.trim() || null,
    p_model_number: input.modelNumber.trim() || null,
    p_category: input.category,
    p_placement: input.placement,
    p_width_mm: input.dimensions.widthMm,
    p_depth_mm: input.dimensions.depthMm,
    p_height_mm: input.dimensions.heightMm,
    p_clearance_mm: input.clearanceMm,
    p_glb_path: glbPath,
    p_usdz_path: usdzPath,
  });
  if (error) {
    // Registration failed: remove the unregistered files (allowed by the bucket's delete policy).
    await cleanup();
    fail(error.message);
  }
  return data as unknown as ArModelRow;
}

/** Archives the model (detaching it from every quote), then removes its files. */
export async function archiveArModel(modelId: string): Promise<void> {
  const { data, error } = await supabase.rpc('archive_quote_ar_model', { p_id: modelId });
  if (error) fail(error.message);
  const row = data as unknown as ArModelRow | null;
  const paths = [row?.glb_path, row?.usdz_path].filter((p): p is string => Boolean(p));
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => undefined);
}

export async function attachArModel(quoteId: string, modelId: string, optionId: string | null): Promise<void> {
  const { error } = await supabase.rpc('attach_quote_ar_model', {
    p_quote_id: quoteId,
    p_model_id: modelId,
    p_option_id: optionId,
  });
  if (error) fail(error.message);
}

export async function detachArPreview(previewId: string): Promise<void> {
  const { error } = await supabase.rpc('detach_quote_ar_preview', { p_id: previewId });
  if (error) fail(error.message);
}

/** Short-lived signed URL so the technician can preview + scale-check a library model. */
export async function signArModelPreview(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, PREVIEW_TTL_SECONDS);
  if (error || !data?.signedUrl) fail('SIGN_FAILED');
  return data.signedUrl;
}

// ============================================================
// CUSTOMER (public quote link)
// ============================================================

export interface PublicArState {
  previews: PublicArPreview[];
  quoteStatus: string;
}

/** Never throws: the AR section is supplementary and must not break the quote page. */
export async function fetchPublicArPreviews(token: string): Promise<PublicArState | null> {
  try {
    const { data, error } = await supabase.functions.invoke('quote-ar-public', { body: { action: 'list', token } });
    if (error || !data) return null;
    return {
      previews: (Array.isArray(data.previews) ? data.previews : []) as PublicArPreview[],
      quoteStatus: String(data.quote_status ?? ''),
    };
  } catch {
    return null;
  }
}

/** Fire-and-forget engagement tracking. Failures are silent by design. */
export function trackArEvent(token: string, previewId: string, event: ArEvent, platform: ArPlatform): void {
  try {
    void Promise.resolve(
      supabase.functions.invoke('quote-ar-public', {
        body: { action: 'event', token, preview_id: previewId, event, platform },
      }),
    ).catch(() => undefined);
  } catch {
    /* tracking must never throw */
  }
}
