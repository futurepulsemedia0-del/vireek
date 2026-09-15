/**
 * Visual + Tiered Estimates — shared domain logic.
 *
 * One place for the shape of a tiered estimate, the money math, and the
 * photo pipeline, so the dashboard builder and the public customer page can
 * never drift apart on what a total means.
 *
 * Money is integer cents everywhere. The only float allowed near a price is
 * a tax/deposit percentage, and it is rounded back to cents immediately.
 *
 * Server-side counterparts live in
 * supabase/migrations/20260920000000_visual_tiered_estimates.sql —
 * `quote_option_total_cents()` mirrors `optionTotals()` exactly. If you
 * change one, change the other.
 */

import { supabase } from '@/lib/supabase';
import type { QuoteLineItem } from '@/lib/quotes';
import type { PriceBookItem } from '@/lib/priceBook';

// ============================================================
// TYPES
// ============================================================

export type EstimateTier = 'good' | 'better' | 'best';

export type EstimatePhotoKind = 'problem' | 'solution' | 'equipment' | 'other';

export interface EstimatePhoto {
  /** Stable client id; referenced by EstimateOption.photo_ids. */
  id: string;
  /** Storage object path inside the `quote-photos` bucket. */
  path: string;
  /** Resolved public URL — cached so the customer page needs no extra round trip. */
  url: string;
  caption: string;
  kind: EstimatePhotoKind;
  created_at: string;
}

export interface EstimateOption {
  id: string;
  tier: EstimateTier;
  /** Customer-facing name, e.g. "Standard repair". Falls back to the tier label. */
  name: string;
  /** One line under the name explaining who this option is for. */
  summary: string;
  line_items: QuoteLineItem[];
  /** Short bullets shown on the card — what's included, what isn't. */
  highlights: string[];
  /** e.g. "2-year parts & labour". Null when the business offers none. */
  warranty_label: string | null;
  /** Which of the quote's photos belong to this option. Empty = show all. */
  photo_ids: string[];
  recommended: boolean;
}

