/**
 * Service Graph — /dashboard/service-graph
 *
 * Persistent graph of Customer → Property → Equipment → Failure →
 * Technician → Part → Job → Outcome → Warranty → Future Failure.
 * Intelligence tab: transparent reasoning over the graph.
 * Explorer tab: search, neighbourhood visualisation, failure recording.
 * See src/lib/serviceGraph.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Network, Package, RefreshCw, Search, Wrench } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  connectionsOf,
  FAILURE_CODE_SUGGESTIONS,
  fetchGraphInsights,
  fetchGraphStats,
  fetchNeighborhood,
  layoutGraph,
  MIN_GROUP_SAMPLE,
  NODE_COLORS,
  NODE_LABELS,
  NODE_TYPES,
  pct,
  REBUILD_PHASE_LABELS,
  rebuildServiceGraph,
  recordGraphFailure,
  relationLabel,
  RISK_COLORS,
  riskTier,
  searchGraphNodes,
  truncate,
  type GraphEdge,
  type GraphInsights,
  type GraphNode,
  type GraphNodeType,
  type GraphStats,
  type Neighborhood,
} from '@/lib/serviceGraph';

type Tab = 'intelligence' | 'explorer';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const FIELD =
  'w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus-ring';

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}

// ============================================================
// SMALL PARTS
// ============================================================

function TypeDot({ type }: { type: GraphNodeType }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: NODE_COLORS[type] }} />;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, note }: { icon: typeof Network; title: string; note?: string }) {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon size={15} /> {title}
      </h2>
      {note && <p className="mt-0.5 text-xs text-text-secondary">{note}</p>}
    </div>
  );
}

function RowButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left hover:bg-bg-tertiary"
    >
      {children}
    </button>
  );
}

// ============================================================
// INTELLIGENCE
// ============================================================

function IntelligencePanel({ insights, onOpen }: { insights: GraphInsights; onOpen: (id: string) => void }) {
  const empty =
    insights.equipment_risk.length === 0 &&
    insights.failure_patterns.length === 0 &&
    insights.part_signals.length === 0 &&
    insights.technician_signals.length === 0;

  if (empty) {
    return (
      <EmptyState
        icon={Network}
        title="The graph is still learning"
        description="Insights appear once failures are linked to jobs, equipment and parts. Open a job in the Explorer and record its failure, or let callback root-cause analyses feed the graph automatically."
      />
    );
  }

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <SectionTitle
          icon={AlertTriangle}
          title="Future failure risk"
          note={`Score = 60% failure rate of same make/model (min ${MIN_GROUP_SAMPLE} units) + 25% age vs expected lifespan + 15% own failure history.`}
        />
        {insights.equipment_risk.length === 0 ? (
          <p className="text-xs text-text-secondary">No active equipment has enough graph evidence yet.</p>
        ) : (
          <ul className="space-y-1">
            {insights.equipment_risk.map((u) => (
              <li key={u.node_id}>
                <RowButton onClick={() => onOpen(u.node_id)}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{u.label}</span>
                    <span className="block text-xs text-text-secondary">
                      Group failure rate {pct(u.group_failure_rate)} (n={u.sample_size}) · age {pct(u.age_ratio)} of lifespan
                      {u.own_failures > 0 ? ` · ${u.own_failures} own failure${u.own_failures > 1 ? 's' : ''}` : ''}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${RISK_COLORS[riskTier(u.risk_score)]}`}>
                    {u.risk_score}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
        {insights.equipment_groups.length > 0 && (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1 text-xs font-medium text-text-secondary">Model groups with recurring failures</p>
            <ul className="space-y-1">
              {insights.equipment_groups.map((g) => (
                <li key={`${g.make}|${g.model}|${g.equipment_type}`} className="flex justify-between gap-3 text-xs text-text-secondary">
                  <span className="truncate">{g.make} · {g.model} · {g.equipment_type}</span>
                  <span className="shrink-0">{g.failed_units}/{g.units} units · {pct(g.failure_rate)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={CARD}>
        <SectionTitle icon={Wrench} title="Failure patterns" note="Most frequent diagnosed failures across your jobs." />
        {insights.failure_patterns.length === 0 ? (
          <p className="text-xs text-text-secondary">No failures recorded yet.</p>
        ) : (
          <ul className="space-y-1">
            {insights.failure_patterns.map((f) => (
              <li key={f.node_id}>
                <RowButton onClick={() => onOpen(f.node_id)}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{f.label}</span>
                    {f.parts.length > 0 && (
                      <span className="block truncate text-xs text-text-secondary">Linked parts: {f.parts.join(', ')}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-text-secondary">
                    {f.jobs} job{f.jobs === 1 ? '' : 's'}{f.callbacks > 0 ? ` · ${f.callbacks} callback visit${f.callbacks === 1 ? '' : 's'}` : ''}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <SectionTitle icon={Package} title="Part signals" note="Parts implicated in failures vs. jobs where they were installed." />
        {insights.part_signals.length === 0 ? (
          <p className="text-xs text-text-secondary">No parts linked to failures yet.</p>
        ) : (
          <ul className="space-y-1">
            {insights.part_signals.map((p) => (
              <li key={p.node_id}>
                <RowButton onClick={() => onOpen(p.node_id)}>
                  <span className="truncate text-sm text-text-primary">{p.label}</span>
                  <span className="shrink-0 text-xs text-text-secondary">
                    {p.failure_jobs} failure{p.failure_jobs === 1 ? '' : 's'} / {p.used_in_jobs} installs · {pct(p.failure_rate)}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <SectionTitle
          icon={Activity}
          title="Technician callback signals"
          note="Callbacks that originated from jobs each technician handled. Treat small samples with care."
        />
        {insights.technician_signals.length === 0 ? (
          <p className="text-xs text-text-secondary">No callbacks linked to technicians yet.</p>
        ) : (
          <ul className="space-y-1">
            {insights.technician_signals.map((t) => (
              <li key={t.node_id}>
                <RowButton onClick={() => onOpen(t.node_id)}>
                  <span className="truncate text-sm text-text-primary">{t.label}</span>
                  <span className="shrink-0 text-xs text-text-secondary">
                    {t.callbacks} callback{t.callbacks === 1 ? '' : 's'} / {t.jobs_handled} jobs · {pct(t.callback_rate)}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ============================================================
// EXPLORER
// ============================================================

function GraphCanvas({
  nodes,
  edges,
  rootId,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootId: string;
  onSelect: (id: string) => void;
}) {
  const W = 760;
  const H = 460;
  const positioned = useMemo(() => layoutGraph(nodes, edges, rootId, W, H), [nodes, edges, rootId]);
  const byId = useMemo(() => new Map(positioned.map((n) => [n.id, n] as const)), [positioned]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-text-secondary" role="group" aria-label="Service graph neighbourhood">
      {edges.map((e) => {
        const a = byId.get(e.from_node);
        const b = byId.get(e.to_node);
        if (!a || !b) return null;
        return (
          <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.2}>
            <title>{relationLabel(e.relation)}</title>
          </line>
        );
      })}
      {positioned.map((n) => (
        <g
          key={n.id}
          transform={`translate(${n.x} ${n.y})`}
          role="button"
          tabIndex={0}
          aria-label={`${NODE_LABELS[n.node_type]}: ${n.label}`}
          className="cursor-pointer"
          onClick={() => onSelect(n.id)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              onSelect(n.id);
            }
          }}
        >
          <circle
            r={n.is_root ? 15 : 10}
            fill={NODE_COLORS[n.node_type]}
            fillOpacity={n.is_root ? 1 : 0.85}
            stroke={n.is_root ? 'currentColor' : 'none'}
            strokeWidth={2}
          />
          <text y={n.is_root ? 30 : 24} textAnchor="middle" fontSize={11} fill="currentColor">
            {truncate(n.label, 22)}
          </text>
          <title>{`${NODE_LABELS[n.node_type]} · ${n.label}`}</title>
        </g>
      ))}
    </svg>
  );
}

function RecordFailureCard({
  job,
  equipment,
  parts,
  onDone,
}: {
  job: GraphNode;
  equipment: GraphNode[];
  parts: GraphNode[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [equipmentKey, setEquipmentKey] = useState('');
  const [partKey, setPartKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.trim().length < 2) {
      toast('Enter a failure code (2+ characters)', 'error');
      return;
    }
    setBusy(true);
    try {
      await recordGraphFailure({
        jobId: job.node_key,
        failureCode: code,
        equipmentId: equipmentKey || null,
        partId: partKey || null,
        note,
      });
      toast('Failure recorded in the graph');
      setCode('');
      setNote('');
      setEquipmentKey('');
      setPartKey('');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  return (
    <div className={CARD}>
      <SectionTitle
        icon={Wrench}
        title="Record failure for this job"
        note="Use consistent codes — the graph learns from repeated patterns."
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <input
            className={FIELD}
            list="sg-failure-codes"
            value={code}
            maxLength={60}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Failure code (e.g. capacitor_failure)"
            aria-label="Failure code"
          />
          <datalist id="sg-failure-codes">
            {FAILURE_CODE_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <input
          className={FIELD}
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          aria-label="Note"
        />
        <select className={FIELD} value={equipmentKey} onChange={(e) => setEquipmentKey(e.target.value)} aria-label="Equipment">
          <option value="">Equipment (optional)</option>
          {equipment.map((n) => (
            <option key={n.id} value={n.node_key}>{n.label}</option>
          ))}
        </select>
        <select className={FIELD} value={partKey} onChange={(e) => setPartKey(e.target.value)} aria-label="Part">
          <option value="">Implicated part (optional)</option>
          {parts.map((n) => (
            <option key={n.id} value={n.node_key}>{n.label}</option>
          ))}
        </select>
      </div>
      <div className="mt-3">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Record failure'}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ServiceGraphPage() {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [tab, setTab] = useState<Tab>('intelligence');
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [insights, setInsights] = useState<GraphInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<GraphNodeType | null>(null);
  const [results, setResults] = useState<GraphNode[]>([]);
  const [searching, setSearching] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState(2);
  const [hood, setHood] = useState<Neighborhood | null>(null);
  const [loadingHood, setLoadingHood] = useState(false);

  const loadCore = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([fetchGraphStats(), fetchGraphInsights()]);
      setStats(s);
      setInsights(i);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadCore(); }, [loadCore]);

  useEffect(() => {
    if (tab !== 'explorer') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchGraphNodes(query, typeFilter)
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch((e) => { if (!cancelled) toastRef.current(errMessage(e), 'error'); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, query ? 300 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab, query, typeFilter]);

  const openNode = useCallback(async (id: string, hops: number) => {
    setSelectedId(id);
    setTab('explorer');
    setLoadingHood(true);
    try {
      setHood(await fetchNeighborhood(id, hops));
    } catch (e) {
      toastRef.current(errMessage(e), 'error');
      setHood(null);
    }
    setLoadingHood(false);
  }, []);

  const changeDepth = (hops: number) => {
    setDepth(hops);
    if (selectedId) void openNode(selectedId, hops);
  };

  const sync = async () => {
    setSyncing('Starting…');
    try {
      const n = await rebuildServiceGraph((p) => setSyncing(`${REBUILD_PHASE_LABELS[p.phase]} · ${p.done} records`));
      toast(`Graph synced (${n} records)`);
      await loadCore();
      if (selectedId) await openNode(selectedId, depth);
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setSyncing(null);
  };

  const root = useMemo(() => hood?.nodes.find((n) => n.is_root) ?? null, [hood]);
  const connections = useMemo(
    () => (hood && root ? connectionsOf(root.id, hood.nodes, hood.edges) : []),
    [hood, root],
  );
  const hoodEquipment = useMemo(() => hood?.nodes.filter((n) => n.node_type === 'equipment') ?? [], [hood]);
  const hoodParts = useMemo(() => hood?.nodes.filter((n) => n.node_type === 'part') ?? [], [hood]);

  const needsSync = !!stats && (stats.node_count === 0 || stats.jobs_in_graph < stats.jobs_total);

  return (
    <DashboardLayout activeLabel="Service Graph">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Network size={18} /> Service Graph
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Every customer, property, equipment, failure, technician, part and outcome connected in one graph that grows with each job.
            </p>
          </div>
          <Button size="sm" variant={needsSync ? 'primary' : 'secondary'} disabled={syncing !== null} onClick={() => void sync()}>
            <span className="flex items-center gap-1.5">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ?? (needsSync ? 'Build graph from existing data' : 'Re-sync graph')}
            </span>
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed || !stats || !insights ? (
          <EmptyState
            icon={Network}
            title="Service Graph unavailable"
            description="The Service Graph tables were not found. Apply the 20261231000000_service_graph migration, then reload."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void loadCore(); } }}
          />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Nodes" value={String(stats.node_count)} />
              <StatCard label="Connections" value={String(stats.edge_count)} />
              <StatCard label="Jobs in graph" value={`${stats.jobs_in_graph} / ${stats.jobs_total}`} />
              <StatCard label="Failures learned" value={String(stats.nodes_by_type.failure ?? 0)} />
            </div>

            <div className="mb-4 flex gap-1 rounded-xl bg-bg-secondary p-1" role="tablist" aria-label="Service graph views">
              {(['intelligence', 'explorer'] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`focus-ring flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === t ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t === 'intelligence' ? 'Intelligence' : 'Explorer'}
                </button>
              ))}
            </div>

            {tab === 'intelligence' ? (
              <IntelligencePanel insights={insights} onOpen={(id) => void openNode(id, depth)} />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                <div className={CARD}>
                  <div className="relative mb-2">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                    <input
                      className={`${FIELD} pl-8`}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search customers, jobs, parts…"
                      aria-label="Search graph"
                    />
                  </div>
                  <select
                    className={`${FIELD} mb-2`}
                    value={typeFilter ?? ''}
                    onChange={(e) => setTypeFilter((e.target.value || null) as GraphNodeType | null)}
                    aria-label="Filter by type"
                  >
                    <option value="">All types</option>
                    {NODE_TYPES.map((t) => (
                      <option key={t} value={t}>{NODE_LABELS[t]}</option>
                    ))}
                  </select>
                  <ul className="max-h-[420px] space-y-0.5 overflow-y-auto">
                    {results.map((n) => (
                      <li key={n.id}>
                        <RowButton onClick={() => void openNode(n.id, depth)}>
                          <span className="flex min-w-0 items-center gap-2">
                            <TypeDot type={n.node_type} />
                            <span className="truncate text-sm text-text-primary">{n.label}</span>
                          </span>
                          <span className="shrink-0 text-[11px] text-text-secondary">{n.degree ?? 0}</span>
                        </RowButton>
                      </li>
                    ))}
                    {!searching && results.length === 0 && (
                      <li className="px-2 py-3 text-xs text-text-secondary">No nodes found.</li>
                    )}
                  </ul>
                </div>

                <div className="space-y-4">
                  {!selectedId ? (
                    <EmptyState
                      icon={Network}
                      title="Pick a node to explore"
                      description="Search on the left, or open any item from the Intelligence tab, to see everything connected to it."
                    />
                  ) : loadingHood ? (
                    <SkeletonCardList count={2} />
                  ) : !hood || !root ? (
                    <EmptyState icon={Network} title="Node unavailable" description="This node could not be loaded." />
                  ) : (
                    <>
                      <div className={CARD}>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
                            <TypeDot type={root.node_type} />
                            <span className="truncate">{root.label}</span>
                            <span className="shrink-0 text-xs font-normal text-text-secondary">{NODE_LABELS[root.node_type]}</span>
                          </p>
                          <div className="flex gap-1">
                            {[1, 2].map((h) => (
                              <Button key={h} size="sm" variant={depth === h ? 'primary' : 'secondary'} onClick={() => changeDepth(h)}>
                                {h} hop{h > 1 ? 's' : ''}
                              </Button>
                            ))}
                          </div>
                        </div>
                        <GraphCanvas
                          nodes={hood.nodes}
                          edges={hood.edges}
                          rootId={root.id}
                          onSelect={(id) => void openNode(id, depth)}
                        />
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {NODE_TYPES.filter((t) => hood.nodes.some((n) => n.node_type === t)).map((t) => (
                            <span key={t} className="flex items-center gap-1 text-[11px] text-text-secondary">
                              <TypeDot type={t} /> {NODE_LABELS[t]}
                            </span>
                          ))}
                        </div>
                        {hood.truncated && (
                          <p className="mt-2 text-xs text-text-secondary">Large neighbourhood — showing the most recent connections.</p>
                        )}
                      </div>

                      <div className={CARD}>
                        <SectionTitle icon={Network} title={`Connections (${connections.length})`} />
                        {connections.length === 0 ? (
                          <p className="text-xs text-text-secondary">No direct connections.</p>
                        ) : (
                          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                            {connections.map((c) => (
                              <li key={c.edge.id}>
                                <RowButton onClick={() => void openNode(c.other.id, depth)}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="w-28 shrink-0 text-xs text-text-secondary">
                                      {c.outgoing ? '→' : '←'} {relationLabel(c.edge.relation)}
                                    </span>
                                    <TypeDot type={c.other.node_type} />
                                    <span className="truncate text-sm text-text-primary">{c.other.label}</span>
                                  </span>
                                  {c.edge.source !== 'system' && (
                                    <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                                      {c.edge.source}
                                    </span>
                                  )}
                                </RowButton>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {root.node_type === 'job' && (
                        <RecordFailureCard
                          job={root}
                          equipment={hoodEquipment}
                          parts={hoodParts}
                          onDone={() => { void loadCore(); void openNode(root.id, depth); }}
                        />
                      )}
                    </>
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
