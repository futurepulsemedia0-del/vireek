import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScanEye, ShieldAlert, TriangleAlert as AlertTriangle, Layers } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { PropertyVisionScanner } from '@/components/property-vision/PropertyVisionScanner';
import { AssetDetailPanel } from '@/components/property-vision/AssetDetailPanel';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  CONDITION_STYLES, SEVERITY_STYLES, ageLabel, fetchAssets, formatWhen, humanize, type PvAnalyzeResult, type PvAsset,
} from '@/lib/propertyVision';

type Filter = 'all' | 'attention' | 'unconfirmed';
interface CustomerOpt { id: string; name: string }

export function PropertyVisionPage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customer');
  const selectedId = params.get('asset');

  const [customers, setCustomers] = useState<CustomerOpt[]>([]);
  const [assets, setAssets] = useState<PvAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [scanning, setScanning] = useState(false);
  const [rescan, setRescan] = useState<PvAsset | null>(null);
  const [lastResult, setLastResult] = useState<PvAnalyzeResult | null>(null);

  const setParam = useCallback((key: string, value: string | null) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (value) n.set(key, value); else n.delete(key);
      if (key === 'customer') n.delete('asset');
      return n;
    }, { replace: true });
  }, [setParams]);

  const load = useCallback(async () => {
    try {
      setAssets(await fetchAssets({ customerId }));
    } catch {
      toast('Could not load property memory', 'error');
    } finally {
      setLoading(false);
    }
  }, [customerId, toast]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('customers').select('id, name').order('name').limit(500);
      if (!cancelled) setCustomers((data ?? []) as CustomerOpt[]);
    })();
    return () => { cancelled = true; };
  }, []);

  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const visible = useMemo(() => assets.filter((a) =>
    filter === 'attention' ? a.open_hazard_count > 0 || !!a.possible_duplicate_of
      : filter === 'unconfirmed' ? !a.human_confirmed : true), [assets, filter]);

  const stats = useMemo(() => ({
    units: assets.length,
    hazards: assets.reduce((n, a) => n + a.open_hazard_count, 0),
    review: assets.filter((a) => !a.human_confirmed).length,
  }), [assets]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const scanScope = { customerId };
  const canScan = !!customerId;

  const onScanDone = (r: PvAnalyzeResult) => {
    setLastResult(r);
    setScanning(false);
    setRescan(null);
    if (r.already_analyzed) toast('These photos were already analyzed — nothing new to add.', 'info');
    void load();
    const first = r.assets[0]?.asset_id;
    if (first) setParam('asset', first);
  };

  const urgent = lastResult ? [...lastResult.findings.new, ...lastResult.findings.worsened].filter((f) => f.severity === 'high' || f.severity === 'emergency') : [];

  return (
    <DashboardLayout activeLabel="Property Vision">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ScanEye size={24} className="text-accent" /> Property Vision</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Every photo becomes lasting knowledge: which unit it is, its model and serial, condition, installation quality, hazards and components — remembered visit after visit.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="pv-customer" className="sr-only">Customer</label>
            <select
              id="pv-customer"
              value={customerId ?? ''}
              onChange={(e) => setParam('customer', e.target.value || null)}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
            >
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Button size="sm" disabled={!canScan} onClick={() => { setRescan(null); setScanning(true); }} title={canScan ? undefined : 'Pick a customer first'}>
              <ScanEye size={16} /> New scan
            </Button>
          </div>
        </div>

        {(scanning || rescan) && canScan && (
          <div className="mb-6">
            <PropertyVisionScanner
              scope={scanScope}
              assetId={rescan?.id ?? null}
              assetLabel={rescan?.label ?? null}
              onDone={onScanDone}
              onCancel={() => { setScanning(false); setRescan(null); }}
            />
          </div>
        )}

        {lastResult && !lastResult.already_analyzed && (
          <div role="status" className={`mb-6 rounded-2xl border p-4 text-sm ${urgent.length ? 'border-danger-500/30 bg-danger-500/5' : 'border-border bg-bg-secondary'}`}>
            <p className="font-semibold text-text-primary">
              Scan complete — {lastResult.assets.length} unit{lastResult.assets.length === 1 ? '' : 's'} recognized
              {lastResult.assets.some((a) => !a.is_new) ? ` (${lastResult.assets.filter((a) => !a.is_new).length} matched to memory)` : ''}.
            </p>
            {lastResult.scene?.summary && <p className="mt-1 text-xs text-text-secondary">{lastResult.scene.summary}</p>}
            {lastResult.changes.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {lastResult.changes.slice(0, 8).map((c, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_STYLES[c.severity]}`}>{humanize(c.severity)}</span>
                    <span className="text-text-primary">{c.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            {lastResult.duplicates > 0 && <p className="mt-2 text-[11px] text-text-secondary">{lastResult.duplicates} photo(s) were already analyzed and skipped.</p>}
          </div>
        )}

        {loading ? (
          <>
            <SkeletonStatGrid count={3} className="mb-6" />
            <SkeletonCardList count={3} />
          </>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-3 gap-3">
              {[
                { label: 'Units remembered', value: stats.units, icon: Layers, tone: 'text-accent' },
                { label: 'Open hazards', value: stats.hazards, icon: ShieldAlert, tone: stats.hazards ? 'text-danger-500' : 'text-text-secondary' },
                { label: 'Awaiting review', value: stats.review, icon: AlertTriangle, tone: stats.review ? 'text-warning-500' : 'text-text-secondary' },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <s.icon size={16} className={s.tone} aria-hidden />
                  <p className="mt-2 text-2xl font-bold text-text-primary">{s.value}</p>
                  <p className="text-xs text-text-secondary">{s.label}</p>
                </div>
              ))}
            </div>

            {assets.length === 0 ? (
              <EmptyState
                icon={ScanEye}
                title="No equipment remembered yet"
                description={canScan ? 'Take photos of a mechanical room, water heater or panel. Vireek will identify the units and start building this property’s memory.' : 'Pick a customer, then scan their equipment photos to start building property memory.'}
                action={canScan ? { label: 'Start first scan', onClick: () => setScanning(true) } : undefined}
              />
            ) : (
              <div className="grid gap-6 lg:grid-cols-5">
                <div className="lg:col-span-2">
                  <div className="mb-3 flex gap-1.5" role="tablist" aria-label="Filter units">
                    {([['all', 'All'], ['attention', 'Needs attention'], ['unconfirmed', 'Unconfirmed']] as [Filter, string][]).map(([k, label]) => (
                      <button
                        key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === k ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                      >{label}</button>
                    ))}
                  </div>
                  <ul className="space-y-2">
                    {visible.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button" onClick={() => setParam('asset', a.id)} aria-current={a.id === selectedId}
                          className={`focus-ring w-full rounded-2xl border p-3.5 text-left transition-colors ${a.id === selectedId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="truncate text-sm font-semibold text-text-primary">{a.label}</p>
                            {a.max_open_severity && a.open_findings_count > 0 && (
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${SEVERITY_STYLES[a.max_open_severity]}`}>
                                {a.open_findings_count} open · {a.max_open_severity}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-text-secondary">
                            {!customerId && a.customer_id ? `${customerName.get(a.customer_id) ?? 'Customer'} · ` : ''}{[a.make, a.model].filter(Boolean).join(' ') || 'Make/model not identified'}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className={`rounded-full px-2 py-0.5 font-semibold ${CONDITION_STYLES[a.condition]}`}>{a.condition}</span>
                            <span className="text-text-secondary">{ageLabel(a)}</span>
                            <span className="text-text-secondary">· seen {formatWhen(a.last_seen_at)}</span>
                            {a.possible_duplicate_of && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 font-semibold text-warning-500">possible duplicate</span>}
                          </div>
                        </button>
                      </li>
                    ))}
                    {visible.length === 0 && <li className="py-6 text-center text-xs text-text-secondary">Nothing matches this filter.</li>}
                  </ul>
                </div>

                <div className="lg:col-span-3">
                  {selected ? (
                    <AssetDetailPanel
                      key={selected.id}
                      asset={selected}
                      duplicateOf={selected.possible_duplicate_of ? byId.get(selected.possible_duplicate_of) ?? null : null}
                      onChanged={() => void load()}
                      onRescan={(a) => { setScanning(false); setRescan(a); if (a.customer_id && a.customer_id !== customerId) setParam('customer', a.customer_id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    />
                  ) : (
                    <EmptyState icon={Layers} title="Select a unit" description="Choose equipment on the left to see its identity, condition, hazards and full history." />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
