import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  DEFAULT_REGIONAL, getActiveRegional, normalizeRegional, setActiveRegional, sumInReportingCurrency,
  type FxTable, type RegionalSettings, type ReportingTotal,
} from '@/lib/regional';

interface RegionalContextValue {
  regional: RegionalSettings;
  fx: FxTable | null;
  loading: boolean;
  /** Owner-only (RLS). Resolves to an error message or null on success. */
  save: (patch: Partial<RegionalSettings> & { fxMode?: 'auto' | 'manual'; fxManualRates?: Record<string, number> }) => Promise<string | null>;
  /** Mixed-currency rows → reporting currency, using locked rates when present. */
  sumForReporting: (rows: { cents: number; currency: string; lockedRate?: number | null }[]) => ReportingTotal;
}

const RegionalContext = createContext<RegionalContextValue | undefined>(undefined);

const formatKey = (r: RegionalSettings) => `${r.currency}|${r.locale}|${r.unitSystem}|${r.taxLabel}`;

export function RegionalProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const [regional, setRegional] = useState<RegionalSettings>(DEFAULT_REGIONAL);
  const [fx, setFx] = useState<FxTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const lastKey = useRef(formatKey(DEFAULT_REGIONAL));
  const fallbackCurrency = profile?.invoice_currency ?? null;
  const fallbackCountry = profile?.business_country ?? null;

  const apply = useCallback((next: RegionalSettings) => {
    // Update the module store BEFORE React re-renders so every formatter sees it.
    setActiveRegional(next);
    setRegional(next);
    const key = formatKey(next);
    if (key !== lastKey.current) { lastKey.current = key; setEpoch((e) => e + 1); }
  }, []);

  const load = useCallback(async () => {
    if (!user) { apply(DEFAULT_REGIONAL); setFx(null); setLoading(false); return; }
    try {
      const [{ data: row }, { data: table }] = await Promise.all([
        supabase.from('business_regional_settings').select('*').maybeSingle(),
        supabase.rpc('get_fx_table'),
      ]);
      apply(normalizeRegional(row as Record<string, unknown> | null, { currency: fallbackCurrency, country: fallbackCountry }));
      const t = table as FxTable | null;
      setFx(t && t.rates && Object.keys(t.rates).length > 1 ? t : null);
    } catch {
      apply(normalizeRegional(null, { currency: fallbackCurrency, country: fallbackCountry }));
    } finally {
      setLoading(false);
    }
  }, [user, apply, fallbackCurrency, fallbackCountry]);

  useEffect(() => { void load(); }, [load]);

  const save: RegionalContextValue['save'] = useCallback(async (patch) => {
    if (!user) return 'Not signed in.';
    const merged = normalizeRegional({ ...getActiveRegional(), ...patch } as unknown as Record<string, unknown>);
    const row: Record<string, unknown> = {
      country: merged.country, currency: merged.currency, reporting_currency: merged.reportingCurrency,
      locale: merged.locale, tax_regime: merged.taxRegime, tax_label: merged.taxLabel,
      tax_id_label: merged.taxIdLabel, tax_id: merged.taxId, prices_include_tax: merged.pricesIncludeTax,
      default_tax_rate: merged.defaultTaxRate, unit_system: merged.unitSystem, week_start: merged.weekStart,
    };
    if (patch.fxMode) row.fx_mode = patch.fxMode;
    if (patch.fxManualRates) row.fx_manual_rates = patch.fxManualRates;
    const { data: existing, error: readErr } = await supabase.from('business_regional_settings').select('user_id').maybeSingle();
    if (readErr) return readErr.message;
    const { error } = existing
      ? await supabase.from('business_regional_settings').update(row).eq('user_id', existing.user_id)
      : await supabase.from('business_regional_settings').insert(row);
    if (error) return error.message;
    // Keep the legacy profile columns in sync (existing VAT/invoice code still reads them).
    await supabase.from('profiles').update({ invoice_currency: merged.currency, business_country: merged.country, business_vat_number: merged.taxId }).eq('id', user.id);
    await load();
    return null;
  }, [user, load]);

  const sumForReporting = useCallback<RegionalContextValue['sumForReporting']>(
    (rows) => sumInReportingCurrency(rows, regional.reportingCurrency, fx),
    [regional.reportingCurrency, fx],
  );

  const value = useMemo(() => ({ regional, fx, loading, save, sumForReporting }), [regional, fx, loading, save, sumForReporting]);

  // Remount the tree once when currency/locale/units change so every already-rendered
  // formatter picks up the new region (no stale "$" left on screen).
  return (
    <RegionalContext.Provider value={value}>
      <Fragment key={epoch}>{children}</Fragment>
    </RegionalContext.Provider>
  );
}

export function useRegional() {
  const ctx = useContext(RegionalContext);
  if (!ctx) throw new Error('useRegional must be used within a RegionalProvider');
  return ctx;
}
