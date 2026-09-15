/**
 * Tiered estimate builder (dashboard side).
 *
 * Builds a Good / Better / Best estimate with photos attached, then hands a
 * plain draft object back to the page, which owns the Supabase write. The
 * component itself only writes to storage (photo uploads) and to
 * `estimate_templates`, never to `quotes` — so the page keeps a single,
 * auditable save path.
 *
 * Used by src/pages/QuotesPage.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  BookmarkPlus,
  Camera,
  ChevronDown,
  Eye,
  ImagePlus,
  Loader2,
  Plus,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { Lead, Quote } from '@/lib/supabase';
import type { QuoteLineItem } from '@/lib/quotes';
import { formatCents } from '@/lib/quotes';
import type { PriceBookItem } from '@/lib/priceBook';
import {
  applyTemplate,
  createDefaultOptions,
  createEmptyOption,
  deleteQuotePhoto,
  depositCents,
  fetchEstimateTemplates,
  findOption,
  MAX_PHOTOS_PER_QUOTE,
  markTemplateUsed,
  normaliseOptions,
  optionTotals,
  PHOTO_KIND_LABELS,
  priceBookItemToLineItem,
  saveEstimateTemplate,
  TIER_META,
  TIER_ORDER,
  uploadQuotePhoto,
  validateEstimateOptions,
} from '@/lib/estimates';
import type { EstimateOption, EstimatePhoto, EstimatePhotoKind, EstimateTemplate, EstimateTier } from '@/lib/estimates';

// ============================================================
// DRAFT SHAPE — what the page saves
// ============================================================

export interface TieredEstimateDraft {
  /** Folder key for photo uploads. The quote id once saved, a uuid before that. */
  draft_id: string;
  lead_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  tax_percent: string;
  deposit_percent: string;
  valid_until: string;
  presentation_note: string;
  options: EstimateOption[];
  photos: EstimatePhoto[];
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyTieredDraft(): TieredEstimateDraft {
  return {
    draft_id: newDraftId(),
    lead_id: null,
    customer_name: '',
    customer_phone: '',
    customer_email: '',
    tax_percent: '0',
    deposit_percent: '0',
    valid_until: '',
    presentation_note: '',
    options: createDefaultOptions(),
    photos: [],
  };
}

/** Turns a saved quote back into an editable draft. */
export function quoteToTieredDraft(quote: Quote): TieredEstimateDraft {
  const options = (quote.options ?? []) as EstimateOption[];
  return {
    draft_id: quote.id,
    lead_id: quote.lead_id,
    customer_name: quote.customer_name,
    customer_phone: quote.customer_phone ?? '',
    customer_email: quote.customer_email ?? '',
    tax_percent: String(quote.tax_percent ?? 0),
    deposit_percent: String(quote.deposit_percent ?? 0),
    valid_until: quote.valid_until ?? '',
    presentation_note: quote.presentation_note ?? '',
    options: options.length > 0 ? options : createDefaultOptions(),
    photos: (quote.photos ?? []) as EstimatePhoto[],
  };
}

/**
 * The exact row payload for `quotes`. `line_items` is mirrored from the
 * recommended option so every existing consumer (the classic public page,
 * the follow-up tracker, reports) keeps working against a tiered quote.
 */
export function draftToQuotePayload(draft: TieredEstimateDraft, userId: string) {
  const options = normaliseOptions(draft.options);
  const recommended = options.find((o) => o.recommended) ?? options[0] ?? null;

  return {
    user_id: userId,
    lead_id: draft.lead_id,
    customer_name: draft.customer_name.trim(),
    customer_phone: draft.customer_phone.trim() || null,
    customer_email: draft.customer_email.trim() || null,
    line_items: (recommended?.line_items ?? []) as QuoteLineItem[],
    options,
    photos: draft.photos,
    recommended_option_id: recommended?.id ?? null,
    presentation_note: draft.presentation_note.trim() || null,
    tax_percent: Number(draft.tax_percent) || 0,
    deposit_percent: Number(draft.deposit_percent) || 0,
    valid_until: draft.valid_until || null,
  };
}

// ============================================================
// SHARED STYLES
// ============================================================

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

// ============================================================
// PHOTO STRIP
// ============================================================

