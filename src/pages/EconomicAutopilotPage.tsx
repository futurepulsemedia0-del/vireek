/**
 * Economic Autopilot — /dashboard/economic-autopilot
 * Reads revenue/cost/margin/capacity/cash signals, scores economic health,
 * and turns threshold breaches into concrete, dollar-quantified, owner-
 * approved actions. Rules and thresholds live in the migration, in one
 * place, so they can be read top to bottom — nothing here is a black box.
 */

import { useCallback, useEffect, useState } from 'react';
import { Rocket, Loader2, RefreshCw, Plus, Check, X, ClipboardCheck, Gauge } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  CATEGORY_LABELS,
  SIGNAL_LABELS,
  decideAction,
  fetchActions,
  fetchSnapshots,
  formatCents,
  logSignal,
  markImplemented,
  runAutopilot,
  type ActionCategory,
  type EconomicAction,
  type EconomicSnapshot,
  type SignalType,
} from '@/lib/economicAutopilot';

const SIGNAL_TYPES = Object.keys(SIGNAL_LABELS) as SignalType[];
const URGENCY_COLOR: Record<string, string> = { high: 'text-error-500', medium: 'text-warning-500', low: 'text-text-secondary' };

function HealthGauge({ score }: { score: number | null }) {
  const s = score ?? 0;
  const color = s >= 70 ? 'text-success-500' : s >= 45 ? 'text-warning-500' : 'text-error-500';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-4">
      <Gauge className={color} size={28} />
      <div>
        <p className={`text-2xl font-semibold ${color}`}>{score ?? '—'}<span className="text-sm text-text-secondary">/100</span></p>
        <p className="text-xs text-text-secondary">Economic health score</p>
      </div>
    </div>
  );
}

