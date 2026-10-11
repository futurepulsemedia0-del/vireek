import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, MapPin, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useTaxClasses } from '@/hooks/useTaxClasses';
import {
  calculateSalesTax,
  exemptionLabel,
  formatRate,
  normalizeState,
  normalizeZip,
  parseUsAddress,
  US_STATES,
  type ServiceAddress,
  type TaxMode,
  type TaxRateComponent,
  type TaxSelection,
  type TaxSettings,
  type TaxableLine,
} from '@/lib/salesTax';
import {
  fetchCustomerOption,
  fetchExemptionsForCustomer,
  fetchTaxSettings,
  lookupTaxRates,
  searchCustomers,
  type CustomerOption,
  type ExemptionRecord,
} from '@/lib/salesTaxApi';
import { TaxBreakdownLines } from '@/components/tax/TaxBreakdownLines';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const STATE_OPTIONS = Object.entries(US_STATES).sort(([a], [b]) => a.localeCompare(b));

interface Props {
  lines: TaxableLine[];
  value: TaxSelection;
  onChange: (next: TaxSelection) => void;
}

function CustomerPicker({ selected, onPick }: { selected: CustomerOption | null; onPick: (c: CustomerOption | null) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchCustomers(query)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
        <span className="truncate text-text-primary">{selected.name}</span>
        <button type="button" aria-label="Clear customer" onClick={() => onPick(null)} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary">
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Link a customer (for tax exemptions)"
        className={`${inputClass} pl-8`}
        aria-label="Search customers"
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-border bg-bg-secondary shadow-lg">
          {loading && <p className="px-3 py-2 text-xs text-text-secondary">Searching…</p>}
          {!loading && results.length === 0 && <p className="px-3 py-2 text-xs text-text-secondary">No matching customers.</p>}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(c);
                setQuery('');
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-bg-tertiary"
            >
              <span className="text-text-primary">{c.name}</span>
              <span className="ml-2 text-xs text-text-secondary">{c.email ?? c.phone ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SalesTaxPanel({ lines, value, onChange }: Props) {
  const { classes, loading: classesLoading } = useTaxClasses();
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [rates, setRates] = useState<TaxRateComponent[]>([]);
  const [ratesKey, setRatesKey] = useState('');
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [exemptions, setExemptions] = useState<ExemptionRecord[]>([]);
  const [exemptionsFor, setExemptionsFor] = useState<string | null | undefined>(undefined);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);

  const addr = value.address;
  const addrRef = useRef(addr);
  addrRef.current = addr;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const state = normalizeState(addr.state);
  const zip = normalizeZip(addr.postal_code);
  const wantKey = state && zip ? [state, zip, (addr.city ?? '').trim().toLowerCase(), (addr.county ?? '').trim().toLowerCase()].join('|') : '';

  // Account settings (which states we collect in).
  useEffect(() => {
    let cancelled = false;
    fetchTaxSettings()
      .then((s) => !cancelled && setSettings(s))
      .catch(() => {
        if (cancelled) return;
        setSettings({ collectInStates: [], rateStaleAfterDays: 180 });
        setLoadWarning('Could not load your tax settings — registration checks were skipped.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rate lookup by service address (debounced; stale responses are dropped).
  useEffect(() => {
    if (value.mode !== 'auto' || !wantKey) {
      setRates([]);
      setRatesKey(wantKey);
      setRatesError(null);
      return;
    }
    let cancelled = false;
    setRatesError(null);
    const t = setTimeout(() => {
      lookupTaxRates(addrRef.current)
        .then((r) => {
          if (cancelled) return;
          setRates(r);
          setRatesKey(wantKey);
        })
        .catch(() => !cancelled && setRatesError('Could not look up tax rates.'));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value.mode, wantKey, retry]);

  // Customer's exemption certificates.
  useEffect(() => {
    const id = value.customerId;
    if (value.mode !== 'auto' || !id) {
      setExemptions([]);
      setExemptionsFor(id);
      return;
    }
    let cancelled = false;
    fetchExemptionsForCustomer(id)
      .then((e) => {
        if (cancelled) return;
        setExemptions(e);
        setExemptionsFor(id);
      })
      .catch(() => {
        if (cancelled) return;
        setExemptions([]);
        setExemptionsFor(id);
        setLoadWarning("Could not load this customer's exemption certificates — tax is being charged.");
      });
    return () => {
      cancelled = true;
    };
  }, [value.mode, value.customerId]);

  // Label for an already-linked customer (editing an existing document).
  useEffect(() => {
    const id = value.customerId;
    if (!id) {
      setCustomer(null);
      return;
    }
    if (customer?.id === id) return;
    let cancelled = false;
    fetchCustomerOption(id)
      .then((c) => !cancelled && setCustomer(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.customerId]);

  const auto = value.mode === 'auto';
  const pending =
    auto &&
    (settings === null ||
      classesLoading ||
      (Boolean(wantKey) && (ratesKey !== wantKey || ratesError !== null)) ||
      (Boolean(value.customerId) && exemptionsFor !== value.customerId));

  const calculation = useMemo(
    () =>
      auto
        ? calculateSalesTax({
            lines,
            address: addr,
            rates: ratesKey === wantKey ? rates : [],
            classes,
            exemptions,
            settings: settings ?? undefined,
          })
        : null,
    [auto, lines, addr, rates, ratesKey, wantKey, classes, exemptions, settings]
  );

  // Publish the result to the parent form (guarded so it can never loop).
  useEffect(() => {
    const v = valueRef.current;
    if (v.calculation === calculation && v.pending === pending) return;
    onChangeRef.current({ ...v, calculation, pending });
  }, [calculation, pending]);

  const patchAddress = (patch: Partial<ServiceAddress>) => onChange({ ...value, address: { ...value.address, ...patch } });
  const setMode = (mode: TaxMode) => onChange({ ...value, mode });

  const pickCustomer = (c: CustomerOption | null) => {
    setCustomer(c);
    const addressEmpty = !value.address.state && !value.address.postal_code && !value.address.city && !value.address.line1;
    const parsed = c && addressEmpty ? parseUsAddress(c.address) : null;
    onChange({ ...value, customerId: c?.id ?? null, address: parsed ? { ...value.address, ...parsed } : value.address });
  };

  const changedFromSaved =
    calculation && value.savedTaxCents != null && calculation.status === 'calculated' && calculation.taxCents !== value.savedTaxCents;

  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-secondary/60 p-4" data-testid="sales-tax-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Sales tax</p>
        <div className="inline-flex rounded-lg border border-border p-0.5 text-xs" role="group" aria-label="Tax mode">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={value.mode === m}
              onClick={() => setMode(m)}
              className={`focus-ring rounded-md px-2.5 py-1 font-medium ${value.mode === m ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {m === 'auto' ? 'Automatic' : 'Manual rate'}
            </button>
          ))}
        </div>
      </div>

      {auto && <CustomerPicker selected={customer} onPick={pickCustomer} />}

      <div className="mt-3 flex items-center gap-1.5 text-xs text-text-secondary">
        <MapPin size={12} /> Service address {auto ? '(tax is based on where the work is done)' : '(optional — used for tax reports)'}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-6">
        <input className={`${inputClass} sm:col-span-6`} placeholder="Street address (optional)" value={addr.line1 ?? ''} onChange={(e) => patchAddress({ line1: e.target.value })} aria-label="Street address" />
        <input className={`${inputClass} sm:col-span-2`} placeholder="City" value={addr.city ?? ''} onChange={(e) => patchAddress({ city: e.target.value })} aria-label="City" />
        <select className={`${inputClass} sm:col-span-2`} value={normalizeState(addr.state)} onChange={(e) => patchAddress({ state: e.target.value })} aria-label="State">
          <option value="">State</option>
          {STATE_OPTIONS.map(([code, name]) => (
            <option key={code} value={code}>
              {code} — {name}
            </option>
          ))}
        </select>
        <input className={`${inputClass} sm:col-span-1`} placeholder="ZIP" inputMode="numeric" maxLength={10} value={addr.postal_code ?? ''} onChange={(e) => patchAddress({ postal_code: e.target.value })} aria-label="ZIP code" />
        <input className={`${inputClass} sm:col-span-1`} placeholder="County" value={addr.county ?? ''} onChange={(e) => patchAddress({ county: e.target.value })} aria-label="County (optional)" />
      </div>

      {!auto && (
        <div className="mt-3 max-w-[10rem]">
          <label className="mb-1 block text-xs text-text-secondary">Tax %</label>
          <input
            type="number"
            min={0}
            max={25}
            step="0.01"
            value={value.manualPercent}
            onChange={(e) => onChange({ ...value, manualPercent: Math.min(Math.max(Number(e.target.value) || 0, 0), 25) })}
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-text-secondary">Flat rate on the whole document — ignores tax classes and exemptions.</p>
        </div>
      )}

      {auto && exemptions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {exemptions.map((e) => (
            <span key={e.id} className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
              <ShieldCheck size={11} /> {exemptionLabel(e)} · {e.status}
              {e.expiresOn ? ` · exp ${e.expiresOn}` : ''}
            </span>
          ))}
        </div>
      )}
      {auto && customer && exemptions.length === 0 && exemptionsFor === customer.id && (
        <p className="mt-2 text-[11px] text-text-secondary">
          No exemption certificates on file.{' '}
          <Link to={`/dashboard/tax?tab=exemptions&customer=${customer.id}`} className="text-accent hover:underline">
            Add one
          </Link>
        </p>
      )}

      {auto && (
        <div className="mt-3 space-y-2" aria-live="polite">
          {ratesError && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <span>{ratesError} Saving is paused until this works — retry or switch to a manual rate.</span>
              <button type="button" onClick={() => setRetry((n) => n + 1)} className="focus-ring inline-flex items-center gap-1 font-semibold">
                <RefreshCw size={12} /> Retry
              </button>
            </div>
          )}

          {pending && !ratesError && (
            <p className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin" /> Calculating tax…
            </p>
          )}

          {!pending && calculation && calculation.status === 'calculated' && (
            <div className="rounded-lg border border-border bg-bg-primary p-3">
              <TaxBreakdownLines breakdown={calculation.breakdown} taxCents={calculation.taxCents} taxPercent={calculation.effectivePercent} taxExempt={calculation.exemptCents > 0 && calculation.taxCents === 0} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-text-secondary">
                <span>
                  Combined rate {formatRate(calculation.combinedRatePercent)} · taxable {money(calculation.taxableCents)}
                  {calculation.nonTaxableCents > 0 && ` · non-taxable ${money(calculation.nonTaxableCents)}`}
                  {calculation.exemptCents > 0 && ` · exempt ${money(calculation.exemptCents)}`}
                </span>
                <span className="font-semibold text-text-primary">Tax {money(calculation.taxCents)}</span>
              </div>
            </div>
          )}

          {changedFromSaved && calculation && (
            <p className="text-[11px] text-warning-500">
              Tax was {money(value.savedTaxCents ?? 0)} when this was saved; with current rates and certificates it is {money(calculation.taxCents)}.
            </p>
          )}

          {!pending && calculation && calculation.status !== 'calculated' && calculation.warnings.length > 0 && (
            <p className="text-xs text-text-secondary">{calculation.warnings[0]}</p>
          )}

          {!pending && calculation && calculation.status === 'calculated' && [...calculation.warnings, ...(loadWarning ? [loadWarning] : [])].map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-[11px] text-warning-500">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