function PhotoStrip({
  photos,
  options,
  uploading,
  onPick,
  onUpdate,
  onToggleOption,
  onRemove,
}: {
  photos: EstimatePhoto[];
  options: EstimateOption[];
  uploading: number;
  onPick: (files: FileList | null) => void;
  onUpdate: (id: string, patch: Partial<EstimatePhoto>) => void;
  onToggleOption: (photoId: string, optionId: string) => void;
  onRemove: (photo: EstimatePhoto) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const atLimit = photos.length >= MAX_PHOTOS_PER_QUOTE;

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Camera size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Photos of the job</h3>
        </div>
        <button
          type="button"
          disabled={atLimit || uploading > 0}
          onClick={() => fileRef.current?.click()}
          className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
        >
          {uploading > 0 ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
          {uploading > 0 ? `Uploading ${uploading}…` : 'Add photos'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        A photo of the corroded fitting or the cracked heat exchanger does more for a close rate than any
        wording on the estimate. Up to {MAX_PHOTOS_PER_QUOTE}; they are downscaled before upload.
      </p>

      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((photo) => (
            <div key={photo.id} className="overflow-hidden rounded-xl border border-border bg-bg-primary">
              <div className="relative">
                <img
                  src={photo.url}
                  alt={photo.caption || PHOTO_KIND_LABELS[photo.kind]}
                  loading="lazy"
                  className="h-28 w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemove(photo)}
                  aria-label="Remove photo"
                  className="focus-ring absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg bg-bg-primary/85 text-text-secondary backdrop-blur transition-colors hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="space-y-1.5 p-2">
                <input
                  type="text"
                  value={photo.caption}
                  onChange={(e) => onUpdate(photo.id, { caption: e.target.value })}
                  placeholder="Caption for the customer"
                  className="focus-ring w-full rounded-lg bg-transparent px-1 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
                />
                <div className="flex items-center gap-1.5">
                  <select
                    value={photo.kind}
                    onChange={(e) => onUpdate(photo.id, { kind: e.target.value as EstimatePhotoKind })}
                    className="focus-ring flex-1 rounded-lg border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-secondary"
                  >
                    {(Object.keys(PHOTO_KIND_LABELS) as EstimatePhotoKind[]).map((k) => (
                      <option key={k} value={k}>
                        {PHOTO_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  {options.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === photo.id ? null : photo.id)}
                      className="focus-ring rounded-lg border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
                    >
                      Shown on
                    </button>
                  )}
                </div>

                {expanded === photo.id && options.length > 1 && (
                  <div className="space-y-1 pt-1">
                    <p className="text-[10px] leading-relaxed text-text-secondary">
                      Nothing ticked = shown on every option.
                    </p>
                    {options.map((option) => {
                      const on = option.photo_ids.includes(photo.id);
                      return (
                        <label key={option.id} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => onToggleOption(photo.id, option.id)}
                            className="h-3 w-3 accent-current"
                          />
                          {option.name || TIER_META[option.tier].label}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================
// ONE OPTION CARD
// ============================================================

function OptionCard({
  option,
  index,
  taxPercent,
  depositPercent,
  priceBook,
  canRemove,
  onChange,
  onRemove,
  onRecommend,
}: {
  option: EstimateOption;
  index: number;
  taxPercent: number;
  depositPercent: number;
  priceBook: PriceBookItem[];
  canRemove: boolean;
  onChange: (patch: Partial<EstimateOption>) => void;
  onRemove: () => void;
  onRecommend: () => void;
}) {
  const [open, setOpen] = useState(true);
  const totals = optionTotals(option, taxPercent);
  const meta = TIER_META[option.tier];

  const updateLineItem = (i: number, patch: Partial<QuoteLineItem>) =>
    onChange({ line_items: option.line_items.map((li, li_i) => (li_i === i ? { ...li, ...patch } : li)) });

  const addLineItem = () =>
    onChange({ line_items: [...option.line_items, { description: '', quantity: 1, unit_price_cents: 0 }] });

  const removeLineItem = (i: number) =>
    onChange({ line_items: option.line_items.filter((_, li_i) => li_i !== i) });

  const addFromPriceBook = (itemId: string) => {
    const item = priceBook.find((p) => p.id === itemId);
    if (!item) return;
    const existing = option.line_items.filter((li) => li.description.trim());
    onChange({ line_items: [...existing, priceBookItemToLineItem(item)] });
  };

  return (
    <div className={`rounded-2xl border bg-bg-secondary ${option.recommended ? meta.ringClass : 'border-border'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left"
          aria-expanded={open}
        >
          <ChevronDown size={15} className={`shrink-0 text-text-secondary transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className={`text-xs font-semibold uppercase tracking-wide ${meta.accentClass}`}>{meta.label}</span>
          <span className="truncate text-sm font-semibold text-text-primary">{option.name || `Option ${index + 1}`}</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-text-primary">{formatCents(totals.totalCents)}</span>
          <button
            type="button"
            onClick={onRecommend}
            aria-pressed={option.recommended}
            title={option.recommended ? 'This is the recommended option' : 'Mark as recommended'}
            className={`focus-ring flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              option.recommended ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary'
            }`}
          >
            <Star size={14} fill={option.recommended ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label="Remove option"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border/60 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-secondary">Option name</label>
              <input
                type="text"
                value={option.name}
                onChange={(e) => onChange({ name: e.target.value })}
                placeholder={meta.defaultName}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-secondary">Tier</label>
              <select
                value={option.tier}
                onChange={(e) => onChange({ tier: e.target.value as EstimateTier })}
                className={inputClass}
              >
                {TIER_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TIER_META[t].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-text-secondary">One line the customer reads first</label>
            <input
              type="text"
              value={option.summary}
              onChange={(e) => onChange({ summary: e.target.value })}
              placeholder={meta.defaultSummary}
              className={inputClass}
            />
          </div>

          {/* Line items */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-text-secondary">Line items</p>
              {priceBook.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    addFromPriceBook(e.target.value);
                    e.target.value = '';
                  }}
                  className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary"
                >
                  <option value="">Add from price book…</option>
                  {priceBook.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.service_name} — {formatCents(item.price_cents)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {option.line_items.map((li, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={li.description}
                  onChange={(e) => updateLineItem(i, { description: e.target.value })}
                  placeholder="Description"
                  className={`${inputClass} flex-1`}
                />
                <input
                  type="number"
                  min={1}
                  value={li.quantity}
                  onChange={(e) => updateLineItem(i, { quantity: Number(e.target.value) })}
                  aria-label="Quantity"
                  className={`${inputClass} w-16 text-center`}
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={li.unit_price_cents / 100}
                  onChange={(e) => updateLineItem(i, { unit_price_cents: Math.round(Number(e.target.value) * 100) })}
                  aria-label="Unit price"
                  className={`${inputClass} w-24`}
                />
                <button
                  type="button"
                  onClick={() => removeLineItem(i)}
                  disabled={option.line_items.length === 1}
                  aria-label="Remove line item"
                  className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={addLineItem}
              className="focus-ring flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              <Plus size={12} /> Add line item
            </button>
          </div>

          {/* Highlights + warranty */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-text-secondary">What&rsquo;s included (one per line)</label>
              <textarea
                rows={3}
                value={option.highlights.join('\n')}
                onChange={(e) => onChange({ highlights: e.target.value.split('\n') })}
                placeholder={'Same-day install\nHaul-away included\nPermit filed for you'}
                className={`${inputClass} resize-y`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-secondary">Warranty</label>
              <input
                type="text"
                value={option.warranty_label ?? ''}
                onChange={(e) => onChange({ warranty_label: e.target.value })}
                placeholder="2-year parts & labour"
                className={inputClass}
              />
              <div className="mt-2 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
                Subtotal {formatCents(totals.subtotalCents)} · tax {formatCents(totals.taxCents)}
                {depositPercent > 0 && (
                  <> · deposit {formatCents(depositCents(totals.totalCents, depositPercent))}</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// BUILDER
// ============================================================

export function TieredEstimateBuilder({
  userId,
  initial,
  leadOptions,
  onCancel,
  onSave,
  onPreview,
}: {
  userId: string;
  initial?: TieredEstimateDraft | null;
  leadOptions: Lead[];
  onCancel: () => void;
  onSave: (draft: TieredEstimateDraft) => Promise<void>;
  /** Optional — opens the customer-facing preview the page renders. */
  onPreview?: (draft: TieredEstimateDraft) => void;
}) {
  const [draft, setDraft] = useState<TieredEstimateDraft>(() => initial ?? emptyTieredDraft());
  const [priceBook, setPriceBook] = useState<PriceBookItem[]>([]);
  const [templates, setTemplates] = useState<EstimateTemplate[]>([]);
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const taxPercent = Number(draft.tax_percent) || 0;
  const depositPercent = Number(draft.deposit_percent) || 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pb, tpl] = await Promise.all([
        supabase
          .from('price_book_items')
          .select('*')
          .eq('active', true)
          .order('sort_order', { ascending: true })
          .limit(200),
        fetchEstimateTemplates(),
      ]);
      if (cancelled) return;
      setPriceBook((pb.data as PriceBookItem[]) ?? []);
      setTemplates(tpl);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const errors = useMemo(
    () => validateEstimateOptions(draft.options, taxPercent),
    [draft.options, taxPercent]
  );

  const patch = useCallback((p: Partial<TieredEstimateDraft>) => setDraft((d) => ({ ...d, ...p })), []);

  const updateOption = (id: string, p: Partial<EstimateOption>) =>
    setDraft((d) => ({ ...d, options: d.options.map((o) => (o.id === id ? { ...o, ...p } : o)) }));

  const addOption = () => {
    const used = new Set(draft.options.map((o) => o.tier));
    const nextTier = TIER_ORDER.find((t) => !used.has(t)) ?? 'best';
    setDraft((d) => ({ ...d, options: [...d.options, createEmptyOption(nextTier)] }));
  };

  const removeOption = (id: string) =>
    setDraft((d) => ({ ...d, options: d.options.filter((o) => o.id !== id) }));

  const recommendOption = (id: string) =>
    setDraft((d) => ({ ...d, options: d.options.map((o) => ({ ...o, recommended: o.id === id })) }));

  // --- photos -------------------------------------------------
  const handlePickPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    const room = MAX_PHOTOS_PER_QUOTE - draft.photos.length;
    const chosen = Array.from(files).slice(0, Math.max(0, room));
    if (chosen.length === 0) return;

    setUploading(chosen.length);
    for (const file of chosen) {
      try {
        const photo = await uploadQuotePhoto(userId, draft.draft_id, file);
        setDraft((d) => ({ ...d, photos: [...d.photos, photo] }));
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'One photo failed to upload.');
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  };

  const updatePhoto = (id: string, p: Partial<EstimatePhoto>) =>
    setDraft((d) => ({ ...d, photos: d.photos.map((ph) => (ph.id === id ? { ...ph, ...p } : ph)) }));

  const togglePhotoOnOption = (photoId: string, optionId: string) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o) =>
        o.id !== optionId
          ? o
          : {
              ...o,
              photo_ids: o.photo_ids.includes(photoId)
                ? o.photo_ids.filter((p) => p !== photoId)
                : [...o.photo_ids, photoId],
            }
      ),
    }));

  const removePhoto = async (photo: EstimatePhoto) => {
    setDraft((d) => ({
      ...d,
      photos: d.photos.filter((p) => p.id !== photo.id),
      options: d.options.map((o) => ({ ...o, photo_ids: o.photo_ids.filter((id) => id !== photo.id) })),
    }));
    await deleteQuotePhoto(photo.path);
  };

  // --- templates ----------------------------------------------
  const handleApplyTemplate = async (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    setDraft((d) => ({
      ...d,
      options: applyTemplate(template),
      tax_percent: String(template.tax_percent ?? d.tax_percent),
      deposit_percent: String(template.deposit_percent ?? d.deposit_percent),
      presentation_note: template.presentation_note ?? d.presentation_note,
    }));
    await markTemplateUsed(template.id, template.use_count);
  };

  const handleSaveAsTemplate = async () => {
    const name = window.prompt('Name this package (e.g. "40-gal water heater ladder")');
    if (!name?.trim()) return;
    setSavingTemplate(true);
    await saveEstimateTemplate({
      userId,
      name,
      options: draft.options,
      taxPercent,
      depositPercent,
      presentationNote: draft.presentation_note,
    });
    setTemplates(await fetchEstimateTemplates());
    setSavingTemplate(false);
  };

  // --- save ---------------------------------------------------
  const canSave = draft.customer_name.trim().length > 0 && errors.length === 0 && uploading === 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    await onSave({ ...draft, options: normaliseOptions(draft.options) });
    setSaving(false);
  };

  const recommended = findOption(draft.options, draft.options.find((o) => o.recommended)?.id ?? null);
  const headlineTotal = recommended ? optionTotals(recommended, taxPercent).totalCents : 0;

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-bg-primary p-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Sparkles size={15} className="text-accent" />
            Visual estimate — Good / Better / Best
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-secondary">
            Give the customer a choice between options instead of a yes-or-no on one number, and show them
            the photos behind it. They pick a tier on the link; the accepted total is recorded server-side.
          </p>
        </div>
        {templates.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              void handleApplyTemplate(e.target.value);
              e.target.value = '';
            }}
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary"
          >
            <option value="">Start from a saved package…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Customer */}
      {leadOptions.length > 0 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Link to an existing lead (optional)</label>
          <select
            value={draft.lead_id ?? ''}
            onChange={(e) => {
              const lead = leadOptions.find((l) => l.id === e.target.value);
              patch({
                lead_id: e.target.value || null,
                customer_name: lead ? lead.name : draft.customer_name,
                customer_phone: lead?.phone ?? draft.customer_phone,
              });
            }}
            className={inputClass}
          >
            <option value="">Not linked to a lead</option>
            {leadOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} {l.service_interested ? `— ${l.service_interested}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={draft.customer_name}
          onChange={(e) => patch({ customer_name: e.target.value })}
          placeholder="Customer name"
          className={inputClass}
        />
        <input
          type="tel"
          value={draft.customer_phone}
          onChange={(e) => patch({ customer_phone: e.target.value })}
          placeholder="Phone"
          className={inputClass}
        />
        <input
          type="email"
          value={draft.customer_email}
          onChange={(e) => patch({ customer_email: e.target.value })}
          placeholder="Email"
          className={inputClass}
        />
      </div>

      {/* Photos */}
      <PhotoStrip
        photos={draft.photos}
        options={draft.options}
        uploading={uploading}
        onPick={handlePickPhotos}
        onUpdate={updatePhoto}
        onToggleOption={togglePhotoOnOption}
        onRemove={(photo) => void removePhoto(photo)}
      />

      {uploadError && (
        <p className="flex items-center gap-1.5 text-xs text-danger">
          <AlertCircle size={12} /> {uploadError}
        </p>
      )}

      {/* Options */}
      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {draft.options.map((option, i) => (
            <motion.div
              key={option.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
            >
              <OptionCard
                option={option}
                index={i}
                taxPercent={taxPercent}
                depositPercent={depositPercent}
                priceBook={priceBook}
                canRemove={draft.options.length > 1}
                onChange={(p) => updateOption(option.id, p)}
                onRemove={() => removeOption(option.id)}
                onRecommend={() => recommendOption(option.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>

        {draft.options.length < 3 && (
          <button
            type="button"
            onClick={addOption}
            className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border py-3 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
          >
            <Plus size={13} /> Add an option
          </button>
        )}
      </div>

      {/* Terms */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Tax %</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={draft.tax_percent}
            onChange={(e) => patch({ tax_percent: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Deposit %</label>
          <input
            type="number"
            min={0}
            max={100}
            step="1"
            value={draft.deposit_percent}
            onChange={(e) => patch({ deposit_percent: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Valid until</label>
          <input
            type="date"
            value={draft.valid_until}
            onChange={(e) => patch({ valid_until: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-secondary">Note to the customer (optional)</label>
        <textarea
          rows={2}
          value={draft.presentation_note}
          onChange={(e) => patch({ presentation_note: e.target.value })}
          placeholder="What we found on site, and why we'd go with the middle option."
          className={`${inputClass} resize-y`}
        />
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warning-500/30 bg-warning-500/[0.06] px-3 py-2">
          {errors.map((e) => (
            <li key={e} className="flex items-start gap-1.5 text-xs text-text-secondary">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-warning-500" />
              {e}
            </li>
          ))}
        </ul>
      )}

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            Recommended option: {formatCents(headlineTotal)}
          </p>
          <p className="text-xs text-text-secondary">
            {draft.options.length} option{draft.options.length === 1 ? '' : 's'} · {draft.photos.length} photo
            {draft.photos.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSaveAsTemplate()}
            disabled={savingTemplate || errors.length > 0}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <BookmarkPlus size={13} /> Save as package
          </button>
          {onPreview && (
            <button
              type="button"
              onClick={() => onPreview(draft)}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              <Eye size={13} /> Preview
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave || saving}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save estimate
          </button>
        </div>
      </div>
    </div>
  );
}
