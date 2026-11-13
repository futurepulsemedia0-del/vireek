// Recreated: verify against original intent
// /dashboard/oem-intelligence
//
// Built on supabase/migrations/20261215000000_oem_intelligence_network.sql:
//  - equipment_oem_alerts (per account, RLS): recall / bulletin / failure-pattern alerts for the units you service
//  - equipment_oem_link (per account, RLS): how many of your units are matched to a manufacturer model
//  - oem_* reference tables (shared, read-only for signed-in users): manufacturers, models, parts, recalls, bulletins,
//    failure patterns
// Read-only except dismissing an alert. Enrichment itself runs server-side (service role) and is not triggered here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Factory } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

type Severity = 'low' | 'medium' | 'high' | 'critical';
interface Alert { id: string; equipment_id: string; alert_type: 'recall' | 'bulletin' | 'failure_pattern'; title: string; message: string; severity: Severity; created_at: string }
interface Manufacturer { id: string; slug: string; name: string }
interface Model { id: string; manufacturer_id: string; model_number: string; equipment_type: string; category: string | null; avg_lifespan_years: number | null; manual_url: string | null; source: 'oem_api' | 'internal' }
interface Part { id: string; part_number: string; part_name: string; category: string | null; avg_price: number | null }
interface Recall { id: string; recall_number: string; title: string; description: string | null; severity: Severity; issued_date: string | null; remedy: string | null; source_url: string | null }
interface Bulletin { id: string; bulletin_number: string; title: string; description: string | null; issued_date: string | null; source_url: string | null }
interface Pattern { id: string; failure_mode: string; typical_age_months: number | null; sample_size: number; frequency_score: number; common_fix: string | null }
interface Detail { parts: Part[]; recalls: Recall[]; bulletins: Bulletin[]; patterns: Pattern[] }
interface LinkStats { total: number; matched: number; unmatched: number; pending: number }

const SEVERITY: Record<Severity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger text-white',
};
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const TYPE_LABEL = { recall: 'Recall', bulletin: 'Service bulletin', failure_pattern: 'Failure pattern' } as const;

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';

/** Links come from shared reference data: only plain http(s) URLs are ever made clickable. */
function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function useGuardedLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const r = await fn();
      if (mine === seq.current) setData(r);
    } catch {
      if (mine === seq.current) setError(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setData(null);
    void reload();
    return () => { seq.current++; };
  }, [reload]);
  return { data, error, reload };
}

const Retry = ({ onClick }: { onClick: () => void }) => (
  <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">Could not load this. <button type="button" onClick={onClick} className="focus-ring font-semibold underline">Try again</button></p>
);

