import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, Loader2, AlertTriangle, ShieldAlert, Lightbulb, PackagePlus, Link2, Flag } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/priceBook';
import { fetchMarketParts, fetchMarketSources } from '@/lib/partsMarket';
import type { MarketPart, MarketSource } from '@/lib/partsMarket';
import {
  buildChains,
  buildInsights,
  comparePrice,
  summarize,
  fetchChainInput,
  recordLot,
  recordPartEvent,
  linkInstallToLot,
  subscribeToSupplyChain,
  DEFAULT_FAILURE_COST_CENTS,
  CUSTODY_STAGE_LABELS,
  PART_EVENT_LABELS,
  TIER_LABELS,
  TRACE_STAGES,
} from '@/lib/supplyChainOutcome';
import type {
  Authenticity,
  ChainInput,
  ChainTier,
  CustodyStage,
  PartEventType,
  SupplyChain,
} from '@/lib/supplyChainOutcome';

const TIER_STYLES: Record<ChainTier, string> = {
  preferred: 'bg-success-500/10 text-success-500',
  approved: 'bg-accent/10 text-accent',
  watch: 'bg-warning-500/10 text-warning-500',
  avoid: 'bg-danger/10 text-danger',
  quarantine: 'bg-danger text-white',
};

const SEVERITY_STYLES = {
  critical: 'border-danger/40 bg-danger/5',
  high: 'border-warning-500/40 bg-warning-500/5',
  medium: 'border-border bg-bg-primary',
  info: 'border-border bg-bg-primary',
} as const;

const FIELD =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary';

const STAGES = Object.keys(CUSTODY_STAGE_LABELS) as CustodyStage[];

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-text-secondary">{hint}</p>}
    </Card>
  );
}

