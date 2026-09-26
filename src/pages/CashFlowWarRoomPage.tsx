import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, ArrowLeft, RefreshCw, CircleCheck, X, PhoneCall, FileSignature, Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, CashFlowWarRoomPlan, CashFlowWarRoomActionLog } from '@/lib/supabase';

function money(n: number) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const SEVERITY_COPY: Record<CashFlowWarRoomPlan['severity'], { label: string; classes: string }> = {
  critical: { label: 'Critical — act today', classes: 'border-l-danger bg-danger/10 text-danger' },
  watch: { label: 'Watch — building risk', classes: 'border-l-amber-500 bg-amber-500/10 text-amber-600' },
  safe: { label: 'Safe — no near-term risk', classes: 'border-l-emerald-500 bg-emerald-500/10 text-emerald-600' },
};

const ACTION_ICON = {
  chase_invoice: PhoneCall,
  push_quote: FileSignature,
  delay_expense: Clock,
} as const;

export function CashFlowWarRoomPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [plan, setPlan] = useState<CashFlowWarRoomPlan | null>(null);
  const [statuses, setStatuses] = useState<Record<number, CashFlowWarRoomActionLog['status']>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data: latestPlan } = await supabase
      .from('cash_flow_war_room_plans')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setPlan((latestPlan as CashFlowWarRoomPlan | null) ?? null);

    if (latestPlan) {
      const { data: logRows } = await supabase
        .from('cash_flow_war_room_action_log')
        .select('*')
        .eq('plan_id', latestPlan.id);
      const map: Record<number, CashFlowWarRoomActionLog['status']> = {};
      for (const row of (logRows ?? []) as CashFlowWarRoomActionLog[]) map[row.action_index] = row.status;
      setStatuses(map);
    } else {
      setStatuses({});
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleGeneratePlan = async () => {
    setRunning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke('cash-flow-war-room', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (error) throw error;
      setPlan(data?.plan ?? null);
      setStatuses({});
      toast('Battle plan updated.', 'success');
    } catch {
      toast('Could not generate a plan. Run the Cash Flow Forecast first, then try again.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleSetStatus = async (actionIndex: number, status: CashFlowWarRoomActionLog['status']) => {
    if (!user || !plan) return;
    setStatuses((prev) => ({ ...prev, [actionIndex]: status }));
    const { error } = await supabase.from('cash_flow_war_room_action_log').upsert(
      { user_id: user.id, plan_id: plan.id, action_index: actionIndex, status, updated_at: new Date().toISOString() },
      { onConflict: 'plan_id,action_index' },
    );
    if (error) toast('Could not save that update.', 'error');
  };

  const severity = plan ? SEVERITY_COPY[plan.severity] : null;
  const openActions = plan?.actions.filter((_, i) => statuses[i] !== 'dismissed') ?? [];

  return (
    <DashboardLayout activeLabel="Cash Flow War Room">
      <button type="button" onClick={() => navigate('/dashboard/cash-flow')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to Cash Flow Forecast
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Flame size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Cash Flow War Room</h1>
            <p className="text-sm text-text-secondary">Your ranked, dollar-weighted plan to protect the account's runway.</p>
          </div>
        </div>
        <button onClick={handleGeneratePlan} disabled={running} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> {plan ? 'Refresh Battle Plan' : 'Generate Battle Plan'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : !plan ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          No battle plan yet. Click "Generate Battle Plan" — it reads your latest Cash Flow Forecast, so run that first if you haven't.
        </p>
      ) : (
        <div className="space-y-6">
          <div className={`rounded-2xl border border-l-4 p-4 ${severity?.classes}`}>
            <p className="text-sm font-semibold">{severity?.label}</p>
            <p className="mt-1 text-sm text-text-primary">
              {plan.runway_weeks === null
                ? 'Cash stays positive across the full 13-week forecast.'
                : `Projected to go negative in week ${plan.runway_weeks + 1}${plan.shortfall_amount ? ` (as low as ${money(plan.shortfall_amount)})` : ''}.`}
            </p>
          </div>

          {plan.ai_summary && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="text-sm leading-relaxed text-text-primary">{plan.ai_summary}</p>
            </div>
          )}

          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-text-primary">Ranked recovery actions</h2>
            {openActions.length === 0 && (
              <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">
                No open actions — either everything is handled or the forecast has no urgent gaps right now.
              </p>
            )}
            {plan.actions.map((action, i) => {
              const status = statuses[i] ?? 'pending';
              if (status === 'dismissed') return null;
              const Icon = ACTION_ICON[action.action_type];
              return (
                <div key={i} className={`flex items-start gap-3 rounded-xl border border-border p-4 ${status === 'done' ? 'opacity-50' : ''}`}>
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className={`text-sm font-semibold text-text-primary ${status === 'done' ? 'line-through' : ''}`}>{action.title}</p>
                      <span className="text-sm font-semibold text-accent">{money(action.impact_amount)}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{action.detail}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      onClick={() => handleSetStatus(i, status === 'done' ? 'pending' : 'done')}
                      className={`focus-ring rounded-lg border border-border p-2 hover:bg-bg-secondary ${status === 'done' ? 'bg-emerald-500/10 text-emerald-600' : 'text-text-secondary'}`}
                      title="Mark done"
                    >
                      <CircleCheck size={16} />
                    </button>
                    <button
                      onClick={() => handleSetStatus(i, 'dismissed')}
                      className="focus-ring rounded-lg border border-border p-2 text-text-secondary hover:bg-bg-secondary"
                      title="Dismiss"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
