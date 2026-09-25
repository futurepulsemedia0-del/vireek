/**
 * Execution Reliability Score — /dashboard/execution-reliability
 *
 * Scores every Agent, Workflow, and Integration on this account by how
 * dependable its executions actually are: success rate, rollback rate,
 * manual-override rate, latency against a per-type SLA, and net business
 * impact. Raw events come from `execution_reliability_events`
 * (src/lib/executionReliability.ts); the composite score is computed
 * client-side so the weighting can change without a migration.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Gauge, RotateCcw, ShieldAlert, Timer, TrendingDown, TrendingUp } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchExecutionReliabilityScores,
  type ExecutionEntityType,
  type ExecutionReliabilityScore,
  type ReliabilityTier,
} from '@/lib/executionReliability';

const PERIOD_OPTIONS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

const ENTITY_LABELS: Record<ExecutionEntityType, string> = {
  agent: 'Agents',
  workflow: 'Workflows',
  integration: 'Integrations',
};

const TIER_STYLES: Record<ReliabilityTier, string> = {
  excellent: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25',
  good: 'bg-accent/10 text-accent border-accent/25',
  at_risk: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  critical: 'bg-red-500/10 text-red-600 border-red-500/25',
};

const TIER_LABELS: Record<ReliabilityTier, string> = {
  excellent: 'Excellent',
  good: 'Good',
  at_risk: 'At risk',
  critical: 'Critical',
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatImpact(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars > 0 ? '+' : '';
  return `${sign}$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ScoreRing({ score, tier }: { score: number; tier: ReliabilityTier }) {
  const colorClass =
    tier === 'excellent' ? 'text-emerald-500' : tier === 'good' ? 'text-accent' : tier === 'at_risk' ? 'text-amber-500' : 'text-red-500';
  const circumference = 2 * Math.PI * 26;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r="26" fill="none" strokeWidth="6" className="stroke-border" />
        <circle
          cx="32" cy="32" r="26" fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} className={colorClass} stroke="currentColor"
        />
      </svg>
      <span className="absolute text-sm font-bold text-text-primary">{score}</span>
    </div>
  );
}

function ScoreCard({ row }: { row: ExecutionReliabilityScore }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <ScoreRing score={row.score} tier={row.tier} />
          <div>
            <p className="text-sm font-semibold text-text-primary">{row.entityLabel}</p>
            <p className="text-xs text-text-secondary">{ENTITY_LABELS[row.entityType]} · {row.totalRuns} runs</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${TIER_STYLES[row.tier]}`}>
          {TIER_LABELS[row.tier]}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-3 sm:grid-cols-4">
        <div>
          <p className="flex items-center gap-1 text-[11px] text-text-secondary"><TrendingUp size={11} /> Success</p>
          <p className="text-sm font-semibold text-text-primary">{pct(row.successRate)}</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] text-text-secondary"><RotateCcw size={11} /> Rollback</p>
          <p className="text-sm font-semibold text-text-primary">{pct(row.rollbackRate)}</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] text-text-secondary"><ShieldAlert size={11} /> Override</p>
          <p className="text-sm font-semibold text-text-primary">{pct(row.overrideRate)}</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] text-text-secondary"><Timer size={11} /> Avg latency</p>
          <p className="text-sm font-semibold text-text-primary">{formatLatency(row.avgLatencyMs)}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          {row.businessImpactCents >= 0 ? <TrendingUp size={12} className="text-emerald-500" /> : <TrendingDown size={12} className="text-red-500" />}
          Business impact: <span className="font-medium text-text-primary">{formatImpact(row.businessImpactCents)}</span>
        </span>
        {row.lastEventAt && <span>Last run {new Date(row.lastEventAt).toLocaleString()}</span>}
      </div>
    </motion.div>
  );
}

export function ExecutionReliabilityPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<ExecutionReliabilityScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(30);
  const [filterType, setFilterType] = useState<ExecutionEntityType | 'all'>('all');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setRows(await fetchExecutionReliabilityScores(windowDays));
    } catch {
      toast('Could not load execution reliability scores', 'error');
    }
    setLoading(false);
  }, [user, windowDays, toast]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(
    () => (filterType === 'all' ? rows : rows.filter((r) => r.entityType === filterType)),
    [rows, filterType],
  );
  const criticalCount = rows.filter((r) => r.tier === 'critical').length;

  return (
    <DashboardLayout activeLabel="Execution Reliability">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Gauge size={22} className="text-accent" /> Execution Reliability Score
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              How much you can trust each Agent, Workflow, and Integration to run without a rollback, an override, or
              a slow, failed, or costly execution.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={filterType} onChange={(e) => setFilterType(e.target.value as ExecutionEntityType | 'all')}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
              <option value="all">All types</option>
              <option value="agent">Agents</option>
              <option value="workflow">Workflows</option>
              <option value="integration">Integrations</option>
            </select>
            <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
              {PERIOD_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {criticalCount > 0 && !loading && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-red-500/25 bg-red-500/5 px-4 py-3">
            <AlertTriangle size={18} className="shrink-0 text-red-500" />
            <p className="text-sm text-text-primary">
              <span className="font-semibold">{criticalCount}</span> {criticalCount === 1 ? 'item is' : 'items are'} in the critical range and need attention.
            </p>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Gauge className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No execution events logged for this period yet. Scores appear once agents, workflows, or integrations
              start reporting runs via logExecutionEvent().
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filtered.map((row) => <ScoreCard key={`${row.entityType}-${row.entityKey}`} row={row} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
