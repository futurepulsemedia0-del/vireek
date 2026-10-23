import { useEffect, useState } from 'react';
import { Check, Trash2, Undo2, X } from 'lucide-react';
import { ConfidenceBadge } from '@/components/takeoff/ConfidenceBadge';
import {
  applyCandidate,
  applyManualPrice,
  applyQuantityEdit,
  formatCents,
  isUnpriced,
  lineTotalCents,
  requiresReview,
  type ItemPatch,
  type PriceCandidate,
  type TakeoffItem,
  type TierScope,
} from '@/lib/takeoff';

const SCOPE_LABEL: Record<TierScope, string> = { all: 'All tiers', better_plus: 'Better +', best_only: 'Best only' };
const BASIS_LABEL: Record<TakeoffItem['basis'], string> = {
  counted: 'Counted', measured: 'Measured', inferred: 'Inferred', assumed: 'Assumed', manual: 'Manual',
};
const FLAG_LABEL: Record<string, string> = {
  price_estimated: 'AI price estimate', no_price: 'No price', ambiguous_match: 'Check catalog match',
  starting_at: '"Starting at" price', price_range: 'Price is a range', possible_duplicate: 'Possible duplicate',
  quantity_outlier: 'Unusually large', labor_clamped: 'Labor hours adjusted', cost_missing: 'No supplier cost',
};

interface Props {
  item: TakeoffItem;
  markupPercent: number;
  canSeeCost: boolean;
  disabled: boolean;
  onPatch: (item: TakeoffItem, patch: ItemPatch) => void;
  onDelete: (item: TakeoffItem) => void;
}

const inputCls =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-50';

