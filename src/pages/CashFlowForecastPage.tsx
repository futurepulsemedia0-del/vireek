import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, ArrowLeft, PiggyBank, Plus, Trash2, Settings as SettingsIcon, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, CashFlowSettings, CashFlowFixedExpense, CashFlowSnapshot, CashFlowWeekBucket } from '@/lib/supabase';

function money(n: number) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function ForecastChart({ weeks }: { weeks: CashFlowWeekBucket[] }) {
  const w = 700, h = 220, padding = { top: 20, right: 16, bottom: 24, left: 56 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const values = weeks.flatMap((wk) => [wk.projected_balance_committed, wk.projected_balance_optimistic]);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const xScale = (i: number) => padding.left + (i / (weeks.length - 1)) * plotW;
  const yScale = (v: number) => padding.top + plotH - ((v - min) / (max - min)) * plotH;
  const zeroY = yScale(0);

  const linePath = (key: 'projected_balance_committed' | 'projected_balance_optimistic') =>
    weeks.map((wk, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(wk[key])}`).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
      <line x1={padding.left} y1={zeroY} x2={w - padding.right} y2={zeroY} stroke="rgb(var(--border))" strokeDasharray="4 4" />
      <path d={linePath('projected_balance_optimistic')} fill="none" stroke="rgb(var(--accent))" strokeOpacity={0.4} strokeWidth={2} strokeDasharray="5 4" />
      <path d={linePath('projected_balance_committed')} fill="none" stroke="rgb(var(--accent))" strokeWidth={2.5} />
      {weeks.map((wk, i) => (
        <circle key={wk.week_index} cx={xScale(i)} cy={yScale(wk.projected_balance_committed)} r={wk.projected_balance_committed < 0 ? 4 : 3} fill={wk.projected_balance_committed < 0 ? 'rgb(var(--danger))' : 'rgb(var(--accent))'} />
      ))}
      <text x={padding.left} y={h - 4} fontSize="10" fill="rgb(var(--text-secondary))">This week</text>
      <text x={w - padding.right} y={h - 4} fontSize="10" textAnchor="end" fill="rgb(var(--text-secondary))">Week 13</text>
    </svg>
  );
}

export function CashFlowForecastPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<CashFlowSnapshot | null>(null);
  const [expenses, setExpenses] = useState<CashFlowFixedExpense[]>([]);
  const [settings, setSettings] = useState<CashFlowSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [newExpense, setNewExpense] = useState({ name: '', amount: '', frequency: 'monthly' as CashFlowFixedExpense['frequency'], next_due_date: '' });

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: snap }, { data: exp }, { data: s }] = await Promise.all([
      supabase.from('cash_flow_snapshots').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cash_flow_fixed_expenses').select('*').eq('user_id', user.id).eq('active', true).order('next_due_date'),
      supabase.from('cash_flow_settings').select('*').eq('user_id', user.id).maybeSingle(),
    ]);
    setSnapshot(snap as CashFlowSnapshot | null);
    setExpenses((exp ?? []) as CashFlowFixedExpense[]);
    setSettings(s as CashFlowSettings | null);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke('cash-flow-forecast', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (error) throw error;
      setSnapshot(data?.snapshot ?? null);
      toast('Forecast updated.', 'success');
    } catch {
      toast('Could not run the forecast. Please try again.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleAddExpense = async () => {
    if (!user || !newExpense.name || !newExpense.amount || !newExpense.next_due_date) return;
    const { error } = await supabase.from('cash_flow_fixed_expenses').insert({
      user_id: user.id,
      name: newExpense.name,
      amount: Number(newExpense.amount),
      frequency: newExpense.frequency,
      next_due_date: newExpense.next_due_date,
    });
    if (error) { toast('Could not add expense.', 'error'); return; }
    setNewExpense({ name: '', amount: '', frequency: 'monthly', next_due_date: '' });
    load();
  };

  const handleRemoveExpense = async (id: string) => {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    const { error } = await supabase.from('cash_flow_fixed_expenses').update({ active: false }).eq('id', id);
    if (error) { toast('Could not remove expense.', 'error'); load(); }
  };

  const handleSettingChange = async (patch: Partial<CashFlowSettings>) => {
    if (!user || !settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const { error } = await supabase.from('cash_flow_settings').update(patch).eq('user_id', user.id);
    if (error) { toast('Could not save settings.', 'error'); load(); }
  };

  const weeks = snapshot?.weeks ?? [];
  const worstWeek = weeks.reduce((min, w) => (w.projected_balance_committed < (min?.projected_balance_committed ?? Infinity) ? w : min), null as CashFlowWeekBucket | null);

  return (
    <DashboardLayout activeLabel="Cash Flow Forecast">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <PiggyBank size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Cash Flow Forecast</h1>
            <p className="text-sm text-text-secondary">A rolling 13-week projection built from your real jobs, payments, memberships and quotes.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowSettings((s) => !s)} className="focus-ring flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-bg-secondary">
            <SettingsIcon size={16} /> Assumptions
          </button>
          <button onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
            <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> Run Forecast
          </button>
        </div>
      </div>

      {showSettings && settings && (
        <div className="mb-6 space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Current cash balance</span>
            <input type="number" value={settings.starting_cash_balance} onChange={(e) => handleSettingChange({ starting_cash_balance: Number(e.target.value) })} className="w-32 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm" />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Default cost ratio ({settings.default_cost_ratio}%) — used only when we don't have real job-cost data</span>
            <input type="range" min={20} max={90} step={5} value={settings.default_cost_ratio} onChange={(e) => handleSettingChange({ default_cost_ratio: Number(e.target.value) })} className="w-40 accent-accent" />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Quote win rate ({settings.quote_win_rate}%)</span>
            <input type="range" min={5} max={75} step={5} value={settings.quote_win_rate} onChange={(e) => handleSettingChange({ quote_win_rate: Number(e.target.value) })} className="w-40 accent-accent" />
          </label>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : !snapshot ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">No forecast yet — click "Run Forecast" to generate one.</p>
      ) : (
        <div className="space-y-6">
          {worstWeek && worstWeek.projected_balance_committed < 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-l-4 border-l-danger bg-danger/10 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={20} />
              <p className="text-sm text-text-primary">
                Projected cash goes negative ({money(worstWeek.projected_balance_committed)}) in the week of {worstWeek.week_start}. Review the pending decisions/collections below.
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-accent" /> Committed</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-accent opacity-40" style={{ borderTop: '2px dashed' }} /> Optimistic (with pipeline)</span>
            </div>
            <ForecastChart weeks={weeks} />
          </div>

          {snapshot.narrative.length > 0 && (
            <div className="space-y-2">
              {snapshot.narrative.map((f, i) => (
                <div key={i} className={`rounded-xl border-l-4 p-3 text-sm ${f.severity === 'critical' ? 'border-l-danger bg-danger/10' : f.severity === 'warning' ? 'border-l-amber-500 bg-amber-500/10' : 'border-l-blue-500 bg-blue-500/10'}`}>
                  {f.message}
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-secondary text-left text-xs uppercase text-text-secondary">
                <tr>
                  <th className="p-3">Week</th>
                  <th className="p-3">Inflow</th>
                  <th className="p-3">Fixed</th>
                  <th className="p-3">Variable</th>
                  <th className="p-3">Net</th>
                  <th className="p-3">Balance</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.week_index} className="border-t border-border">
                    <td className="p-3 text-text-secondary">{w.week_start}</td>
                    <td className="p-3">{money(w.committed_inflow)}</td>
                    <td className="p-3">{money(w.fixed_outflow)}</td>
                    <td className="p-3">{money(w.variable_outflow)}</td>
                    <td className={`p-3 font-medium ${w.net_committed < 0 ? 'text-danger' : 'text-emerald-500'}`}>{money(w.net_committed)}</td>
                    <td className={`p-3 font-semibold ${w.projected_balance_committed < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(w.projected_balance_committed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Fixed & recurring expenses</h2>
        <div className="mb-4 space-y-2">
          {expenses.map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
              <span>{e.name} — {money(e.amount)} ({e.frequency})</span>
              <button onClick={() => handleRemoveExpense(e.id)} className="focus-ring text-text-secondary hover:text-danger"><Trash2 size={16} /></button>
            </div>
          ))}
          {expenses.length === 0 && <p className="text-sm text-text-secondary">No fixed expenses added yet — add rent, payroll, insurance, software, etc.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input placeholder="Name" value={newExpense.name} onChange={(e) => setNewExpense((s) => ({ ...s, name: e.target.value }))} className="flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <input placeholder="Amount" type="number" value={newExpense.amount} onChange={(e) => setNewExpense((s) => ({ ...s, amount: e.target.value }))} className="w-28 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <select value={newExpense.frequency} onChange={(e) => setNewExpense((s) => ({ ...s, frequency: e.target.value as CashFlowFixedExpense['frequency'] }))} className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
            <option value="one_time">One-time</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <input type="date" value={newExpense.next_due_date} onChange={(e) => setNewExpense((s) => ({ ...s, next_due_date: e.target.value }))} className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <button onClick={handleAddExpense} className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Plus size={16} /> Add
          </button>
        </div>
      </div>
    </DashboardLayout>
  );
}
