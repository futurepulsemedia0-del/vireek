/**
 * AR Product Visualizer - pure client helpers (no network, no Supabase).
 *
 * Limits and validation come from the SAME engine the edge function uses, so
 * the UI can never accept something the server will reject (or vice versa).
 */

import {
  AR_CATEGORIES,
  AR_CATEGORY_LABELS,
  AR_PLACEMENTS,
  MAX_CLEARANCE_MM,
  MAX_DIMENSION_MM,
  MAX_MODEL_BYTES,
  MAX_PREVIEWS_PER_QUOTE,
  MIN_DIMENSION_MM,
  buildModelPath,
  cmToMm,
  compareScale,
  detectPlatform,
  formatDimensions,
  formatLength,
  inchesToMm,
  metersToDimensions,
  mimeForKind,
  validateDimensions,
  validateModelFiles,
  type ArCategory,
  type ArEvent,
  type ArPlacement,
  type ArPlatform,
  type ArUnit,
  type Dimensions,
  type ModelKind,
} from '../../supabase/functions/_shared/quote-ar/engine';

export {
  AR_CATEGORIES,
  AR_CATEGORY_LABELS,
  AR_PLACEMENTS,
  MAX_CLEARANCE_MM,
  MAX_DIMENSION_MM,
  MAX_MODEL_BYTES,
  MAX_PREVIEWS_PER_QUOTE,
  MIN_DIMENSION_MM,
  buildModelPath,
  cmToMm,
  compareScale,
  detectPlatform,
  formatDimensions,
  formatLength,
  inchesToMm,
  metersToDimensions,
  mimeForKind,
  validateDimensions,
  validateModelFiles,
};
export type { ArCategory, ArEvent, ArPlacement, ArPlatform, ArUnit, Dimensions, ModelKind };

/** Technician-side library row (RLS-scoped select on quote_ar_models). */
export interface ArModelRow {
  id: string;
  name: string;
  brand: string | null;
  model_number: string | null;
  category: ArCategory;
  placement: ArPlacement;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  clearance_mm: number;
  glb_path: string;
  usdz_path: string | null;
  glb_size_bytes: number;
  usdz_size_bytes: number | null;
  created_at: string;
}

/** Technician-side attachment row, with its model embedded. */
export interface ArPreviewRow {
  id: string;
  quote_id: string;
  model_id: string;
  option_id: string | null;
  view_count: number;
  ar_launch_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  last_ar_at: string | null;
  created_at: string;
  model: ArModelRow | null;
}

/** Customer-side item from the `quote-ar-public` edge function. */
export interface PublicArPreview {
  id: string;
  option_id: string | null;
  name: string;
  brand: string | null;
  model_number: string | null;
  category: ArCategory;
  placement: ArPlacement;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  clearance_mm: number;
  glb_url: string;
  usdz_url: string | null;
}

export interface OptionRef {
  id: string;
  name: string;
}

export function modelDimensions(m: Pick<ArModelRow, 'width_mm' | 'depth_mm' | 'height_mm'>): Dimensions {
  return { widthMm: m.width_mm, depthMm: m.depth_mm, heightMm: m.height_mm };
}

export function publicDimensions(p: Pick<PublicArPreview, 'width_mm' | 'depth_mm' | 'height_mm'>): Dimensions {
  return { widthMm: p.width_mm, depthMm: p.depth_mm, heightMm: p.height_mm };
}

/** Pulls `{id, name}` out of whatever shape `quote.options` has; never throws. */
export function optionRefs(raw: unknown): OptionRef[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : typeof e.tier === 'string' ? e.tier : 'Option';
    out.push({ id: e.id, name });
  }
  return out;
}

/** null = "all options"; an option that no longer exists reads as "Removed option". */
export function optionLabel(optionId: string | null, refs: OptionRef[]): string {
  if (optionId === null) return 'All options';
  return refs.find((r) => r.id === optionId)?.name ?? 'Removed option';
}

/** "Carrier · 24ACC636A003" - whatever of brand / model number is present. */
export function modelSubtitle(m: { brand: string | null; model_number: string | null }): string {
  return [m.brand, m.model_number].filter((v): v is string => Boolean(v && v.trim())).join(' · ');
}

/** Parses a dimension typed by a person ("32", "32.5") in the chosen unit into whole millimetres. */
export function parseLengthInput(raw: string, unit: ArUnit): number | null {
  const n = Number(raw.trim().replace(',', '.'));
  if (!raw.trim() || !Number.isFinite(n) || n <= 0) return null;
  return unit === 'in' ? inchesToMm(n) : cmToMm(n);
}

export type ArTone = 'neutral' | 'warning' | 'success';

export function describeArEngagement(p: Pick<ArPreviewRow, 'view_count' | 'ar_launch_count'>): { label: string; tone: ArTone } {
  if (p.ar_launch_count > 0) {
    return { label: `Tried in AR${p.ar_launch_count > 1 ? ` ×${p.ar_launch_count}` : ''}`, tone: 'success' };
  }
  if (p.view_count > 0) return { label: `Viewed${p.view_count > 1 ? ` ×${p.view_count}` : ''}`, tone: 'warning' };
  return { label: 'Not opened yet', tone: 'neutral' };
}

const ERROR_COPY: Record<string, string> = {
  FORBIDDEN: "You don't have permission to manage AR previews.",
  MODEL_NOT_FOUND: 'That model is no longer in your library. Refresh and try again.',
  NOT_FOUND: 'That item no longer exists. Refresh and try again.',
  NAME_REQUIRED: 'Give the model a name.',
  NAME_TOO_LONG: 'The model name is too long (120 characters max).',
  INVALID_CATEGORY: 'Pick an equipment type.',
  INVALID_PLACEMENT: 'Pick floor or wall placement.',
  INVALID_DIMENSIONS: 'Enter the real width, depth and height (10 mm to 6 m).',
  INVALID_CLEARANCE: 'Service clearance must be between 0 and 3 m.',
  INVALID_PATH: 'The upload path was rejected. Please try again.',
  INVALID_SIZE: 'The file is empty or larger than 40 MB.',
  INVALID_OPTION: 'That option no longer exists on this quote.',
  UPLOAD_MISSING: 'The upload did not finish. Please try again.',
  QUOTE_CLOSED: 'This quote has been answered, so previews can no longer be changed.',
  PREVIEW_LIMIT: `A quote can have ${MAX_PREVIEWS_PER_QUOTE} AR previews at most. Remove one first.`,
  MODEL_LIMIT: 'Your model library is full (200). Archive unused models first.',
  GLB_REQUIRED: 'Choose a .glb file.',
  GLB_TYPE: 'The main model must be a .glb file.',
  USDZ_TYPE: 'The iPhone file must be a .usdz file.',
  FILE_EMPTY: 'That file is empty.',
  FILE_TOO_LARGE: 'Files must be 40 MB or smaller. Compress textures and try again.',
  UPLOAD_FAILED: 'Upload failed. Check your connection and try again.',
  SIGN_FAILED: 'Could not load the preview. Please try again.',
  INTERNAL: 'Something went wrong. Please try again.',
};

export function friendlyArError(code: string | null | undefined, fallback?: string): string {
  if (!code) return fallback ?? ERROR_COPY.INTERNAL;
  const known = Object.keys(ERROR_COPY).find((k) => code.includes(k));
  return known ? ERROR_COPY[known] : (fallback ?? ERROR_COPY.INTERNAL);
}
