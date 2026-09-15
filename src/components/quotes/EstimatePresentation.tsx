/**
 * The customer's side of a visual, tiered estimate.
 *
 * Rendered by src/pages/QuoteAcceptPage.tsx for any quote whose `options`
 * array is non-empty. Read-only by design: the only write it can trigger is
 * the token-scoped `respond_to_quote_by_token` RPC, and the accepted total
 * is recomputed in Postgres from the stored option — nothing here is
 * trusted with money.
 *
 * Also usable as a preview inside the dashboard by passing `readOnly`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, ShieldCheck, Sparkles, X, ZoomIn } from 'lucide-react';
import { formatCents } from '@/lib/quotes';
import type { PublicQuoteInfo } from '@/lib/quotes';
import {
  depositCents,
  monthlyPaymentCents,
  optionTotals,
  PHOTO_KIND_LABELS,
  photosForOption,
  sortOptionsByValue,
  TIER_META,
  upgradeGapCents,
} from '@/lib/estimates';
import type { EstimateOption, EstimatePhoto } from '@/lib/estimates';

// ============================================================
// LIGHTBOX
// ============================================================

function PhotoLightbox({
  photos,
  index,
  onClose,
  onNavigate,
}: {
  photos: EstimatePhoto[];
  index: number;
  onClose: () => void;
  onNavigate: (next: number) => void;
}) {
  const photo = photos[index];

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onNavigate((index + 1) % photos.length);
      if (e.key === 'ArrowLeft') onNavigate((index - 1 + photos.length) % photos.length);
    },
    [index, photos.length, onClose, onNavigate]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [handleKey]);

  if (!photo) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.caption || PHOTO_KIND_LABELS[photo.kind]}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="focus-ring absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white"
      >
        <X size={18} />
      </button>

      {photos.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate((index - 1 + photos.length) % photos.length);
            }}
            className="focus-ring absolute left-3 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-white"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate((index + 1) % photos.length);
            }}
            className="focus-ring absolute right-3 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-white"
          >
            <ChevronRight size={20} />
          </button>
        </>
      )}

      <figure className="max-h-full w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <img
          src={photo.url}
          alt={photo.caption || PHOTO_KIND_LABELS[photo.kind]}
          className="mx-auto max-h-[75vh] w-auto rounded-2xl object-contain"
        />
        <figcaption className="mt-3 text-center text-sm text-white/80">
          {photo.caption || PHOTO_KIND_LABELS[photo.kind]}
          {photos.length > 1 && (
            <span className="ml-2 text-white/50">
              {index + 1} / {photos.length}
            </span>
          )}
        </figcaption>
      </figure>
    </div>
  );
}

// ============================================================
// GALLERY
// ============================================================

function PhotoGallery({ photos, onOpen }: { photos: EstimatePhoto[]; onOpen: (i: number) => void }) {
  if (photos.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">What we found</h2>
      <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
        {photos.map((photo, i) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => onOpen(i)}
            className="focus-ring group relative w-56 shrink-0 snap-start overflow-hidden rounded-2xl border border-border bg-bg-secondary text-left"
          >
            <img
              src={photo.url}
              alt={photo.caption || PHOTO_KIND_LABELS[photo.kind]}
              loading="lazy"
              className="h-36 w-full object-cover"
            />
            <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-bg-primary/80 text-text-secondary opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              <ZoomIn size={13} />
            </span>
            <span className="block px-3 py-2">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-text-secondary/80">
                {PHOTO_KIND_LABELS[photo.kind]}
              </span>
              {photo.caption && (
                <span className="mt-0.5 block text-xs leading-snug text-text-primary">{photo.caption}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ============================================================
// OPTION CARD
// ============================================================

function OptionCard({
  option,
  options,
  taxPercent,
  depositPercent,
  photos,
  selected,
  disabled,
  onSelect,
  onOpenPhoto,
}: {
  option: EstimateOption;
  options: EstimateOption[];
  taxPercent: number;
  depositPercent: number;
  photos: EstimatePhoto[];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onOpenPhoto: (photo: EstimatePhoto) => void;
}) {
  const [showItems, setShowItems] = useState(false);
  const totals = optionTotals(option, taxPercent);
  const meta = TIER_META[option.tier];
  const gap = upgradeGapCents(option, options, taxPercent);
  const optionPhotos = photosForOption(photos, option).slice(0, 3);
  const deposit = depositCents(totals.totalCents, depositPercent);

  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`focus-ring relative flex cursor-pointer flex-col rounded-2xl border bg-bg-secondary p-5 text-left transition-all ${
        selected ? 'border-accent shadow-card dark:shadow-card-dark' : 'border-border hover:border-accent/40'
      } ${disabled ? 'cursor-default' : ''}`}
    >
      {option.recommended && (
        <span className="absolute -top-2.5 left-5 flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-white">
          <Sparkles size={10} /> Recommended
        </span>
      )}

      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={`text-[11px] font-semibold uppercase tracking-wide ${meta.accentClass}`}>{meta.label}</p>
          <h3 className="mt-0.5 text-base font-semibold text-text-primary">{option.name}</h3>
        </div>
        <span
          aria-hidden="true"
          className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
            selected ? 'border-accent bg-accent text-white' : 'border-border'
          }`}
        >
          {selected && <Check size={12} />}
        </span>
      </div>

      {option.summary && <p className="mt-2 text-sm leading-relaxed text-text-secondary">{option.summary}</p>}

      <p className="mt-4 text-2xl font-bold text-text-primary">{formatCents(totals.totalCents)}</p>
      <p className="text-xs text-text-secondary">
        {taxPercent > 0 ? `Includes ${formatCents(totals.taxCents)} tax` : 'Tax not applicable'}
        {gap > 0 && <> · {formatCents(gap)} more than the lowest option</>}
      </p>

      {option.highlights.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {option.highlights.map((h) => (
            <li key={h} className="flex items-start gap-2 text-sm text-text-secondary">
              <Check size={13} className="mt-1 shrink-0 text-success-500" />
              {h}
            </li>
          ))}
        </ul>
      )}

      {option.warranty_label && (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <ShieldCheck size={13} className="text-success-500" />
          {option.warranty_label}
        </p>
      )}

      {optionPhotos.length > 0 && (
        <div className="mt-4 flex gap-2">
          {optionPhotos.map((photo) => (
            <button
              key={photo.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenPhoto(photo);
              }}
              className="focus-ring h-14 w-14 overflow-hidden rounded-lg border border-border"
              aria-label={`View photo: ${photo.caption || PHOTO_KIND_LABELS[photo.kind]}`}
            >
              <img src={photo.url} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowItems((v) => !v);
          }}
          aria-expanded={showItems}
          className="focus-ring text-xs font-medium text-accent hover:underline"
        >
          {showItems ? 'Hide the breakdown' : `See what's in this (${option.line_items.length})`}
        </button>

        {showItems && (
          <div className="mt-2 space-y-1.5">
            {option.line_items.map((li, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-text-secondary">
                  {li.description}
                  {li.quantity > 1 && <span className="text-text-secondary/70"> × {li.quantity}</span>}
                </span>
                <span className="shrink-0 text-text-primary">
                  {formatCents(li.quantity * li.unit_price_cents)}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-border/60 pt-1.5 text-xs font-medium">
              <span className="text-text-secondary">Subtotal</span>
              <span className="text-text-primary">{formatCents(totals.subtotalCents)}</span>
            </div>
            {deposit > 0 && (
              <p className="text-[11px] text-text-secondary">
                {formatCents(deposit)} due at booking, the rest on completion.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PRESENTATION
// ============================================================

export function EstimatePresentation({
  quote,
  submitting,
  readOnly = false,
  onRespond,
}: {
  quote: PublicQuoteInfo;
  submitting?: boolean;
  /** Preview mode inside the dashboard — hides the accept/decline actions. */
  readOnly?: boolean;
  onRespond?: (response: 'accepted' | 'declined', optionId: string | null) => void;
}) {
  const taxPercent = quote.tax_percent ?? 0;
  const depositPercent = quote.deposit_percent ?? 0;
  const photos = (quote.photos ?? []) as EstimatePhoto[];

  const options = useMemo(
    () => sortOptionsByValue((quote.options ?? []) as EstimateOption[], taxPercent),
    [quote.options, taxPercent]
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    () => quote.recommended_option_id ?? options.find((o) => o.recommended)?.id ?? options[0]?.id ?? null
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const selected = options.find((o) => o.id === selectedId) ?? null;
  const selectedTotals = selected ? optionTotals(selected, taxPercent) : null;
  const deposit = selectedTotals ? depositCents(selectedTotals.totalCents, depositPercent) : 0;
  const monthly = selectedTotals ? monthlyPaymentCents(selectedTotals.totalCents) : 0;

  const validUntil = quote.valid_until
    ? new Date(quote.valid_until).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="w-full">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Estimate from {quote.business_name ?? 'us'}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-text-primary">Prepared for {quote.customer_name}</h1>
        {validUntil && <p className="mt-1 text-sm text-text-secondary">Valid until {validUntil}</p>}
      </header>

      {quote.presentation_note && (
        <p className="mb-6 rounded-2xl border border-border bg-bg-secondary px-4 py-3 text-sm leading-relaxed text-text-secondary">
          {quote.presentation_note}
        </p>
      )}

      <PhotoGallery photos={photos} onOpen={setLightboxIndex} />

      <section aria-label="Your options">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">
          {options.length > 1 ? 'Choose the option that suits you' : 'Your estimate'}
        </h2>

        <div
          role="radiogroup"
          aria-label="Estimate options"
          className={`grid gap-4 ${options.length > 1 ? 'md:grid-cols-2' : ''} ${
            options.length > 2 ? 'lg:grid-cols-3 md:grid-cols-3' : ''
          }`}
        >
          {options.map((option) => (
            <OptionCard
              key={option.id}
              option={option}
              options={options}
              taxPercent={taxPercent}
              depositPercent={depositPercent}
              photos={photos}
              selected={option.id === selectedId}
              disabled={readOnly}
              onSelect={() => setSelectedId(option.id)}
              onOpenPhoto={(photo) => setLightboxIndex(photos.findIndex((p) => p.id === photo.id))}
            />
          ))}
        </div>
      </section>

      {(quote.financing_note || quote.financing_partner_name) && selectedTotals && (
        <p className="mt-4 rounded-2xl border border-accent/25 bg-accent/5 px-4 py-3 text-xs leading-relaxed text-text-secondary">
          <span className="font-semibold text-text-primary">
            Financing available{quote.financing_partner_name ? ` through ${quote.financing_partner_name}` : ''}.
          </span>{' '}
          {quote.financing_note || `Roughly ${formatCents(monthly)}/month over 24 months, subject to approval.`}
        </p>
      )}

      {!readOnly && selectedTotals && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="sticky bottom-4 mt-6 rounded-2xl border border-border bg-bg-secondary/95 p-4 shadow-card backdrop-blur dark:shadow-card-dark"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-text-secondary">
                {selected?.name} {options.length > 1 && '· change your choice above'}
              </p>
              <p className="text-xl font-bold text-text-primary">{formatCents(selectedTotals.totalCents)}</p>
              {deposit > 0 && (
                <p className="text-xs text-text-secondary">{formatCents(deposit)} deposit to book</p>
              )}
            </div>

            <div className="flex flex-1 gap-2 sm:flex-none">
              <button
                type="button"
                disabled={submitting}
                onClick={() => onRespond?.('declined', null)}
                className="focus-ring flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50 sm:flex-none"
              >
                Not right now
              </button>
              <button
                type="button"
                disabled={submitting || !selected}
                onClick={() => onRespond?.('accepted', selected?.id ?? null)}
                className="focus-ring flex-1 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 sm:flex-none"
              >
                {submitting ? 'Sending…' : 'Approve this option'}
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {lightboxIndex !== null && lightboxIndex >= 0 && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </div>
  );
}
