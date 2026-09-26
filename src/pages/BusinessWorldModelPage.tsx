/**
 * Business World Model — /dashboard/world-model
 *
 * One live graph over Customer + Property + Asset + Job + Technician +
 * Invoice + Communication + Event, assembled from data that already
 * exists elsewhere in the app (see src/lib/worldModel.ts — nothing here
 * is duplicated storage). A second tab layers a Causal Business Graph
 * on top: rule-detected candidates the owner confirms, plus edges drawn
 * by hand (src/lib/causalGraph.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight, Check, Clock, FileText, GitBranch, Loader2, Network, Phone,
  Plus, Search, Trash2, UserCog, UserRound, Wrench, X, Zap, Home, Sparkles,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  buildWorldModel,
  EDGE_RELATION_LABELS,
  NODE_TYPE_LABELS,
  NODE_TYPE_ORDER,
  NodeType,
  subgraph,
  WorldModel,
  WorldNode,
} from '@/lib/worldModel';
import {
  CausalCandidate,
  CausalEdge,
  CausalRelationship,
  confirmCandidate,
  deleteCausalEdge,
  detectCausalCandidates,
  fetchCausalEdges,
  RELATIONSHIP_LABELS,
  saveCausalEdge,
} from '@/lib/causalGraph';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

const NODE_ICONS: Record<NodeType, typeof UserRound> = {
  customer: UserRound,
  property: Home,
  asset: Wrench,
  job: FileText,
  technician: UserCog,
  invoice: FileText,
  communication: Phone,
  event: Zap,
};

const NODE_COLORS: Record<NodeType, string> = {
  customer: 'text-accent bg-accent/10',
  property: 'text-warning-500 bg-warning-500/10',
  asset: 'text-text-secondary bg-bg-secondary',
  job: 'text-success-500 bg-success-500/10',
  technician: 'text-accent bg-accent/10',
  invoice: 'text-warning-500 bg-warning-500/10',
  communication: 'text-danger bg-danger/10',
  event: 'text-text-secondary bg-bg-secondary',
};

function NodeBadge({ node, onClick }: { node: WorldNode; onClick?: () => void }) {
  const Icon = NODE_ICONS[node.type];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="focus-ring flex w-full items-center gap-2 rounded-xl border border-border p-2 text-left hover:bg-bg-secondary disabled:hover:bg-transparent"
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${NODE_COLORS[node.type]}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">{node.label}</span>
        <span className="block truncate text-xs text-text-secondary">
          {NODE_TYPE_LABELS[node.type]}{node.subtitle ? ` · ${node.subtitle}` : ''}
        </span>
      </span>
    </button>
  );
}

function NodePicker({ model, onSelect, placeholder }: { model: WorldModel; onSelect: (n: WorldNode) => void; placeholder: string }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    if (q.trim().length < 2) return [];
    const lower = q.toLowerCase();
    return model.nodes.filter((n) => n.label.toLowerCase().includes(lower)).slice(0, 8);
  }, [q, model]);
  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <input className={`${inputClass} pl-9`} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {matches.length > 0 && (
        <div className="absolute z-10 mt-1 w-full space-y-1 rounded-xl border border-border bg-bg-primary p-1.5 shadow-lg">
          {matches.map((n) => (
            <NodeBadge
              key={n.key}
              node={n}
              onClick={() => {
                onSelect(n);
                setQ('');
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// WORLD GRAPH TAB
// ============================================================

function WorldGraphTab({ model }: { model: WorldModel }) {
  const [typeFilter, setTypeFilter] = useState<NodeType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const filteredNodes = useMemo(() => {
    let list = model.nodes;
    if (typeFilter !== 'all') list = list.filter((n) => n.type === typeFilter);
    if (search.trim()) {
      const lower = search.toLowerCase();
      list = list.filter((n) => n.label.toLowerCase().includes(lower));
    }
    return list.slice(0, 60);
  }, [model, typeFilter, search]);

  const selected = selectedKey ? model.nodesByKey.get(selectedKey) : null;
  const { edges: neighborEdges } = selected ? subgraph(model, selected.key, 1) : { nodes: [], edges: [] };
  const connections = selected
    ? neighborEdges
        .map((e) => {
          const otherKey = e.source === selected.key ? e.target : e.source;
          const other = model.nodesByKey.get(otherKey);
          const outgoing = e.source === selected.key;
          return other ? { other, relation: e.relation, at: e.at, outgoing } : null;
        })
        .filter((c): c is { other: WorldNode; relation: string; at: string | null; outgoing: boolean } => !!c)
        .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    : [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTypeFilter('all')}
            className={`focus-ring rounded-lg px-2.5 py-1 text-xs font-medium ${typeFilter === 'all' ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:bg-bg-secondary'}`}
          >
            All ({model.nodes.length})
          </button>
          {NODE_TYPE_ORDER.map((t) => {
            const count = model.nodes.filter((n) => n.type === t).length;
            if (count === 0) return null;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`focus-ring rounded-lg px-2.5 py-1 text-xs font-medium ${typeFilter === t ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:bg-bg-secondary'}`}
              >
                {NODE_TYPE_LABELS[t]} ({count})
              </button>
            );
          })}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input className={`${inputClass} pl-9`} placeholder="Search nodes..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
          {filteredNodes.map((n) => (
            <NodeBadge key={n.key} node={n} onClick={() => setSelectedKey(n.key)} />
          ))}
          {filteredNodes.length === 0 && <p className="p-3 text-xs text-text-secondary">No matching nodes.</p>}
        </div>
      </div>

      <div className="rounded-2xl border border-border p-4">
        {!selected ? (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm text-text-secondary">
            <Network className="mb-2 h-8 w-8 opacity-40" />
            Pick a node on the left to see everything it's connected to — customers, properties, jobs, technicians, and when each link happened.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 border-b border-border pb-3">
              <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${NODE_COLORS[selected.type]}`}>
                {(() => { const Icon = NODE_ICONS[selected.type]; return <Icon className="h-5 w-5" />; })()}
              </span>
              <div>
                <p className="font-semibold text-text-primary">{selected.label}</p>
                <p className="text-xs text-text-secondary">
                  {NODE_TYPE_LABELS[selected.type]}{selected.subtitle ? ` · ${selected.subtitle}` : ''}
                  {selected.at ? ` · ${new Date(selected.at).toLocaleDateString()}` : ''}
                </p>
              </div>
            </div>

            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <Clock className="h-3.5 w-3.5" /> Connections, most recent first
              </h4>
              {connections.length === 0 && <p className="text-xs text-text-secondary">No connections found yet.</p>}
              <div className="space-y-1.5">
                {connections.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-xl border border-border p-2 text-sm">
                    {c.outgoing ? (
                      <span className="text-xs text-text-secondary">{EDGE_RELATION_LABELS[c.relation as keyof typeof EDGE_RELATION_LABELS]}</span>
                    ) : (
                      <span className="text-xs text-text-secondary">&larr; {EDGE_RELATION_LABELS[c.relation as keyof typeof EDGE_RELATION_LABELS]}</span>
                    )}
                    <ArrowRight className="h-3 w-3 shrink-0 text-text-secondary/50" />
                    <button onClick={() => setSelectedKey(c.other.key)} className="focus-ring flex-1 truncate text-left text-text-primary hover:underline">
                      {c.other.label}
                    </button>
                    {c.at && <span className="shrink-0 text-xs text-text-secondary">{new Date(c.at).toLocaleDateString()}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// CAUSAL GRAPH TAB
// ============================================================

function CausalGraphTab({
  model,
  edges,
  candidates,
  onChanged,
}: {
  model: WorldModel;
  edges: CausalEdge[];
  candidates: CausalCandidate[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [cause, setCause] = useState<WorldNode | null>(null);
  const [effect, setEffect] = useState<WorldNode | null>(null);
  const [relationship, setRelationship] = useState<CausalRelationship>('contributes_to');
  const [strength, setStrength] = useState(0.5);
  const [notes, setNotes] = useState('');
  const [savingManual, setSavingManual] = useState(false);

  const visibleCandidates = candidates.filter((c) => !dismissed.has(`${c.ruleKey}:${c.cause.id}:${c.effect.id}`));

  const handleConfirm = async (c: CausalCandidate) => {
    const key = `${c.ruleKey}:${c.cause.id}:${c.effect.id}`;
    setBusyKey(key);
    try {
      await confirmCandidate(c);
      setDismissed((prev) => new Set(prev).add(key));
      onChanged();
      toast('Causal link confirmed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to confirm', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDismiss = (c: CausalCandidate) => {
    setDismissed((prev) => new Set(prev).add(`${c.ruleKey}:${c.cause.id}:${c.effect.id}`));
  };

  const handleSaveManual = async () => {
    if (!cause || !effect) return toast('Pick both a cause and an effect', 'error');
    setSavingManual(true);
    try {
      await saveCausalEdge({ cause, effect, relationship, strength, confidence: 'low', notes, detectedBy: 'manual' });
      setCause(null);
      setEffect(null);
      setNotes('');
      onChanged();
      toast('Causal link saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    } finally {
      setSavingManual(false);
    }
  };

  return (
    <div className="space-y-6">
      {visibleCandidates.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            <Sparkles className="h-3.5 w-3.5" /> Detected candidates — review before they count
          </h3>
          {visibleCandidates.map((c) => {
            const key = `${c.ruleKey}:${c.cause.id}:${c.effect.id}`;
            return (
              <motion.div key={key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{c.ruleLabel}</span>
                <span className="text-text-primary">{c.cause.label}</span>
                <ArrowRight className="h-3.5 w-3.5 text-text-secondary" />
                <span className="text-text-primary">{c.effect.label}</span>
                <span className="text-xs text-text-secondary">({c.confidence} confidence)</span>
                <div className="ml-auto flex gap-1.5">
                  <button
                    onClick={() => handleConfirm(c)}
                    disabled={busyKey === key}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                  >
                    {busyKey === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Confirm
                  </button>
                  <button onClick={() => handleDismiss(c)} className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-secondary">
                    Dismiss
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-bg-secondary/40 p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Draw a causal link by hand</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <span className="mb-1 block text-[11px] text-text-secondary">Cause</span>
            {cause ? (
              <div className="flex items-center justify-between rounded-xl border border-border p-2 text-sm text-text-primary">
                {cause.label}
                <button onClick={() => setCause(null)} className="focus-ring text-text-secondary hover:text-danger"><X className="h-3.5 w-3.5" /></button>
              </div>
            ) : (
              <NodePicker model={model} onSelect={setCause} placeholder="Search for a cause..." />
            )}
          </div>
          <div>
            <span className="mb-1 block text-[11px] text-text-secondary">Effect</span>
            {effect ? (
              <div className="flex items-center justify-between rounded-xl border border-border p-2 text-sm text-text-primary">
                {effect.label}
                <button onClick={() => setEffect(null)} className="focus-ring text-text-secondary hover:text-danger"><X className="h-3.5 w-3.5" /></button>
              </div>
            ) : (
              <NodePicker model={model} onSelect={setEffect} placeholder="Search for an effect..." />
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <select className={inputClass} value={relationship} onChange={(e) => setRelationship(e.target.value as CausalRelationship)}>
            {(Object.keys(RELATIONSHIP_LABELS) as CausalRelationship[]).map((r) => (
              <option key={r} value={r}>{RELATIONSHIP_LABELS[r]}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Strength
            <input type="range" min={-1} max={1} step={0.1} value={strength} onChange={(e) => setStrength(Number(e.target.value))} className="flex-1" />
            <span className="w-10 text-right font-mono">{strength.toFixed(1)}</span>
          </label>
          <input className={inputClass} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button
          onClick={handleSaveManual}
          disabled={savingManual}
          className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {savingManual ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add causal link
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Confirmed causal graph ({edges.length})</h3>
        {edges.length === 0 && <p className="rounded-xl border border-dashed border-border p-3 text-xs text-text-secondary">No causal links yet.</p>}
        {edges.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
            <span className="text-text-primary">{e.cause_label}</span>
            <span className="text-xs text-text-secondary">{RELATIONSHIP_LABELS[e.relationship]}</span>
            <ArrowRight className="h-3.5 w-3.5 text-text-secondary" />
            <span className="text-text-primary">{e.effect_label}</span>
            <span className="text-xs text-text-secondary">
              · {e.detected_by === 'rule' ? 'detected' : 'manual'} · {e.confidence} confidence
            </span>
            <button
              onClick={async () => { await deleteCausalEdge(e.id); onChanged(); }}
              className="focus-ring ml-auto rounded-lg p-1.5 text-text-secondary hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function BusinessWorldModelPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<'graph' | 'causal'>('graph');
  const [model, setModel] = useState<WorldModel | null>(null);
  const [causalEdges, setCausalEdges] = useState<CausalEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [m, edges] = await Promise.all([buildWorldModel(), fetchCausalEdges()]);
      setModel(m);
      setCausalEdges(edges);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to build the world model', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const candidates = useMemo(() => (model ? detectCausalCandidates(model, causalEdges) : []), [model, causalEdges]);

  if (loading || !model) {
    return (
      <DashboardLayout>
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-accent/10 p-2.5"><Network className="h-6 w-6 text-accent" /></div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">Business World Model</h1>
              <p className="text-sm text-text-secondary">
                One live graph of your customers, properties, assets, jobs, technicians, invoices, communications
                and events — with what caused what, layered on top.
              </p>
            </div>
          </div>
          <button onClick={refresh} disabled={refreshing} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-60">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />} Refresh
          </button>
        </div>

        <div className="flex gap-1.5 border-b border-border">
          <button
            onClick={() => setTab('graph')}
            className={`focus-ring flex items-center gap-1.5 rounded-t-xl px-4 py-2 text-sm font-medium ${tab === 'graph' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <Network className="h-4 w-4" /> World Graph
          </button>
          <button
            onClick={() => setTab('causal')}
            className={`focus-ring flex items-center gap-1.5 rounded-t-xl px-4 py-2 text-sm font-medium ${tab === 'causal' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            <GitBranch className="h-4 w-4" /> Causal Graph
            {candidates.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">{candidates.length}</span>}
          </button>
        </div>

        {tab === 'graph' ? (
          <WorldGraphTab model={model} />
        ) : (
          <CausalGraphTab model={model} edges={causalEdges} candidates={candidates} onChanged={load} />
        )}
      </div>
    </DashboardLayout>
  );
}
