/**
 * External World tab — rendered inside /dashboard/world-model.
 *
 * Joins live external data (NOAA weather, NASA climate, FEMA hazards, EIA
 * energy price) and owner-entered facts onto the World Model's property and
 * asset nodes, then shows the Decision Intelligence that follows from the
 * combination. Data + rules live in src/lib/externalWorld.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudSun, Globe, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { WorldModel } from '@/lib/worldModel';
import {
  addExternalFact,
  AssetInPlace,
  buildPropertyContexts,
  deleteExternalFact,
  ExternalState,
  FACT_DOMAIN_LABELS,
  FACT_SCOPE_LABELS,
  FactDomain,
  FactImpact,
  FactScope,
  fetchAssetsInPlace,
  fetchExternalState,
  generateInsights,
  HAZARD_LABELS,
  InsightSeverity,
  PropertyContext,
  syncExternalWorld,
} from '@/lib/externalWorld';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

const SEVERITY_STYLES: Record<InsightSeverity, { label: string; cls: string }> = {
  act: { label: 'Act', cls: 'bg-danger/10 text-danger' },
  watch: { label: 'Watch', cls: 'bg-warning-500/10 text-warning-500' },
  info: { label: 'Info', cls: 'bg-bg-secondary text-text-secondary' },
};

const IMPACT_STYLES: Record<FactImpact, string> = {
  positive: 'bg-success-500/10 text-success-500',
  negative: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-secondary text-text-secondary',
};

const fDays = (c: number | null | undefined) => (c == null ? '—' : Math.round(c * 1.8).toLocaleString());

function PropertyCard({ ctx }: { ctx: PropertyContext }) {
  const loc = ctx.location;
  const topHazards = Object.entries(ctx.hazards?.hazards ?? {})
    .filter(([, r]) => r === 'Relatively High' || r === 'Very High')
    .map(([code, r]) => `${HAZARD_LABELS[code] ?? code} (${r.replace('Relatively ', '')})`);
  return (
    <div className="rounded-2xl border border-border p-4 text-sm">
      <p className="truncate font-medium text-text-primary">{ctx.label}</p>
      <p className="mb-3 text-xs text-text-secondary">
        {[loc?.county_name, loc?.state].filter(Boolean).join(', ') || 'Location unresolved'}
      </p>
      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Climate load</dt>
          <dd className="text-right text-text-primary">
            {ctx.climate ? `${fDays(ctx.climate.cdd_c)} cooling / ${fDays(ctx.climate.hdd_c)} heating °F-days` : '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">7-day range</dt>
          <dd className="text-text-primary">{ctx.forecast ? `${ctx.forecast.min_f}°F – ${ctx.forecast.max_f}°F` : '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Active alerts</dt>
          <dd className={ctx.alerts.length > 0 ? 'text-danger' : 'text-text-primary'}>
            {ctx.alerts.length > 0 ? ctx.alerts.map((a) => a.event).slice(0, 2).join(', ') : 'None'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Hazard risk</dt>
          <dd className="text-right text-text-primary">
            {ctx.hazards?.risk_rating ?? '—'}
            {topHazards.length > 0 && <span className="block text-text-secondary">{topHazards.slice(0, 3).join(' · ')}</span>}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Electricity</dt>
          <dd className="text-text-primary">{ctx.energy ? `${ctx.energy.cents_per_kwh.toFixed(1)} ¢/kWh` : '—'}</dd>
        </div>
      </dl>
      {ctx.facts.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-border pt-2">
          {ctx.facts.slice(0, 2).map((f) => (
            <p key={f.id} className="truncate text-xs text-text-secondary">
              <span className="text-text-primary">{FACT_DOMAIN_LABELS[f.domain]}:</span> {f.title}
            </p>
          ))}
          {ctx.facts.length > 2 && <p className="text-[11px] text-text-secondary">+{ctx.facts.length - 2} more facts apply</p>}
        </div>
      )}
    </div>
  );
}

export function ExternalWorldTab({ model }: { model: WorldModel }) {
  const { toast } = useToast();
  const [state, setState] = useState<ExternalState | null>(null);
  const [assets, setAssets] = useState<AssetInPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [eiaConfigured, setEiaConfigured] = useState<boolean | null>(null);
  const [showAllProps, setShowAllProps] = useState(false);

  const [domain, setDomain] = useState<FactDomain>('regulations');
  const [scope, setScope] = useState<FactScope>('state');
  const [region, setRegion] = useState('');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [impact, setImpact] = useState<FactImpact>('neutral');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [savingFact, setSavingFact] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([fetchExternalState(), fetchAssetsInPlace(model)]);
      setState(s);
      setAssets(a);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load external world data', 'error');
    } finally {
      setLoading(false);
    }
  }, [model, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const contexts = useMemo(() => (state ? buildPropertyContexts(model, state) : []), [model, state]);
  const insights = useMemo(() => generateInsights(contexts, assets), [contexts, assets]);
  const synced = useMemo(() => contexts.filter((c) => c.location), [contexts]);
  const propertyCount = contexts.length;

  const coverage = useMemo(
    () => [
      { label: 'Weather', n: synced.filter((c) => c.forecast || c.alerts.length > 0).length },
      { label: 'Climate', n: synced.filter((c) => c.climate).length },
      { label: 'Hazards', n: synced.filter((c) => c.hazards).length },
      { label: 'Energy', n: synced.filter((c) => c.energy).length },
    ],
    [synced]
  );

  const handleSync = async (force: boolean) => {
    setSyncing(true);
    try {
      const known = new Set((state?.locations ?? []).map((l) => l.property_key));
      const r = await syncExternalWorld(model, force, force ? new Set() : known);
      setEiaConfigured(r.eiaConfigured);
      await load();
      const parts = [`${r.properties} properties checked`, `${r.signalsWritten} signals updated`];
      if (r.notFound > 0) parts.push(`${r.notFound} addresses could not be located`);
      if (r.remaining > 0) parts.push(`${r.remaining} more — sync again`);
      toast(parts.join(' · '), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleAddFact = async () => {
    setSavingFact(true);
    try {
      await addExternalFact({
        domain, scope, region: scope === 'national' ? null : region, title,
        detail, impact, effectiveDate: effectiveDate || null, sourceUrl,
      });
      setTitle(''); setDetail(''); setSourceUrl(''); setEffectiveDate('');
      await load();
      toast('External fact saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    } finally {
      setSavingFact(false);
    }
  };

  const handleDeleteFact = async (id: string) => {
    try {
      await deleteExternalFact(id);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete', 'error');
    }
  };

  if (loading || !state) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  const visibleProps = (showAllProps ? synced : synced.slice(0, 12));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/40 p-4">
        <div className="max-w-2xl">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <Globe className="h-4 w-4 text-accent" /> Internal data + the world around it
          </h3>
          <p className="mt-1 text-xs text-text-secondary">
            Live NOAA weather, NASA climate, FEMA hazard and EIA energy data joined to each property and piece of
            equipment — so a failing HVAC is read in the context of its climate, cost of power and exposure, not alone.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {coverage.map((c) => (
              <span key={c.label} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${c.n > 0 ? 'bg-accent/10 text-accent' : 'bg-bg-secondary text-text-secondary'}`}>
                {c.label} {c.n}/{propertyCount}
              </span>
            ))}
            <span className="rounded-full bg-bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-text-secondary">
              Owner facts {state.facts.length}
            </span>
          </div>
          {eiaConfigured === false && (
            <p className="mt-2 text-[11px] text-text-secondary">
              Energy prices are off: add a free EIA key as the EIA_API_KEY secret on the sync function to enable them.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleSync(false)}
            disabled={syncing || propertyCount === 0}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sync external data
          </button>
          <button
            onClick={() => handleSync(true)}
            disabled={syncing || propertyCount === 0}
            title="Ignore freshness and re-fetch everything"
            className="focus-ring rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-secondary disabled:opacity-60"
          >
            Force refresh
          </button>
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          <Sparkles className="h-3.5 w-3.5" /> Decision intelligence ({insights.length})
        </h3>
        {insights.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-4 text-xs text-text-secondary">
            {synced.length === 0
              ? 'Run a sync to bring in external data. Insights appear when equipment, location and the outside world line up.'
              : 'No equipment currently crosses a rule threshold. Equipment needs an install date on record for age-based rules.'}
          </p>
        )}
        {insights.slice(0, 30).map((i) => (
          <div key={i.id} className="space-y-2 rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLES[i.severity].cls}`}>
                {SEVERITY_STYLES[i.severity].label}
              </span>
              <p className="text-sm font-medium text-text-primary">{i.title}</p>
              <span className="ml-auto text-xs text-text-secondary">{i.propertyLabel}</span>
            </div>
            <p className="text-xs text-text-secondary">{i.rationale}</p>
            <div className="flex flex-wrap gap-1.5">
              {i.drivers.map((d, idx) => (
                <span
                  key={idx}
                  className={`rounded-lg px-2 py-0.5 text-[11px] ${d.kind === 'external' ? 'bg-accent/10 text-accent' : 'bg-bg-secondary text-text-secondary'}`}
                >
                  {d.kind === 'external' ? 'World' : 'Business'} · {d.label}: {d.value}
                </span>
              ))}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-text-primary">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-500" /> {i.action}
            </p>
            <p className="text-[11px] text-text-secondary">Sources: {i.sources.join(', ')}</p>
          </div>
        ))}
      </section>

      {synced.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            <CloudSun className="h-3.5 w-3.5" /> Property context ({synced.length})
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleProps.map((c) => (
              <PropertyCard key={c.propertyKey} ctx={c} />
            ))}
          </div>
          {synced.length > 12 && (
            <button onClick={() => setShowAllProps((v) => !v)} className="focus-ring text-xs text-accent hover:underline">
              {showAllProps ? 'Show fewer' : `Show all ${synced.length}`}
            </button>
          )}
        </section>
      )}

      <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary/40 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Owner-entered facts — regulations, incentives, labor, competitors, suppliers, construction
        </h3>
        <p className="text-xs text-text-secondary">
          These domains have no reliable free data feed, so you record them with a source. They appear on every
          matching property and are never invented by the system.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <select className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value as FactDomain)}>
            {(Object.keys(FACT_DOMAIN_LABELS) as FactDomain[]).map((d) => (
              <option key={d} value={d}>{FACT_DOMAIN_LABELS[d]}</option>
            ))}
          </select>
          <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as FactScope)}>
            {(Object.keys(FACT_SCOPE_LABELS) as FactScope[]).map((s) => (
              <option key={s} value={s}>{FACT_SCOPE_LABELS[s]}</option>
            ))}
          </select>
          <input
            className={inputClass}
            placeholder={scope === 'national' ? 'No region needed' : scope === 'state' ? 'TX' : scope === 'county' ? '48201' : 'Text in the address'}
            value={region}
            disabled={scope === 'national'}
            onChange={(e) => setRegion(e.target.value)}
          />
          <select className={inputClass} value={impact} onChange={(e) => setImpact(e.target.value as FactImpact)}>
            <option value="neutral">Neutral impact</option>
            <option value="positive">Positive for us</option>
            <option value="negative">Negative for us</option>
          </select>
        </div>
        <input className={inputClass} placeholder="Title, e.g. Heat pump rebate up to $2,000 (utility program)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <input className={`${inputClass} md:col-span-2`} placeholder="Details (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} />
          <input className={inputClass} type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </div>
        <input className={inputClass} placeholder="Source URL (optional)" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        <button
          onClick={handleAddFact}
          disabled={savingFact}
          className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {savingFact ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add fact
        </button>

        <div className="space-y-2 pt-2">
          {state.facts.length === 0 && <p className="text-xs text-text-secondary">No facts recorded yet.</p>}
          {state.facts.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-primary p-3 text-sm">
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">{FACT_DOMAIN_LABELS[f.domain]}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${IMPACT_STYLES[f.impact]}`}>{f.impact}</span>
              <span className="text-text-primary">{f.title}</span>
              <span className="text-xs text-text-secondary">
                · {f.scope === 'national' ? 'National' : `${f.scope} ${f.region}`}
                {f.effective_date ? ` · from ${f.effective_date}` : ''}
              </span>
              {f.source_url && /^https?:\/\//i.test(f.source_url) && (
                <a href={f.source_url} target="_blank" rel="noopener noreferrer" className="focus-ring text-xs text-accent hover:underline">source</a>
              )}
              <button onClick={() => handleDeleteFact(f.id)} aria-label="Delete fact" className="focus-ring ml-auto rounded-lg p-1.5 text-text-secondary hover:text-danger">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