export function EconomicAutopilotPage() {
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState<EconomicSnapshot[]>([]);
  const [actions, setActions] = useState<EconomicAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const [sigType, setSigType] = useState<SignalType>('revenue_cents');
  const [sigValue, setSigValue] = useState('');
  const [sigSaving, setSigSaving] = useState(false);

  const latest = snapshots[0];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snaps, pending, approved] = await Promise.all([fetchSnapshots(), fetchActions('pending'), fetchActions('approved')]);
      setSnapshots(snaps);
      setActions([...pending, ...approved]);
    } catch {
      toast('Could not load the economic autopilot.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await runAutopilot();
      toast(
        res.actions_created > 0
          ? `Health score ${res.health_score}/100 — ${res.actions_created} new action(s) recommended.`
          : `Health score ${res.health_score}/100 — nothing crossed a threshold this run.`,
        'success',
      );
      void load();
    } catch {
      toast('Could not run the autopilot.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleLogSignal = async () => {
    if (sigValue.trim() === '') {
      toast('Enter a value for this signal.', 'error');
      return;
    }
    setSigSaving(true);
    try {
      const today = new Date();
      const periodStart = new Date(today);
      periodStart.setDate(periodStart.getDate() - 30);
      await logSignal({
        signal_type: sigType,
        value: Number(sigValue),
        period_start: periodStart.toISOString().slice(0, 10),
        period_end: today.toISOString().slice(0, 10),
      });
      setSigValue('');
      toast('Signal logged.', 'success');
      void load();
    } catch {
      toast('Could not log this signal.', 'error');
    } finally {
      setSigSaving(false);
    }
  };

  const handleDecide = async (action: EconomicAction, decision: 'approved' | 'dismissed') => {
    let reason: string | null = '';
    if (decision === 'dismissed') {
      reason = window.prompt('Reason for dismissing this action (required):');
      if (!reason) return;
    }
    try {
      await decideAction(action.id, decision, reason || undefined);
      toast(decision === 'approved' ? 'Action approved — queued to implement.' : 'Action dismissed.', 'success');
      void load();
    } catch {
      toast('Could not record this decision.', 'error');
    }
  };

  const handleImplemented = async (action: EconomicAction) => {
    const raw = window.prompt('Realized impact in dollars (optional, leave blank to skip):');
    const cents = raw && raw.trim() !== '' ? Math.round(Number(raw) * 100) : undefined;
    try {
      await markImplemented(action.id, cents);
      toast('Marked implemented.', 'success');
      void load();
    } catch {
      toast('Could not update this action.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Economic Autopilot"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Economic Autopilot">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Rocket className="text-cta" size={20} />
            <div>
              <p className="text-sm font-semibold text-text-primary">Economic Autopilot</p>
              <p className="text-xs text-text-secondary">Revenue, cost, capacity, margin and cash — scored, and turned into owner-approved actions.</p>
            </div>
          </div>
          <button onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Run autopilot
          </button>
        </div>

        {/* Snapshot */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Latest snapshot</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <HealthGauge score={latest?.health_score ?? null} />
            <div className="rounded-xl border border-border bg-bg-primary p-4"><p className="text-lg font-semibold text-text-primary">{latest?.margin_pct != null ? `${latest.margin_pct}%` : '—'}</p><p className="text-xs text-text-secondary">Margin</p></div>
            <div className="rounded-xl border border-border bg-bg-primary p-4"><p className="text-lg font-semibold text-text-primary">{latest?.capacity_utilization_pct != null ? `${latest.capacity_utilization_pct}%` : '—'}</p><p className="text-xs text-text-secondary">Capacity utilization</p></div>
            <div className="rounded-xl border border-border bg-bg-primary p-4"><p className="text-lg font-semibold text-text-primary">{latest?.cash_runway_days != null ? `${latest.cash_runway_days}d` : '—'}</p><p className="text-xs text-text-secondary">Cash runway</p></div>
            <div className="rounded-xl border border-border bg-bg-primary p-4"><p className="text-lg font-semibold text-text-primary">{formatCents(latest?.overdue_receivables_cents)}</p><p className="text-xs text-text-secondary">Overdue receivables</p></div>
          </div>
          {latest && <p className="mt-3 text-[11px] text-text-secondary">{latest.notes} · computed {new Date(latest.computed_at).toLocaleString()}</p>}
        </div>

        {/* Log a signal */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Log a signal (last 30 days)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <select className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" value={sigType} onChange={(e) => setSigType(e.target.value as SignalType)}>
              {SIGNAL_TYPES.map((t) => <option key={t} value={t}>{SIGNAL_LABELS[t]}</option>)}
            </select>
            <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Value" value={sigValue} onChange={(e) => setSigValue(e.target.value)} />
            <button onClick={handleLogSignal} disabled={sigSaving} className="focus-ring flex items-center justify-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {sigSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Log signal
            </button>
          </div>
          <p className="mt-2 text-[11px] text-text-secondary">Cents for money fields (revenue, cost, receivables, spend); plain numbers for margin %, capacity %, and runway days.</p>
        </div>

        {/* Actions */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Recommended actions ({actions.length})</p>
          {actions.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing pending — run the autopilot after logging enough signals.</p>
          ) : (
            <div className="space-y-2">
              {actions.map((a) => (
                <div key={a.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text-primary">
                        {a.title}
                        <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-secondary">{CATEGORY_LABELS[a.category as ActionCategory]}</span>
                        <span className={`ml-2 text-[10px] font-semibold uppercase ${URGENCY_COLOR[a.urgency]}`}>{a.urgency}</span>
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">{a.rationale}</p>
                      {a.estimated_impact_cents > 0 && <p className="mt-1 text-[11px] text-text-secondary">Estimated impact: <span className="font-medium text-text-primary">{formatCents(a.estimated_impact_cents)}</span></p>}
                      {a.status === 'implemented' && <p className="mt-1 text-[11px] text-success-500">Implemented · realized {formatCents(a.realized_impact_cents)}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {a.status === 'pending' && (
                        <>
                          <button onClick={() => handleDecide(a, 'approved')} className="focus-ring flex items-center gap-1 rounded-lg bg-success-500/15 px-3 py-1.5 text-xs font-medium text-success-500"><Check size={14} /> Approve</button>
                          <button onClick={() => handleDecide(a, 'dismissed')} className="focus-ring flex items-center gap-1 rounded-lg bg-error-500/15 px-3 py-1.5 text-xs font-medium text-error-500"><X size={14} /> Dismiss</button>
                        </>
                      )}
                      {a.status === 'approved' && (
                        <button onClick={() => handleImplemented(a)} className="focus-ring flex items-center gap-1 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary"><ClipboardCheck size={14} /> Mark implemented</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Snapshot history */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Snapshot history</p>
          {snapshots.length === 0 ? (
            <p className="text-sm text-text-secondary">No snapshots yet.</p>
          ) : (
            <div className="space-y-2">
              {snapshots.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span className="text-text-primary">Score {s.health_score ?? '—'}/100 · {s.signals_used} signal(s)</span>
                  <span className="text-xs text-text-secondary">{new Date(s.computed_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