export interface EstimateTemplate {
  id: string;
  user_id: string;
  name: string;
  category: string | null;
  options: EstimateOption[];
  tax_percent: number;
  deposit_percent: number;
  presentation_note: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface QuoteEvent {
  id: string;
  quote_id: string;
  event_type: 'viewed' | 'option_selected' | 'accepted' | 'declined';
  option_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface OptionTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

// ============================================================
// TIER METADATA
// ============================================================

export const TIER_ORDER: EstimateTier[] = ['good', 'better', 'best'];

export const TIER_META: Record<
  EstimateTier,
  { label: string; defaultName: string; defaultSummary: string; accentClass: string; ringClass: string }
> = {
  good: {
    label: 'Good',
    defaultName: 'Essential fix',
    defaultSummary: 'Solves the immediate problem at the lowest cost.',
    accentClass: 'text-text-secondary',
    ringClass: 'border-border',
  },
  better: {
    label: 'Better',
    defaultName: 'Recommended repair',
    defaultSummary: 'Fixes the cause, not just the symptom — the option most customers choose.',
    accentClass: 'text-accent',
    ringClass: 'border-accent/40',
  },
  best: {
    label: 'Best',
    defaultName: 'Complete replacement',
    defaultSummary: 'Longest life, best efficiency, strongest warranty.',
    accentClass: 'text-ai',
    ringClass: 'border-ai/40',
  },
};

export const PHOTO_KIND_LABELS: Record<EstimatePhotoKind, string> = {
  problem: 'The problem',
  solution: 'The fix',
  equipment: 'Equipment',
  other: 'Reference',
};

// ============================================================
// FACTORIES
// ============================================================

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyOption(tier: EstimateTier, recommended = false): EstimateOption {
  const meta = TIER_META[tier];
  return {
    id: newId(),
    tier,
    name: meta.defaultName,
    summary: meta.defaultSummary,
    line_items: [{ description: '', quantity: 1, unit_price_cents: 0 }],
    highlights: [],
    warranty_label: null,
    photo_ids: [],
    recommended,
  };
}

/** A sensible starting ladder: two options, the middle one recommended. */
export function createDefaultOptions(): EstimateOption[] {
  return [createEmptyOption('good'), createEmptyOption('better', true)];
}

export function priceBookItemToLineItem(item: PriceBookItem): QuoteLineItem {
  return {
    description: item.service_name,
    quantity: 1,
    unit_price_cents: item.price_cents,
  };
}

// ============================================================
// MONEY
// ============================================================

export function optionTotals(option: Pick<EstimateOption, 'line_items'>, taxPercent: number): OptionTotals {
  const subtotalCents = option.line_items.reduce(
    (sum, li) => sum + Math.max(0, li.quantity || 0) * Math.max(0, li.unit_price_cents || 0),
    0
  );
  const taxCents = Math.round((subtotalCents * (taxPercent || 0)) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function depositCents(totalCents: number, depositPercent: number): number {
  if (!depositPercent || depositPercent <= 0) return 0;
  return Math.round((totalCents * depositPercent) / 100);
}

/**
 * Indicative monthly payment for a financed job. Deliberately a plain
 * amortisation so the number is defensible; it is labelled as an estimate in
 * the UI and never presented as an approved offer.
 */
export function monthlyPaymentCents(totalCents: number, months = 24, annualRatePercent = 9.99): number {
  if (totalCents <= 0 || months <= 0) return 0;
  const monthlyRate = annualRatePercent / 100 / 12;
  if (monthlyRate === 0) return Math.round(totalCents / months);
  const factor = Math.pow(1 + monthlyRate, months);
  return Math.round((totalCents * monthlyRate * factor) / (factor - 1));
}

/** Sorted low → high by total; ties keep Good/Better/Best order. */
export function sortOptionsByValue(options: EstimateOption[], taxPercent: number): EstimateOption[] {
  return [...options].sort((a, b) => {
    const diff = optionTotals(a, taxPercent).totalCents - optionTotals(b, taxPercent).totalCents;
    if (diff !== 0) return diff;
    return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
  });
}

/** How much more this option costs than the cheapest one. 0 when it *is* the cheapest. */
export function upgradeGapCents(option: EstimateOption, options: EstimateOption[], taxPercent: number): number {
  if (options.length < 2) return 0;
  const cheapest = Math.min(...options.map((o) => optionTotals(o, taxPercent).totalCents));
  return Math.max(0, optionTotals(option, taxPercent).totalCents - cheapest);
}

export function findOption(options: EstimateOption[], optionId: string | null | undefined): EstimateOption | null {
  if (!optionId) return null;
  return options.find((o) => o.id === optionId) ?? null;
}

export function recommendedOption(options: EstimateOption[]): EstimateOption | null {
  return options.find((o) => o.recommended) ?? options[Math.min(1, options.length - 1)] ?? null;
}

export function photosForOption(photos: EstimatePhoto[], option: EstimateOption | null): EstimatePhoto[] {
  if (!option || option.photo_ids.length === 0) return photos;
  const wanted = new Set(option.photo_ids);
  return photos.filter((p) => wanted.has(p.id));
}

export function isTieredQuote(quote: { options?: unknown }): boolean {
  return Array.isArray(quote.options) && (quote.options as unknown[]).length > 0;
}

// ============================================================
// VALIDATION — run before anything is allowed to be sent
// ============================================================

export function validateEstimateOptions(options: EstimateOption[], taxPercent: number): string[] {
  const errors: string[] = [];

  if (options.length === 0) {
    errors.push('Add at least one option.');
    return errors;
  }
  if (options.length > 3) errors.push('Three options is the maximum — more choice lowers the close rate, it does not raise it.');
  if (options.filter((o) => o.recommended).length > 1) errors.push('Only one option can be marked as recommended.');

  const seenTiers = new Set<EstimateTier>();
  options.forEach((option, i) => {
    const position = option.name.trim() || `Option ${i + 1}`;
    if (seenTiers.has(option.tier)) errors.push(`Two options share the "${TIER_META[option.tier].label}" tier.`);
    seenTiers.add(option.tier);

    if (!option.name.trim()) errors.push(`${position} needs a name.`);
    const priced = option.line_items.filter((li) => li.description.trim());
    if (priced.length === 0) errors.push(`${position} has no line items.`);
    if (optionTotals({ line_items: priced }, taxPercent).totalCents <= 0) {
      errors.push(`${position} totals $0 — check the prices.`);
    }
  });

  return errors;
}

/** Strips blank line items and normalises the recommended flag to exactly one. */
export function normaliseOptions(options: EstimateOption[]): EstimateOption[] {
  const cleaned = options.map((o) => ({
    ...o,
    name: o.name.trim(),
    summary: o.summary.trim(),
    highlights: o.highlights.map((h) => h.trim()).filter(Boolean),
    warranty_label: o.warranty_label?.trim() || null,
    line_items: o.line_items
      .filter((li) => li.description.trim())
      .map((li) => ({
        description: li.description.trim(),
        quantity: Math.max(1, Math.round(li.quantity || 1)),
        unit_price_cents: Math.max(0, Math.round(li.unit_price_cents || 0)),
      })),
  }));

  const firstRecommended = cleaned.findIndex((o) => o.recommended);
  return cleaned.map((o, i) => ({ ...o, recommended: i === firstRecommended }));
}

// ============================================================
// PHOTOS
// ============================================================

const MAX_PHOTO_EDGE = 1600;
const PHOTO_QUALITY = 0.82;
export const MAX_PHOTOS_PER_QUOTE = 12;

/**
 * Downscales a phone photo before upload. A 12 MP HEIC off an iPhone is
 * ~4 MB and renders no better than a 1600px JPEG on an estimate page, so
 * this keeps the customer's page fast and the storage bill small.
 * Falls back to the original file if the canvas pipeline is unavailable.
 */
export async function compressImage(file: File): Promise<Blob> {
  if (typeof document === 'undefined' || !file.type.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY)
    );
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export function quotePhotoPublicUrl(path: string): string {
  return supabase.storage.from('quote-photos').getPublicUrl(path).data.publicUrl;
}

/**
 * Uploads one photo and returns the record to append to `quotes.photos`.
 * `draftId` is the quote id for a saved quote, or a client-generated uuid
 * for one that hasn't been saved yet — either way the object lands under
 * the uploader's own folder, which is what the storage policy checks.
 */
export async function uploadQuotePhoto(
  userId: string,
  draftId: string,
  file: File,
  kind: EstimatePhotoKind = 'problem'
): Promise<EstimatePhoto> {
  const body = await compressImage(file);
  const id = newId();
  const ext = body.type === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${userId}/${draftId}/${id}.${ext}`;

  const { error } = await supabase.storage.from('quote-photos').upload(path, body, {
    upsert: false,
    contentType: body.type || file.type || 'image/jpeg',
    cacheControl: '31536000',
  });
  if (error) throw error;

  return {
    id,
    path,
    url: quotePhotoPublicUrl(path),
    caption: '',
    kind,
    created_at: new Date().toISOString(),
  };
}

export async function deleteQuotePhoto(path: string): Promise<void> {
  await supabase.storage.from('quote-photos').remove([path]);
}

// ============================================================
// TEMPLATES
// ============================================================

export async function fetchEstimateTemplates(): Promise<EstimateTemplate[]> {
  const { data, error } = await supabase
    .from('estimate_templates')
    .select('*')
    .order('use_count', { ascending: false })
    .limit(50);
  if (error) return [];
  return (data as EstimateTemplate[]) ?? [];
}

export async function saveEstimateTemplate(input: {
  userId: string;
  name: string;
  category?: string | null;
  options: EstimateOption[];
  taxPercent: number;
  depositPercent: number;
  presentationNote?: string | null;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('estimate_templates').insert({
    user_id: input.userId,
    name: input.name.trim(),
    category: input.category?.trim() || null,
    // Fresh ids per option so applying a template twice can never collide.
    options: normaliseOptions(input.options).map((o) => ({ ...o, id: newId(), photo_ids: [] })),
    tax_percent: input.taxPercent,
    deposit_percent: input.depositPercent,
    presentation_note: input.presentationNote?.trim() || null,
  });
  return { error: error ? error.message : null };
}

/** Clones a template's options with new ids so edits never write back to the template. */
export function applyTemplate(template: EstimateTemplate): EstimateOption[] {
  return template.options.map((o) => ({ ...o, id: newId(), photo_ids: [] }));
}

export async function markTemplateUsed(templateId: string, currentCount: number): Promise<void> {
  await supabase.from('estimate_templates').update({ use_count: currentCount + 1 }).eq('id', templateId);
}

export async function deleteEstimateTemplate(templateId: string): Promise<void> {
  await supabase.from('estimate_templates').delete().eq('id', templateId);
}

// ============================================================
// ENGAGEMENT
// ============================================================

export async function fetchQuoteEvents(quoteId: string): Promise<QuoteEvent[]> {
  const { data, error } = await supabase
    .from('quote_events')
    .select('*')
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return [];
  return (data as QuoteEvent[]) ?? [];
}

/** "Opened 3× · last seen 2 hours ago" for the dashboard quote card. */
export function describeEngagement(quote: {
  view_count?: number | null;
  last_viewed_at?: string | null;
  status: string;
}): string | null {
  if (quote.status === 'draft') return null;
  const count = quote.view_count ?? 0;
  if (count === 0) return 'Not opened yet';

  const last = quote.last_viewed_at ? new Date(quote.last_viewed_at) : null;
  if (!last) return `Opened ${count}\u00d7`;

  const minutes = Math.floor((Date.now() - last.getTime()) / 60000);
  const ago =
    minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes}m ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago`
    : `${Math.floor(minutes / 1440)}d ago`;

  return `Opened ${count}\u00d7 \u00b7 last ${ago}`;
}
