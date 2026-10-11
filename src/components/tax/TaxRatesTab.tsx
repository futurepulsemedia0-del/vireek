import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload, Plus, Pencil } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { US_STATES, formatRate, normalizeState, parseTaxRatesCsv, type TaxLevel, type TaxSettings } from '@/lib/salesTax';
import {
  deleteTaxRate, fetchTaxRates, fetchTaxSettings, importTaxRates, saveTaxRate, saveTaxSettings,
  type TaxRateInput, type TaxRateRow,
} from '@/lib/salesTaxApi';

const inputClass = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const STATES = Object.entries(US_STATES).sort(([a], [b]) => a.localeCompare(b));
const LEVELS: TaxLevel[] = ['state', 'county', 'city', 'district'];
const EMPTY: TaxRateInput = { state: '', jurisdiction_level: 'city', jurisdiction_name: '', rate_percent: 0 };

export function TaxRatesTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<TaxSettings>({ collectInStates: [], rateStaleAfterDays: 180 });
  const [rates, setRates] = useState<TaxRateRow[]>([]);
  const [stateFilter, setStateFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<TaxRateInput | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([fetchTaxSettings(), fetchTaxRates(stateFilter || undefined)]);
      setSettings(s);
      setRates(r);
    } catch {
      toast('Could not load tax rates.', 'error');
    } finally {
      setLoading(false);
    }
  }, [stateFilter, toast]);

  useEffect(() => { void load(); }, [load]);

  const persistSettings = async (next: TaxSettings) => {
    setSettings(next);
    try { await saveTaxSettings(next); } catch { toast('Could not save settings.', 'error'); }
  };

  const toggleState = (code: string) =>
    persistSettings({
      ...settings,
      collectInStates: settings.collectInStates.includes(code)
        ? settings.collectInStates.filter((s) => s !== code)
        : [...settings.collectInStates, code],
    });

  const submit = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await saveTaxRate(form);
      toast('Rate saved.', 'success');
      setForm(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the rate.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try { await deleteTaxRate(id); await load(); } catch { toast('Could not delete the rate.', 'error'); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const { rows, errors } = parseTaxRatesCsv(await file.text());
    if (errors.length > 0) {
      toast(`${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`, 'error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const n = await importTaxRates(rows);
      toast(`Imported ${n} rate${n === 1 ? '' : 's'}.`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed.', 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-bg-secondary p-5">
        <p className="text-sm font-semibold text-text-primary">States where you collect sales tax</p>
        <p className="mt-1 text-xs text-text-secondary">
          Only collect where you are registered. Leave all unselected to calculate everywhere a rate exists. Documents for any other state get no tax and a warning.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {STATES.map(([code, name]) => (
            <button key={code} type="button" title={name} aria-pressed={settings.collectInStates.includes(code)} onClick={() => toggleState(code)}
              className={`focus-ring rounded-md px-2 py-1 text-xs font-medium ${settings.collectInStates.includes(code) ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:text-text-primary'}`}>
              {code}
            </button>
          ))}
        </div>
        <label className="mt-4 block max-w-xs text-xs text-text-secondary">
          Warn when a rate was last verified more than (days) ago
          <input type="number" min={30} max={730} value={settings.rateStaleAfterDays} className={`${inputClass} mt-1`}
            onChange={(e) => setSettings({ ...settings, rateStaleAfterDays: Math.min(Math.max(Number(e.target.value) || 180, 30), 730) })}
            onBlur={() => persistSettings(settings)} />
        </label>
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-text-primary">Rates</p>
          <div className="flex items-center gap-2">
            <select aria-label="Filter by state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className={`${inputClass} w-auto`}>
              <option value="">All states</option>
              {STATES.map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}
            </select>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary">
              <Upload size={12} /> Import CSV
            </button>
            <button type="button" onClick={() => setForm({ ...EMPTY, state: stateFilter })} className="focus-ring inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white">
              <Plus size={12} /> Add rate
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-text-secondary">
          State rates marked “reference” are starting values — verify them. Add county, city and district rates (or import them) for accurate totals. CSV columns: state, jurisdiction_level, jurisdiction_name, rate_percent, county, city, postal_code, effective_from.
        </p>

        {form && (
          <div className="mt-4 grid gap-2 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-6">
            <select aria-label="State" className={`${inputClass} sm:col-span-1`} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
              <option value="">State</option>{STATES.map(([c]) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select aria-label="Level" className={`${inputClass} sm:col-span-1`} value={form.jurisdiction_level} onChange={(e) => setForm({ ...form, jurisdiction_level: e.target.value as TaxLevel })}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <input aria-label="Jurisdiction name" placeholder="Name (e.g. Austin)" className={`${inputClass} sm:col-span-2`} value={form.jurisdiction_name} onChange={(e) => setForm({ ...form, jurisdiction_name: e.target.value })} />
            <input aria-label="Rate percent" type="number" min={0} max={25} step="0.0001" placeholder="Rate %" className={`${inputClass} sm:col-span-1`} value={form.rate_percent} onChange={(e) => setForm({ ...form, rate_percent: Number(e.target.value) })} />
            <input aria-label="Effective from" type="date" className={`${inputClass} sm:col-span-1`} value={form.effective_from ?? ''} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
            <input aria-label="County" placeholder="County (optional)" className={`${inputClass} sm:col-span-2`} value={form.county ?? ''} onChange={(e) => setForm({ ...form, county: e.target.value })} />
            <input aria-label="City" placeholder="City (optional)" className={`${inputClass} sm:col-span-2`} value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            <input aria-label="ZIP" placeholder="ZIP (optional)" maxLength={5} className={`${inputClass} sm:col-span-1`} value={form.postal_code ?? ''} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} />
            <div className="flex gap-2 sm:col-span-1">
              <button type="button" disabled={saving || !normalizeState(form.state)} onClick={submit} className="focus-ring flex-1 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Save</button>
              <button type="button" onClick={() => setForm(null)} className="focus-ring rounded-lg px-2 text-xs text-text-secondary">Cancel</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex h-24 items-center justify-center"><Loader2 className="animate-spin" /></div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-secondary">
                <tr><th className="py-1.5">State</th><th>Level</th><th>Jurisdiction</th><th>Applies to</th><th>Rate</th><th>Source</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-border/60 text-text-primary">
                {rates.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 font-medium">{r.state}</td>
                    <td>{r.jurisdiction_level}</td>
                    <td>{r.jurisdiction_name}</td>
                    <td className="text-text-secondary">{[r.city, r.county && `${r.county} Co.`, r.postal_code].filter(Boolean).join(' · ') || 'Whole state'}</td>
                    <td>{formatRate(r.rate_percent)}</td>
                    <td className="text-text-secondary">{r.user_id ? r.source : 'reference'}</td>
                    <td className="text-right">
                      {r.user_id && (
                        <>
                          <button type="button" aria-label="Edit rate" onClick={() => setForm({ id: r.id, state: r.state, jurisdiction_level: r.jurisdiction_level, jurisdiction_name: r.jurisdiction_name, rate_percent: r.rate_percent, county: r.county ?? '', city: r.city ?? '', postal_code: r.postal_code ?? '', effective_from: r.effective_from })} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary"><Pencil size={12} /></button>
                          <button type="button" aria-label="Delete rate" onClick={() => void remove(r.id)} className="focus-ring rounded p-1 text-text-secondary hover:text-danger"><Trash2 size={12} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {rates.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-text-secondary">No rates for this filter.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