function ChainRow({ chain }: { chain: SupplyChain }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border/60 hover:bg-bg-primary/60"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen((v) => !v)}
        tabIndex={0}
        aria-expanded={open}
      >
        <td className="px-3 py-2.5">
          <p className="text-sm font-medium text-text-primary">{chain.manufacturer}</p>
          <p className="text-xs text-text-secondary">via {chain.supplier}</p>
        </td>
        <td className="px-3 py-2.5">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TIER_STYLES[chain.tier]}`}>{TIER_LABELS[chain.tier]}</span>
        </td>
        <td className="px-3 py-2.5 text-sm text-text-primary">{pct(chain.successProbability)}</td>
        <td className="px-3 py-2.5 text-sm text-text-primary">{chain.score}</td>
        <td className="px-3 py-2.5 text-sm text-text-primary">{formatCents(chain.avgUnitCostCents)}</td>
        <td className="px-3 py-2.5 text-sm font-medium text-text-primary">{formatCents(chain.expectedCostPerOutcomeCents)}</td>
        <td className="px-3 py-2.5 text-xs text-text-secondary">{chain.weakestLink.label}</td>
        <td className="px-3 py-2.5 text-xs capitalize text-text-secondary">{chain.confidence} · {chain.decidedJobs} jobs</td>
      </tr>
      {open && (
        <tr className="bg-bg-primary/40">
          <td colSpan={8} className="px-3 py-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {chain.dimensions.map((d) => (
                <div key={d.key} className="rounded-lg border border-border/60 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-primary">{d.label}</span>
                    <span className="text-text-secondary">{pct(d.score)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border/60">
                    <div className={`h-full ${d.score >= 0.8 ? 'bg-success-500' : d.score >= 0.6 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: pct(d.score) }} />
                  </div>
                  <p className="mt-1.5 text-[11px] text-text-secondary">{d.detail}</p>
                </div>
              ))}
            </div>
            {chain.flags.length > 0 && (
              <ul className="mt-3 space-y-1">
                {chain.flags.map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-xs text-text-secondary">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning-500" /> {f}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function SupplyChainOutcomePage() {
  const { toast } = useToast();
  const [data, setData] = useState<ChainInput | null>(null);
  const [parts, setParts] = useState<MarketPart[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partId, setPartId] = useState('');
  const [failureDollars, setFailureDollars] = useState(String(DEFAULT_FAILURE_COST_CENTS / 100));

  const load = useCallback(async () => {
    try {
      const [input, p, s] = await Promise.all([fetchChainInput(), fetchMarketParts(), fetchMarketSources()]);
      setData(input);
      setParts(p);
      setSources(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load supply chain data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribeToSupplyChain(() => void load());
  }, [load]);

  const failureCostCents = useMemo(() => {
    const n = Number(failureDollars);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : DEFAULT_FAILURE_COST_CENTS;
  }, [failureDollars]);

  const view = useMemo(() => {
    if (!data) return null;
    const chains = buildChains(data, { partId: partId || null, failureCostCents });
    const allChains = partId ? buildChains(data, { failureCostCents }) : chains;
    const summary = summarize(allChains, data.installs);
    return {
      chains,
      comparison: partId ? comparePrice(chains) : null,
      summary,
      insights: buildInsights(allChains, summary, data.lots),
    };
  }, [data, partId, failureCostCents]);

  const untraced = useMemo(() => (data?.installs ?? []).filter((i) => i.lot_id === null).slice(0, 8), [data]);

  const handleLink = async (installId: string, lotId: string) => {
    if (!lotId) return;
    try {
      await linkInstallToLot(installId, lotId);
      toast('Install linked to lot.', 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not link install.', 'error');
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Supply Chain Outcomes">
        <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Supply Chain Outcomes">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <GitBranch size={22} /> Supply Chain Outcome Graph
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Manufacturer → distributor → inventory → truck → technician → job → outcome. Vireek learns which supply chain
          actually produces successful repairs — because the cheapest part is not always the best part.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {view && (
        <div className="space-y-8">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Supply chains tracked" value={String(view.summary.chains)} />
            <Kpi label="Avg repair success probability" value={view.summary.chains ? pct(view.summary.avgSuccessProbability) : '—'} />
            <Kpi label="Traceability" value={data && data.installs.length ? pct(view.summary.traceability) : '—'} hint={`${view.summary.untracedInstalls} untraced install(s)`} />
            <Kpi label="Quarantined chains" value={String(view.summary.quarantined)} />
          </div>

          {view.insights.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><Lightbulb size={14} /> What to do</h2>
              <div className="space-y-2">
                {view.insights.map((i) => (
                  <div key={i.id} className={`rounded-lg border p-3 ${SEVERITY_STYLES[i.severity]}`}>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      {i.severity === 'critical' && <ShieldAlert size={14} className="text-danger" />} {i.title}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">{i.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-sm font-semibold text-text-primary">Which chain wins?</h2>
              <div className="flex flex-wrap gap-3">
                <label className="text-xs text-text-secondary">
                  Part
                  <select className={`${FIELD} mt-1`} value={partId} onChange={(e) => setPartId(e.target.value)} aria-label="Filter by part">
                    <option value="">All parts</option>
                    {parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="text-xs text-text-secondary">
                  Cost of a failed repair ($)
                  <input className={`${FIELD} mt-1`} type="number" min={0} step={10} value={failureDollars} onChange={(e) => setFailureDollars(e.target.value)} />
                </label>
              </div>
            </div>

            {view.comparison?.insight && (
              <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm text-text-primary">{view.comparison.insight}</div>
            )}

            {view.chains.length === 0 ? (
              <EmptyState
                icon={GitBranch}
                title="No supply chains yet"
                description="Record a received lot below. Once parts from that lot are used on jobs, outcomes start flowing in automatically."
              />
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full min-w-[820px] text-left">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-text-secondary">
                      {['Supply chain', 'Tier', 'P(success)', 'Score', 'Unit cost', 'Expected cost / outcome', 'Weakest link', 'Evidence'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>{view.chains.map((c) => <ChainRow key={c.key} chain={c} />)}</tbody>
                </table>
              </Card>
            )}
          </section>

          {untraced.length > 0 && data && (
            <section>
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><Link2 size={14} /> Untraced installs</h2>
              <Card className="space-y-2 p-4">
                {untraced.map((i) => {
                  const lots = data.lots.filter((l) => l.part_id === i.part_id);
                  return (
                    <div key={i.install_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="text-text-primary">{i.part_name} × {i.quantity}</span>
                      <select className={`${FIELD} max-w-xs`} defaultValue="" aria-label={`Link ${i.part_name} to a lot`} onChange={(e) => void handleLink(i.install_id, e.target.value)}>
                        <option value="">{lots.length ? 'Link to a lot…' : 'No lots recorded for this part'}</option>
                        {lots.map((l) => (
                          <option key={l.id} value={l.id}>{l.manufacturer ?? 'Unknown'} via {l.supplier_name} · {new Date(l.received_at).toLocaleDateString()}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </Card>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <RecordLotForm parts={parts} sources={sources} onSaved={load} />
            <PartEventForm data={data} onSaved={load} />
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

// ------------------------------------------------------------
// Record a received lot (provenance)
// ------------------------------------------------------------

function RecordLotForm({ parts, sources, onSaved }: { parts: MarketPart[]; sources: MarketSource[]; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    part_id: '', source_id: '', manufacturer: '', distributor: '', lot_code: '',
    authenticity: 'unverified' as Authenticity, quantity: '1', unit_cost: '', promised_at: '',
  });
  const [stages, setStages] = useState<CustodyStage[]>(['manufacturer', 'distributor']);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.part_id) return toast('Choose a part.', 'error');
    const source = sources.find((s) => s.id === f.source_id);
    setSaving(true);
    try {
      await recordLot({
        part_id: f.part_id,
        market_source_id: source?.id ?? null,
        vendor_id: source?.vendor_id ?? null,
        manufacturer: f.manufacturer,
        distributor: f.distributor || source?.name || null,
        lot_code: f.lot_code,
        authenticity: f.authenticity,
        quantity_received: Math.floor(Number(f.quantity)),
        unit_cost_cents: Math.round(Number(f.unit_cost || 0) * 100),
        promised_at: f.promised_at ? new Date(f.promised_at).toISOString() : null,
        stages,
      });
      toast('Lot recorded.', 'success');
      setF((p) => ({ ...p, manufacturer: '', distributor: '', lot_code: '', quantity: '1', unit_cost: '', promised_at: '' }));
      await onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record lot.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><PackagePlus size={14} /> Record a received lot</h2>
      <form onSubmit={submit} className="space-y-3">
        <select className={FIELD} value={f.part_id} onChange={set('part_id')} aria-label="Part" required>
          <option value="">Part…</option>
          {parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className={FIELD} value={f.source_id} onChange={set('source_id')} aria-label="Supplier">
          <option value="">Supplier (optional)…</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <input className={FIELD} placeholder="Manufacturer" value={f.manufacturer} onChange={set('manufacturer')} aria-label="Manufacturer" />
          <input className={FIELD} placeholder="Distributor" value={f.distributor} onChange={set('distributor')} aria-label="Distributor" />
          <input className={FIELD} placeholder="Lot / batch code" value={f.lot_code} onChange={set('lot_code')} aria-label="Lot code" />
          <select className={FIELD} value={f.authenticity} onChange={set('authenticity')} aria-label="Authenticity">
            <option value="verified">Verified authentic</option>
            <option value="unverified">Unverified</option>
            <option value="suspect">Suspect</option>
            <option value="counterfeit">Counterfeit</option>
          </select>
          <input className={FIELD} type="number" min={1} step={1} placeholder="Quantity" value={f.quantity} onChange={set('quantity')} aria-label="Quantity" required />
          <input className={FIELD} type="number" min={0} step="0.01" placeholder="Unit cost ($)" value={f.unit_cost} onChange={set('unit_cost')} aria-label="Unit cost" />
        </div>
        <label className="block text-xs text-text-secondary">
          Promised delivery (optional)
          <input className={`${FIELD} mt-1`} type="datetime-local" value={f.promised_at} onChange={set('promised_at')} />
        </label>
        <fieldset>
          <legend className="mb-1 text-xs text-text-secondary">Custody already verified</legend>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.filter((s) => TRACE_STAGES.includes(s)).map((s) => {
              const on = stages.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStages((p) => (on ? p.filter((x) => x !== s) : [...p, s]))}
                  className={`focus-ring rounded-full border px-2.5 py-1 text-[11px] ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}
                >
                  {CUSTODY_STAGE_LABELS[s]}
                </button>
              );
            })}
          </div>
        </fieldset>
        <button type="submit" disabled={saving} className="focus-ring w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Record lot'}
        </button>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------
// Report DOA / defect / return / warranty on a lot
// ------------------------------------------------------------

function PartEventForm({ data, onSaved }: { data: ChainInput | null; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [lotId, setLotId] = useState('');
  const [type, setType] = useState<PartEventType>('defect');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lotId) return toast('Choose a lot.', 'error');
    setSaving(true);
    try {
      await recordPartEvent({ lot_id: lotId, event_type: type, quantity: Math.floor(Number(qty)), note });
      toast('Event recorded.', 'success');
      setNote('');
      setQty('1');
      await onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record event.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><Flag size={14} /> Report a defect, return or warranty result</h2>
      <form onSubmit={submit} className="space-y-3">
        <select className={FIELD} value={lotId} onChange={(e) => setLotId(e.target.value)} aria-label="Lot" required>
          <option value="">Lot…</option>
          {(data?.lots ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.part_name} · {l.manufacturer ?? 'Unknown'} via {l.supplier_name} · {new Date(l.received_at).toLocaleDateString()}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <select className={FIELD} value={type} onChange={(e) => setType(e.target.value as PartEventType)} aria-label="Event type">
            {(Object.keys(PART_EVENT_LABELS) as PartEventType[]).map((t) => <option key={t} value={t}>{PART_EVENT_LABELS[t]}</option>)}
          </select>
          <input className={FIELD} type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Units" />
        </div>
        <input className={FIELD} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <button type="submit" disabled={saving} className="focus-ring w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Record event'}
        </button>
      </form>
    </Card>
  );
}
