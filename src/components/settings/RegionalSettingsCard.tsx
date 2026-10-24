import { useEffect, useState } from 'react';
import { useRegional } from '@/contexts/RegionalContext';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  SUPPORTED_CURRENCIES, formatMoney, isFxStale, presetForCountry, rateBetween,
  type RegionalSettings, type TaxRegime, type UnitSystem,
} from '@/lib/regional';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';
const label = 'mb-1.5 block text-xs font-medium text-text-secondary';

export function RegionalSettingsCard() {
  const { regional, fx, save } = useRegional();
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const [draft, setDraft] = useState<RegionalSettings>(regional);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(regional), [regional]);

  const set = <K extends keyof RegionalSettings>(k: K, v: RegionalSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(regional);
  const preset = presetForCountry(draft.country);
  const rate = draft.currency !== draft.reportingCurrency ? rateBetween(draft.currency, draft.reportingCurrency, fx) : null;

  const applyPreset = () => {
    if (!preset) return;
    setDraft((d) => ({ ...d, currency: preset.currency, reportingCurrency: preset.currency, locale: preset.locale, taxRegime: preset.taxRegime, taxLabel: preset.taxLabel, taxIdLabel: preset.taxIdLabel, pricesIncludeTax: preset.pricesIncludeTax, defaultTaxRate: preset.defaultTaxRate, unitSystem: preset.unitSystem, weekStart: preset.weekStart }));
  };

  const onSave = async () => {
    setBusy(true);
    const err = await save(draft);
    setBusy(false);
    if (err) toast(err, 'error');
    else toast('Regional settings saved', 'success');
  };

  return (
    <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h2 className="text-base font-semibold text-text-primary">Regional operations</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Currency, tax and units used on quotes, invoices, payments, reports and your AI voice agent.
        {!isOwner && ' Only the account owner can change these.'}
      </p>

      <fieldset disabled={!isOwner || busy} className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="text-sm">
          <span className={label}>Country</span>
          <input className={field} maxLength={2} value={draft.country} onChange={(e) => set('country', e.target.value.toUpperCase())} placeholder="DE" />
        </label>
        <label className="text-sm">
          <span className={label}>Business currency</span>
          <select className={field} value={draft.currency} onChange={(e) => set('currency', e.target.value)}>
            {Object.entries(SUPPORTED_CURRENCIES).map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className={label}>Reporting currency</span>
          <select className={field} value={draft.reportingCurrency} onChange={(e) => set('reportingCurrency', e.target.value)}>
            {Object.entries(SUPPORTED_CURRENCIES).map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className={label}>Number &amp; date locale</span>
          <input className={field} value={draft.locale} onChange={(e) => set('locale', e.target.value)} placeholder="de-DE" />
        </label>
        <label className="text-sm">
          <span className={label}>Tax regime</span>
          <select className={field} value={draft.taxRegime} onChange={(e) => set('taxRegime', e.target.value as TaxRegime)}>
            <option value="sales_tax">Sales tax (added at checkout)</option>
            <option value="vat">VAT</option>
            <option value="gst">GST</option>
            <option value="none">No tax</option>
          </select>
        </label>
        <label className="text-sm">
          <span className={label}>Tax label on documents</span>
          <input className={field} maxLength={30} value={draft.taxLabel} onChange={(e) => set('taxLabel', e.target.value)} />
        </label>
        <label className="text-sm">
          <span className={label}>Default tax rate (%)</span>
          <input className={field} type="number" min={0} max={30} step="0.001" value={draft.defaultTaxRate} onChange={(e) => set('defaultTaxRate', Number(e.target.value))} />
        </label>
        <label className="text-sm">
          <span className={label}>{draft.taxIdLabel || 'Tax ID'}</span>
          <input className={field} maxLength={40} value={draft.taxId ?? ''} onChange={(e) => set('taxId', e.target.value.toUpperCase() || null)} />
        </label>
        <label className="text-sm">
          <span className={label}>Units</span>
          <select className={field} value={draft.unitSystem} onChange={(e) => set('unitSystem', e.target.value as UnitSystem)}>
            <option value="imperial">Imperial (mi, lb, °F)</option>
            <option value="metric">Metric (km, kg, °C)</option>
          </select>
        </label>
      </fieldset>

      <label className="mt-4 flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" disabled={!isOwner || busy} checked={draft.pricesIncludeTax} onChange={(e) => set('pricesIncludeTax', e.target.checked)} />
        Prices are quoted tax-inclusive (VAT/GST style)
      </label>

      <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
        <p>Preview: <span className="font-medium text-text-primary">{formatMoney(1234.5, draft.currency, { locale: draft.locale })}</span></p>
        {rate !== null && (
          <p className="mt-1">
            1 {draft.currency} = {rate.toFixed(4)} {draft.reportingCurrency}
            {isFxStale(fx?.asOf) && <span className="ml-2 text-danger-500">rates look out of date ({fx?.asOf ?? 'none'})</span>}
          </p>
        )}
        {draft.currency !== draft.reportingCurrency && rate === null && (
          <p className="mt-1 text-danger-500">No exchange rate yet for {draft.currency} → {draft.reportingCurrency}. Reports will exclude it until rates sync.</p>
        )}
        <p className="mt-1 text-xs">Changing currency affects NEW documents. Issued invoices keep the currency and rate locked at issue time.</p>
      </div>

      <div className="mt-4 flex gap-2">
        {preset && (
          <button type="button" disabled={!isOwner || busy} onClick={applyPreset} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-primary">
            Use {draft.country} defaults
          </button>
        )}
        <button type="button" disabled={!isOwner || busy || !dirty} onClick={onSave} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
