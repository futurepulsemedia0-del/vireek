import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { formatItemPrice } from '@/lib/priceBook';
import {
  DEFAULT_DISCLAIMER,
  ESTIMATOR_LEAD_SOURCE,
  ESTIMATOR_LIMITS,
  isPublishable,
  type CatalogItem,
  type EstimatorErrors,
  type EstimatorOptions,
} from '@/lib/websiteEstimator';

const fieldCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';

interface Props {
  options: EstimatorOptions;
  /** null = still loading or failed to load. */
  catalog: CatalogItem[] | null;
  catalogLoading: boolean;
  catalogFailed: boolean;
  errors: EstimatorErrors;
  onChange: (patch: Partial<EstimatorOptions>) => void;
  onRefreshCatalog: () => void;
}

function Hint({ error, hint }: { error?: string; hint?: string }) {
  if (error) return <p role="alert" className="mt-1 text-xs text-danger">{error}</p>;
  return hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null;
}

/** Everything specific to the "Price estimator" widget type: which price-book services to publish + pricing rules + form rules. */
export function EstimatorOptionsCard({ options, catalog, catalogLoading, catalogFailed, errors, onChange, onRefreshCatalog }: Props) {
  const [query, setQuery] = useState('');
  const byId = useMemo(() => new Map((catalog ?? []).map((c) => [c.id, c])), [catalog]);
  const selected = useMemo(() => new Set(options.items.map((i) => i.id)), [options.items]);
  const atLimit = options.items.length >= ESTIMATOR_LIMITS.items;

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog ?? [])
      .filter((c) => c.active && c.price_cents > 0 && !selected.has(c.id))
      .filter((c) => !q || c.service_name.toLowerCase().includes(q) || (c.category ?? '').toLowerCase().includes(q));
  }, [catalog, selected, query]);

  const add = (c: CatalogItem) => {
    if (atLimit || selected.has(c.id)) return;
    onChange({ items: [...options.items, { id: c.id, label: '' }] });
  };
  const remove = (id: string) => onChange({ items: options.items.filter((i) => i.id !== id) });
  const rename = (id: string, label: string) => onChange({ items: options.items.map((i) => (i.id === id ? { ...i, label: label.slice(0, ESTIMATOR_LIMITS.itemLabel) } : i)) });
  const move = (index: number, dir: -1 | 1) => {
    const next = [...options.items];
    const to = index + dir;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onChange({ items: next });
  };

  return (
    <Card className="space-y-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Services &amp; prices</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Visitors only see services you publish here. Prices are read live from your <Link to="/dashboard/price-book" className="font-medium text-accent underline">Price Book</Link>, so your website can never show an outdated price.
          </p>
        </div>
        <button type="button" onClick={onRefreshCatalog} disabled={catalogLoading} aria-label="Reload price book" className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
          <RefreshCw size={13} className={catalogLoading ? 'animate-spin' : ''} /> Reload
        </button>
      </div>

      {/* Published services */}
      <div>
        <p className={labelCls}>Published on your website ({options.items.length}/{ESTIMATOR_LIMITS.items})</p>
        {options.items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-secondary">Select services below to publish them. The widget stays hidden until you do.</p>
        ) : (
          <ul className="space-y-2">
            {options.items.map((ref, index) => {
              const c = byId.get(ref.id);
              const live = isPublishable(c);
              const problem = catalog === null ? null : !c ? 'Deleted from your price book' : !c.active ? 'Inactive in your price book' : c.price_cents <= 0 ? 'Priced at $0' : null;
              return (
                <li key={ref.id} className={`rounded-xl border p-3 ${problem ? 'border-warning-500/50 bg-warning-500/5' : 'border-border bg-bg-primary'}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="truncate text-sm font-medium text-text-primary">{c ? c.service_name : 'Unknown service'}</span>
                        {live && c && <span className="text-xs text-text-secondary">{formatItemPrice(c)}</span>}
                      </div>
                      <input
                        value={ref.label}
                        onChange={(e) => rename(ref.id, e.target.value)}
                        maxLength={ESTIMATOR_LIMITS.itemLabel}
                        placeholder="Public name (optional) — defaults to the price-book name"
                        aria-label={`Public name for ${c ? c.service_name : 'service'}`}
                        className={fieldCls}
                      />
                      {problem && <p className="flex items-center gap-1.5 text-xs text-text-primary"><AlertTriangle size={12} className="shrink-0 text-warning-500" /> {problem} — hidden from visitors.</p>}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up" className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-30"><ArrowUp size={13} /></button>
                      <button type="button" onClick={() => move(index, 1)} disabled={index === options.items.length - 1} aria-label="Move down" className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-30"><ArrowDown size={13} /></button>
                      <button type="button" onClick={() => remove(ref.id)} aria-label="Remove from website" className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-danger"><X size={13} /></button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Hint error={errors.items ?? errors.item_label} />
      </div>

      {/* Picker */}
      <div>
        <label htmlFor="estimator-search" className={labelCls}>Add from your price book</label>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <input id="estimator-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services or categories" className={`${fieldCls} pl-9`} />
        </div>
        <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-border bg-bg-primary" aria-busy={catalogLoading}>
          {catalogLoading && catalog === null ? (
            <div className="space-y-2 p-3" aria-label="Loading price book">{[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-bg-tertiary" />)}</div>
          ) : catalogFailed ? (
            <p role="alert" className="p-4 text-center text-xs text-danger">Couldn’t load your price book. Use “Reload” to try again.</p>
          ) : (catalog ?? []).length === 0 ? (
            <p className="p-4 text-center text-xs text-text-secondary">Your price book is empty. <Link to="/dashboard/price-book" className="font-medium text-accent underline">Add your services</Link> first, then come back.</p>
          ) : available.length === 0 ? (
            <p className="p-4 text-center text-xs text-text-secondary">{query ? 'Nothing matches that search.' : 'Every active, priced service is already published.'}</p>
          ) : (
            <ul>
              {available.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">{c.service_name}</p>
                    <p className="truncate text-xs text-text-secondary">{[c.category, formatItemPrice(c)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <button type="button" onClick={() => add(c)} disabled={atLimit} aria-label={`Publish ${c.service_name}`} className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-primary hover:border-accent disabled:opacity-40">
                    <Plus size={12} /> Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="mt-1 text-xs text-text-secondary">Only active services with a price above $0 can be published. Internal cost and margin are never shared.</p>
      </div>

      {/* Pricing rules */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="estimator-spread" className={labelCls}>Flat &amp; hourly prices shown as a range (±%)</label>
          <input id="estimator-spread" type="number" min={ESTIMATOR_LIMITS.spreadMin} max={ESTIMATOR_LIMITS.spreadMax} value={options.flat_spread_pct} onChange={(e) => onChange({ flat_spread_pct: Number(e.target.value) })} className={fieldCls} />
          <Hint error={errors.flat_spread_pct} hint="0 = show the exact price. 10 = show ±10%, e.g. $450 becomes $405 – $495." />
        </div>
        <div>
          <span className={labelCls}>Urgent / same-day surcharge</span>
          <label className="mb-2 flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={options.show_urgency} onChange={(e) => onChange({ show_urgency: e.target.checked })} className="h-4 w-4 rounded border-border" />
            Offer an urgent-service option
          </label>
          <input type="number" aria-label="Urgent surcharge percent" min={ESTIMATOR_LIMITS.urgencyMin} max={ESTIMATOR_LIMITS.urgencyMax} value={options.urgency_pct} disabled={!options.show_urgency} onChange={(e) => onChange({ urgency_pct: Number(e.target.value) })} className={fieldCls} />
          <Hint error={errors.urgency_pct} hint="Percent added to the price when the visitor ticks the box." />
        </div>
      </div>

      {/* Lead capture */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="estimator-contact" className={labelCls}>Contact required</label>
          <select id="estimator-contact" value={options.contact_required} onChange={(e) => onChange({ contact_required: e.target.value as EstimatorOptions['contact_required'] })} className={fieldCls}>
            <option value="either">Phone or email</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
          </select>
        </div>
        <div className="space-y-2 pt-0.5 text-sm text-text-primary">
          <label className="flex items-center gap-2"><input type="checkbox" checked={options.ask_zip} onChange={(e) => onChange({ ask_zip: e.target.checked })} className="h-4 w-4 rounded border-border" /> Ask for ZIP code</label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={options.gate_price} onChange={(e) => onChange({ gate_price: e.target.checked })} className="mt-0.5 h-4 w-4 rounded border-border" /> <span>Ask for contact details before showing the price<span className="block text-xs text-text-secondary">More leads, fewer visitors who finish. Off = price first, then the quote form.</span></span></label>
        </div>
      </div>

      <div>
        <label htmlFor="estimator-disclaimer" className={labelCls}>Disclaimer under the price</label>
        <textarea id="estimator-disclaimer" rows={2} maxLength={ESTIMATOR_LIMITS.disclaimer} value={options.disclaimer} onChange={(e) => onChange({ disclaimer: e.target.value })} placeholder={DEFAULT_DISCLAIMER} className={fieldCls} />
        <Hint error={errors.disclaimer} hint="Leave empty to use the default text shown above." />
      </div>

      <p className="text-xs text-text-secondary">Requests land in your Leads with the source “{ESTIMATOR_LEAD_SOURCE}”, together with the estimate the visitor saw. The price in the lead is recalculated on our servers from your price book — it can’t be edited from the website.</p>
    </Card>
  );
}