export function TakeoffItemRow({ item, markupPercent, canSeeCost, disabled, onPatch, onDelete }: Props) {
  const [qty, setQty] = useState(String(item.net_quantity));
  const [price, setPrice] = useState(item.unit_price_cents != null ? (item.unit_price_cents / 100).toFixed(2) : '');

  // Keep the inputs in sync when a different action (switch match, re-price) changes the line.
  useEffect(() => setQty(String(item.net_quantity)), [item.net_quantity]);
  useEffect(() => setPrice(item.unit_price_cents != null ? (item.unit_price_cents / 100).toFixed(2) : ''), [item.unit_price_cents]);

  const rejected = item.review_status === 'rejected';
  const needs = requiresReview(item);
  const unpriced = !rejected && isUnpriced(item);

  const commitQty = () => {
    const v = Number(qty);
    if (!Number.isFinite(v) || v <= 0) return setQty(String(item.net_quantity));
    if (v !== item.net_quantity) onPatch(item, applyQuantityEdit(item, { net_quantity: v }));
  };
  const commitPrice = () => {
    const dollars = Number(price);
    if (price.trim() === '' || !Number.isFinite(dollars) || dollars < 0) {
      return setPrice(item.unit_price_cents != null ? (item.unit_price_cents / 100).toFixed(2) : '');
    }
    const cents = Math.round(dollars * 100);
    if (cents !== item.unit_price_cents) onPatch(item, applyManualPrice(item, cents));
  };

  const alternatives = item.match_candidates.filter((c) => c.entry_id !== (item.inventory_part_id ?? item.price_book_item_id));
  const pickCandidate = (c: PriceCandidate) => onPatch(item, applyCandidate(item, c, markupPercent));

  return (
    <li className={`rounded-xl border p-3 ${rejected ? 'border-border/50 opacity-50' : needs || unpriced ? 'border-warning-500/40 bg-warning-500/5' : 'border-border'}`}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_88px_110px_120px_auto] md:items-start">
        <div className="min-w-0">
          <p className={`text-sm font-medium text-text-primary ${rejected ? 'line-through' : ''}`}>{item.description}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {item.category} · {BASIS_LABEL[item.basis]}
            {item.source_ref ? ` · ${item.source_ref}` : ''}
            {item.vendor_name ? ` · ${item.vendor_name}${item.lead_time_days != null ? ` (${item.lead_time_days}d)` : ''}` : ''}
          </p>
          {item.evidence && <p className="mt-1 text-xs italic text-text-secondary/80">“{item.evidence}”</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ConfidenceBadge confidence={item.confidence} reviewStatus={item.review_status} />
            {item.flags.filter((f) => FLAG_LABEL[f]).map((f) => (
              <span key={f} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{FLAG_LABEL[f]}</span>
            ))}
            {item.labor_included && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">Labor included in price</span>}
          </div>
        </div>

        <label className="text-xs text-text-secondary">
          Qty ({item.unit})
          <input className={inputCls} inputMode="decimal" value={qty} disabled={disabled || rejected}
            onChange={(e) => setQty(e.target.value)} onBlur={commitQty} aria-label={`Quantity for ${item.description}`} />
          <span className="mt-0.5 block">
            {item.waste_percent > 0 ? `+${item.waste_percent}% waste = ` : 'Billed: '}<strong className="text-text-primary">{item.quantity}</strong>
            {item.ai_quantity != null && item.ai_quantity !== item.net_quantity && <span> (AI: {item.ai_quantity})</span>}
          </span>
        </label>

        <label className="text-xs text-text-secondary">
          Unit price ($)
          <input className={`${inputCls} ${unpriced ? 'border-danger' : ''}`} inputMode="decimal" value={price} disabled={disabled || rejected}
            onChange={(e) => setPrice(e.target.value)} onBlur={commitPrice} aria-label={`Unit price for ${item.description}`} />
          <span className="mt-0.5 block">
            {item.price_source === 'price_book' ? 'Price book' : item.price_source === 'supplier_catalog' ? 'Supplier + markup' : item.price_source === 'ai_estimate' ? 'AI estimate' : item.price_source === 'manual' ? 'Manual' : 'Unpriced'}
            {canSeeCost && item.unit_cost_cents != null ? ` · cost ${formatCents(item.unit_cost_cents)}` : ''}
          </span>
        </label>

        <div className="text-xs text-text-secondary">
          <span className="block">Line total</span>
          <strong className="text-sm text-text-primary">{formatCents(lineTotalCents(item))}</strong>
          <label className="mt-1 block">
            <span className="sr-only">Included in</span>
            <select className={inputCls} value={item.tier_scope} disabled={disabled || rejected}
              onChange={(e) => onPatch(item, { tier_scope: e.target.value as TierScope })}>
              {(Object.keys(SCOPE_LABEL) as TierScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1 md:justify-end">
          {rejected ? (
            <button type="button" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" disabled={disabled}
              onClick={() => onPatch(item, { review_status: 'pending' })} title="Restore this line" aria-label="Restore line"><Undo2 size={16} /></button>
          ) : (
            <>
              {item.review_status === 'pending' && (
                <button type="button" className="focus-ring rounded-lg p-2 text-success-500 hover:bg-success-500/10" disabled={disabled}
                  onClick={() => onPatch(item, { review_status: 'confirmed' })} title="Confirm this line is correct" aria-label="Confirm line"><Check size={16} /></button>
              )}
              <button type="button" className="focus-ring rounded-lg p-2 text-danger hover:bg-danger/10" disabled={disabled}
                onClick={() => onPatch(item, { review_status: 'rejected' })} title="Remove from the estimate" aria-label="Reject line"><X size={16} /></button>
            </>
          )}
          {item.source === 'human' && (
            <button type="button" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" disabled={disabled}
              onClick={() => onDelete(item)} title="Delete this line" aria-label="Delete line"><Trash2 size={16} /></button>
          )}
        </div>
      </div>

      {!rejected && alternatives.length > 0 && (item.match_status !== 'matched' || unpriced) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-xs text-text-secondary">
          <span>Possible catalog matches:</span>
          {alternatives.map((c) => (
            <button key={`${c.source}-${c.entry_id}`} type="button" disabled={disabled}
              className="focus-ring rounded-full border border-border px-2.5 py-1 hover:border-accent hover:text-accent"
              onClick={() => pickCandidate(c)}>
              {c.name} · {Math.round(c.score * 100)}%
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
