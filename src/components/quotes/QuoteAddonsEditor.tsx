import { useEffect, useState } from 'react';
import { Plus, Trash2, PackagePlus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/quotes';
import {
  ADDON_SUGGESTIONS,
  MAX_ADDON_PRICE_CENTS,
  MAX_ADDON_QUANTITY,
  MAX_OPTIONAL_ITEMS,
  createOptionalItem,
} from '@/lib/quoteAddons';
import type { QuoteOptionalItem } from '@/lib/quoteAddons';
import type { EstimateOption } from '@/lib/estimates';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

interface PartChoice {
  id: string;
  name: string;
  part_number: string | null;
}

function dollarsToCents(text: string): number {
  const n = Number(text.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_ADDON_PRICE_CENTS, Math.max(0, Math.round(n * 100)));
}

function AddonRow({
  item,
  options,
  parts,
  onChange,
  onRemove,
}: {
  item: QuoteOptionalItem;
  options: EstimateOption[];
  parts: PartChoice[];
  onChange: (patch: Partial<QuoteOptionalItem>) => void;
  onRemove: () => void;
}) {
  const [priceText, setPriceText] = useState(() => (item.unit_price_cents ? (item.unit_price_cents / 100).toFixed(2) : ''));

  const toggleOption = (id: string) =>
    onChange({
      option_ids: item.option_ids.includes(id) ? item.option_ids.filter((o) => o !== id) : [...item.option_ids, id],
    });

  return (
    <li className="space-y-3 rounded-xl border border-border bg-bg-secondary p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_7rem_5rem_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Name</label>
          <input
            value={item.name}
            maxLength={120}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Extended warranty"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Price ($)</label>
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => {
              setPriceText(e.target.value);
              onChange({ unit_price_cents: dollarsToCents(e.target.value) });
            }}
            placeholder="0.00"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Qty</label>
          <input
            type="number"
            min={1}
            max={MAX_ADDON_QUANTITY}
            value={item.quantity}
            onChange={(e) =>
              onChange({ quantity: Math.min(MAX_ADDON_QUANTITY, Math.max(1, Math.round(Number(e.target.value) || 1))) })
            }
            className={inputClass}
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${item.name || 'add-on'}`}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-secondary">Description shown to the customer (optional)</label>
        <input
          value={item.description}
          maxLength={400}
          onChange={(e) => onChange({ description: e.target.value })}
          className={inputClass}
        />
      </div>

      {options.length > 1 && (
        <fieldset>
          <legend className="mb-1 text-xs text-text-secondary">
            Offered with {item.option_ids.length === 0 ? 'every option' : 'selected options only'}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = item.option_ids.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleOption(o.id)}
                  className={`focus-ring rounded-full border px-3 py-1 text-xs transition-colors ${
                    on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {o.name.trim() || o.tier}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {parts.length > 0 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">
            Inventory part (optional) — when accepted it's added to the job's required parts
          </label>
          <select
            value={item.part_id ?? ''}
            onChange={(e) => onChange({ part_id: e.target.value || null })}
            className={inputClass}
          >
            <option value="">No linked part</option>
            {parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.part_number ? ` (${p.part_number})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </li>
  );
}

export function QuoteAddonsEditor({
  items,
  options,
  taxPercent,
  onChange,
}: {
  items: QuoteOptionalItem[];
  options: EstimateOption[];
  taxPercent: number;
  onChange: (items: QuoteOptionalItem[]) => void;
}) {
  const [parts, setParts] = useState<PartChoice[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('inventory_parts')
          .select('id, name, part_number')
          .eq('active', true)
          .order('name', { ascending: true })
          .limit(300);
        if (!cancelled) setParts((data as PartChoice[] | null) ?? []);
      } catch {
        /* inventory is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const atLimit = items.length >= MAX_OPTIONAL_ITEMS;
  const usedNames = new Set(items.map((i) => i.name.trim().toLowerCase()));
  const suggestions = ADDON_SUGGESTIONS.filter((s) => !usedNames.has(s.name.toLowerCase()));

  const update = (id: string, patch: Partial<QuoteOptionalItem>) =>
    onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  return (
    <section aria-labelledby="addons-editor-heading" className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="addons-editor-heading" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <PackagePlus size={15} className="text-accent" />
            Optional add-ons
          </h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-secondary">
            The customer can tick these on the quote link and see their total change. Accepted add-ons become job line
            items{parts.length > 0 ? ' (and required parts when linked)' : ''}. Tax ({taxPercent || 0}%) is applied to them.
          </p>
        </div>
        <button
          type="button"
          disabled={atLimit}
          onClick={() => onChange([...items, createOptionalItem()])}
          className="focus-ring flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
        >
          <Plus size={13} /> Add item
        </button>
      </div>

      {suggestions.length > 0 && !atLimit && (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Quick add">
          {suggestions.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onChange([...items, createOptionalItem(s)])}
              className="focus-ring rounded-full border border-dashed border-border px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
            >
              + {s.name}
            </button>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <AddonRow
              key={item.id}
              item={item}
              options={options}
              parts={parts}
              onChange={(patch) => update(item.id, patch)}
              onRemove={() => onChange(items.filter((i) => i.id !== item.id))}
            />
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <p className="mt-3 text-right text-xs text-text-secondary">
          If the customer picks everything:{' '}
          <span className="font-semibold text-text-primary">
            +{formatCents(items.filter((i) => i.name.trim()).reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0))}
          </span>{' '}
          before tax
        </p>
      )}
    </section>
  );
}
