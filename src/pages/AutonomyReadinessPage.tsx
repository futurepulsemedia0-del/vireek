import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, RefreshCw, ChevronDown, ChevronUp, Zap, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  fetchAgentAutonomyReadiness,
  captureAgentAutonomySnapshot,
  summarizeReadiness,
  formatPercent,
  AUTONOMY_TIER_LABELS,
  AUTONOMY_TIER_COLORS,
  AUTONOMY_TIER_ORDER,
  type AgentAutonomyReadiness,
  type AutonomyTier,
} from '@/lib/autonomyReadiness';

function TierBadge({ tier }: { tier: AutonomyTier }) {
  const c = AUTONOMY_TIER_COLORS[tier];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${c.bg} ${c.text} ${c.ring}`}>
      {AUTONOMY_TIER_LABELS[tier]}
    </span>
  );
}

function ScoreBar({ score, tier }: { score: number; tier: AutonomyTier }) {
  const barColor =
    tier === 'autonomous' ? 'bg-emerald-500' : tier === 'execute' ? 'bg-blue-500' : tier === 'recommend' ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-bg-secondary">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-semibold text-text-primary">{score}</span>
    </div>
  );
}

function ReadinessRow({ row }: { row: AgentAutonomyReadiness }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-primary last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-bg-secondary/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-text-primary">{row.label}</p>
            <TierBadge tier={row.tier} />
            {!row.enabled && (
              <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
                <ShieldAlert size={12} /> disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">
            {row.agent_source} &middot; {row.category} &middot; {row.total_actions_30d} actions / 30d
          </p>
        </div>
        <ScoreBar score={row.score} tier={row.tier} />
        {open ? <ChevronUp size={16} className="text-text-secondary" /> : <ChevronDown size={16} className="text-text-secondary" />}
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border-primary bg-bg-secondary/40 px-4 py-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-text-primary">Last 30 days</p>
            <ul className="mt-1 space-y-0.5 text-xs text-text-secondary">
              <li>Executed: {row.executed_30d}</li>
              <li>Failed: {row.failed_30d}</li>
              <li>Rejected: {row.rejected_30d}</li>
              <li>Rolled back: {row.rolled_back_30d}</li>
              <li>Failure rate: {formatPercent(row.failure_rate)}</li>
              <li>Override rate: {formatPercent(row.override_rate)}</li>
              <li>Days since last incident: {row.days_since_last_incident ?? 'never'}</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-primary">
              {row.tier === 'autonomous' ? 'Holding Autonomous' : 'Blocking next tier'}
            </p>
            {row.blockers.length === 0 ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-emerald-600">
                <Zap size={12} /> No blockers — fully qualified.
              </p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs text-text-secondary">
                {row.blockers.map((b) => (
                  <li key={b}>&bull; {b}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AutonomyReadinessPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<AgentAutonomyReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tierFilter, setTierFilter] = useState<AutonomyTier | 'all'>('all');

  const load = useCallback(async () => {
    try {
      const data = await fetchAgentAutonomyReadiness();
      setRows(data);
    } catch {
      toast('Could not load autonomy readiness scores.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await captureAgentAutonomySnapshot();
      await load();
      toast('Readiness scores refreshed.', 'success');
    } catch {
      toast('Could not refresh scores.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const summary = useMemo(() => summarizeReadiness(rows), [rows]);
  const filteredRows = tierFilter === 'all' ? rows : rows.filter((r) => r.tier === tierFilter);

  if (loading) {
    return (
      <DashboardLayout activeLabel="Autonomy Readiness">
        <p className="text-sm text-text-secondary">Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Autonomy Readiness">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Gauge size={22} /> Autonomy Readiness Score
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            How ready is each autonomous action type to move from Observe and Recommend to Execute and fully
            Autonomous — scored from real volume, failure rate and human-override history, not opinion.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-50"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Snapshot now
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No governed actions yet"
          description="Autonomy Readiness scores every action type in agent_action_catalog once it has activity in agent_action_log."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Card className="p-4">
              <p className="text-xs text-text-secondary">Average score</p>
              <p className="mt-1 text-2xl font-bold text-text-primary">{summary.averageScore}</p>
            </Card>
            {AUTONOMY_TIER_ORDER.map((t) => (
              <button key={t} type="button" onClick={() => setTierFilter(tierFilter === t ? 'all' : t)}>
                <Card className={`p-4 text-left transition ${tierFilter === t ? 'ring-2 ring-inset ring-brand-500' : ''}`}>
                  <p className="text-xs text-text-secondary">{AUTONOMY_TIER_LABELS[t]}</p>
                  <p className="mt-1 text-2xl font-bold text-text-primary">{summary.counts[t]}</p>
                </Card>
              </button>
            ))}
          </div>

          <Card className="overflow-hidden p-0">
            {filteredRows.map((row) => (
              <ReadinessRow key={row.action_slug} row={row} />
            ))}
          </Card>
        </>
      )}
    </DashboardLayout>
  );
}