export function OEMIntelligencePage() {
  const [tab, setTab] = useState<'alerts' | 'catalog'>('alerts');
  return (
    <DashboardLayout activeLabel="OEM Intelligence">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Factory size={22} aria-hidden="true" /> OEM Intelligence</h1>
        <p className="mt-1 text-sm text-text-secondary">Manufacturer recalls, service bulletins and known failure patterns for the equipment you service.</p>
      </div>
      <div role="tablist" aria-label="OEM Intelligence sections" className="mb-4 flex gap-1 border-b border-border">
        {([['alerts', 'Alerts'], ['catalog', 'Model catalog']] as const).map(([id, label]) => (
          <button key={id} role="tab" type="button" id={`oem-tab-${id}`} aria-selected={tab === id} aria-controls={`oem-panel-${id}`} onClick={() => setTab(id)} className={`focus-ring min-h-[44px] rounded-t-lg px-4 text-sm font-semibold ${tab === id ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`oem-panel-${tab}`} aria-labelledby={`oem-tab-${tab}`}>{tab === 'alerts' ? <AlertsTab /> : <CatalogTab />}</div>
    </DashboardLayout>
  );
}

function AlertsTab() {
  const { toast } = useToast();
  const alerts = useGuardedLoad<Alert[]>(async () => {
    const { data, error } = await supabase.from('equipment_oem_alerts').select('id,equipment_id,alert_type,title,message,severity,created_at').eq('is_dismissed', false).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return ((data ?? []) as Alert[]).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  }, []);
  const links = useGuardedLoad<LinkStats>(async () => {
    const { data, error } = await supabase.from('equipment_oem_link').select('enrichment_status').limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as { enrichment_status: string }[];
    return {
      total: rows.length,
      matched: rows.filter((r) => r.enrichment_status === 'matched').length,
      unmatched: rows.filter((r) => r.enrichment_status === 'unmatched').length,
      pending: rows.filter((r) => r.enrichment_status === 'pending').length,
    };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);

  const dismiss = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const { error } = await supabase.from('equipment_oem_alerts').update({ is_dismissed: true }).eq('id', id);
      if (error) throw error;
      await alerts.reload();
    } catch {
      toast('Could not dismiss the alert. Try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {links.data && (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[['Units tracked', links.data.total], ['Matched to a model', links.data.matched], ['No match found', links.data.unmatched], ['Waiting to be checked', links.data.pending]].map(([k, v]) => (
            <div key={String(k)} className={card}><dt className="text-xs font-semibold text-text-secondary">{k}</dt><dd className="mt-1 text-xl font-bold text-text-primary">{v}</dd></div>
          ))}
        </dl>
      )}
      <section className={card} aria-labelledby="oem-alerts">
        <h2 id="oem-alerts" className="text-base font-semibold text-text-primary">Open alerts</h2>
        <div className="mt-3">
          {alerts.error && <Retry onClick={() => void alerts.reload()} />}
          {!alerts.data && !alerts.error && <p role="status" className="text-sm text-text-secondary">Loading…</p>}
          {alerts.data && alerts.data.length === 0 && <p className="text-sm text-text-secondary">No open alerts. New recalls and bulletins for your matched equipment will appear here.</p>}
          {alerts.data && alerts.data.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {alerts.data.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
                  <div className="min-w-0 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-text-primary">
                      <span className="break-words">{a.title}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY[a.severity]}`}>{a.severity}</span>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{TYPE_LABEL[a.alert_type]}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">{a.message}</p>
                    <p className="mt-1 text-xs text-text-secondary">{day(a.created_at)}</p>
                  </div>
                  <button type="button" disabled={busy !== null} onClick={() => void dismiss(a.id)} className="focus-ring min-h-[40px] rounded-lg border border-border px-3 text-sm font-semibold text-text-primary disabled:opacity-50">{busy === a.id ? 'Dismissing…' : 'Dismiss'}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function CatalogTab() {
  const makers = useGuardedLoad<Manufacturer[]>(async () => {
    const { data, error } = await supabase.from('oem_manufacturers').select('id,slug,name').order('name');
    if (error) throw error;
    return (data ?? []) as Manufacturer[];
  }, []);
  const [makerId, setMakerId] = useState('');
  const [query, setQuery] = useState('');
  const [modelId, setModelId] = useState<string | null>(null);

  const models = useGuardedLoad<Model[]>(async () => {
    if (!makerId) return [];
    const { data, error } = await supabase.from('oem_equipment_models').select('id,manufacturer_id,model_number,equipment_type,category,avg_lifespan_years,manual_url,source').eq('manufacturer_id', makerId).order('model_number').limit(500);
    if (error) throw error;
    return (data ?? []) as Model[];
  }, [makerId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models.data ?? []).filter((m) => !q || m.model_number.toLowerCase().includes(q) || m.equipment_type.toLowerCase().includes(q));
  }, [models.data, query]);
  const model = (models.data ?? []).find((m) => m.id === modelId) ?? null;

  return (
    <div className="space-y-4">
      <section className={card}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="oem-maker" className={lab}>Manufacturer</label>
            <select id="oem-maker" value={makerId} onChange={(e) => { setMakerId(e.target.value); setModelId(null); setQuery(''); }} className={field}>
              <option value="">Choose a manufacturer…</option>
              {(makers.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="oem-q" className={lab}>Search models</label>
            <input id="oem-q" value={query} disabled={!makerId} maxLength={60} onChange={(e) => setQuery(e.target.value)} className={field} />
          </div>
        </div>
        {makers.error && <div className="mt-3"><Retry onClick={() => void makers.reload()} /></div>}
      </section>

      {makerId && (
        <section className={card} aria-labelledby="oem-models">
          <h2 id="oem-models" className="text-base font-semibold text-text-primary">Models</h2>
          <div className="mt-3">
            {models.error && <Retry onClick={() => void models.reload()} />}
            {!models.data && !models.error && <p role="status" className="text-sm text-text-secondary">Loading…</p>}
            {models.data && filtered.length === 0 && <p className="text-sm text-text-secondary">{models.data.length === 0 ? 'No models are on file for this manufacturer yet. The catalog grows as equipment is matched.' : 'No models match your search.'}</p>}
            {filtered.length > 0 && (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {filtered.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => setModelId(m.id === modelId ? null : m.id)} aria-expanded={m.id === modelId} className="focus-ring flex min-h-[48px] w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-primary">
                      <span className="min-w-0 truncate text-sm font-medium text-text-primary">{m.model_number}</span>
                      <span className="shrink-0 text-xs text-text-secondary">{m.equipment_type}{m.avg_lifespan_years ? ` · ~${m.avg_lifespan_years} yrs` : ''}</span>
                    </button>
                    {m.id === modelId && <ModelDetail model={m} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {!makerId && model === null && <p className="text-sm text-text-secondary">Choose a manufacturer to browse its models, parts, recalls and known issues.</p>}
    </div>
  );
}

function ModelDetail({ model }: { model: Model }) {
  const { data, error, reload } = useGuardedLoad<Detail>(async () => {
    const [p, r, b, f] = await Promise.all([
      supabase.from('oem_parts').select('id,part_number,part_name,category,avg_price').eq('model_id', model.id).order('part_name').limit(200),
      supabase.from('oem_recalls').select('id,recall_number,title,description,severity,issued_date,remedy,source_url').eq('model_id', model.id).order('issued_date', { ascending: false }).limit(50),
      supabase.from('oem_service_bulletins').select('id,bulletin_number,title,description,issued_date,source_url').eq('model_id', model.id).order('issued_date', { ascending: false }).limit(50),
      supabase.from('oem_failure_patterns').select('id,failure_mode,typical_age_months,sample_size,frequency_score,common_fix').eq('model_id', model.id).order('frequency_score', { ascending: false }).limit(50),
    ]);
    const bad = [p, r, b, f].find((x) => x.error);
    if (bad?.error) throw bad.error;
    return { parts: (p.data ?? []) as Part[], recalls: (r.data ?? []) as Recall[], bulletins: (b.data ?? []) as Bulletin[], patterns: (f.data ?? []) as Pattern[] };
  }, [model.id]);
  const manual = safeUrl(model.manual_url);

  return (
    <div className="space-y-4 border-t border-border bg-bg-primary px-3 py-4 text-sm">
      <p className="text-xs text-text-secondary">
        {model.category ?? model.equipment_type} · {model.source === 'oem_api' ? 'From the manufacturer' : 'Built from service history'}
        {manual && <> · <a href={manual} target="_blank" rel="noopener noreferrer" className="focus-ring font-semibold text-accent underline">Manual</a></>}
      </p>
      {error && <Retry onClick={() => void reload()} />}
      {!data && !error && <p role="status" className="text-text-secondary">Loading…</p>}
      {data && (
        <>
          <DetailList title="Recalls" empty="No recalls on file.">
            {data.recalls.map((r) => (
              <li key={r.id} className="px-3 py-2">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">{r.title}<span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY[r.severity]}`}>{r.severity}</span></p>
                <p className="text-xs text-text-secondary">#{r.recall_number} · {day(r.issued_date)}</p>
                {r.description && <p className="mt-1 break-words text-text-secondary">{r.description}</p>}
                {r.remedy && <p className="mt-1 break-words text-text-primary">Remedy: {r.remedy}</p>}
                {safeUrl(r.source_url) && <a href={safeUrl(r.source_url)!} target="_blank" rel="noopener noreferrer" className="focus-ring text-xs font-semibold text-accent underline">Source</a>}
              </li>
            ))}
          </DetailList>
          <DetailList title="Service bulletins" empty="No bulletins on file.">
            {data.bulletins.map((b) => (
              <li key={b.id} className="px-3 py-2">
                <p className="font-medium text-text-primary">{b.title}</p>
                <p className="text-xs text-text-secondary">#{b.bulletin_number} · {day(b.issued_date)}</p>
                {b.description && <p className="mt-1 break-words text-text-secondary">{b.description}</p>}
                {safeUrl(b.source_url) && <a href={safeUrl(b.source_url)!} target="_blank" rel="noopener noreferrer" className="focus-ring text-xs font-semibold text-accent underline">Source</a>}
              </li>
            ))}
          </DetailList>
          <DetailList title="Known failure patterns" empty="No failure patterns computed yet.">
            {data.patterns.map((p) => (
              <li key={p.id} className="px-3 py-2">
                <p className="font-medium text-text-primary">{p.failure_mode}</p>
                <p className="text-xs text-text-secondary">Seen in {p.sample_size} unit(s){p.typical_age_months ? ` · typically around ${Math.round(p.typical_age_months / 12 * 10) / 10} years old` : ''} · frequency score {Number(p.frequency_score).toFixed(1)}</p>
                {p.common_fix && <p className="mt-1 break-words text-text-secondary">Common fix: {p.common_fix}</p>}
              </li>
            ))}
          </DetailList>
          <DetailList title="Parts" empty="No parts on file.">
            {data.parts.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0"><span className="block truncate font-medium text-text-primary">{p.part_name}</span><span className="text-xs text-text-secondary">{p.part_number}{p.category ? ` · ${p.category}` : ''}</span></span>
                {p.avg_price !== null && <span className="shrink-0 text-text-secondary">~${Number(p.avg_price).toFixed(2)}</span>}
              </li>
            ))}
          </DetailList>
        </>
      )}
    </div>
  );
}

function DetailList({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-text-secondary">{title}</h3>
      {children.length === 0 ? <p className="mt-1 text-xs text-text-secondary">{empty}</p> : <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-bg-secondary">{children}</ul>}
    </div>
  );
}
