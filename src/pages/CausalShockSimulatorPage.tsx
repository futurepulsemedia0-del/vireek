import { useCallback, useEffect, useState } from 'react';
import { Waves, Sparkles, Trash2, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  runCausalShockSimulation,
  fetchCausalShockHistory,
  deleteCausalShockSimulation,
  SHOCK_TYPE_LABELS,
  SEVERITY_COLORS,
  DOMAIN_LABELS,
  type CausalShockSimulation,
} from '@/lib/causalShockSimulator';

const EXAMPLE_PROMPTS = [
  'What happens if two technicians call in sick tomorrow?',
  'What if our payment provider goes down for 3 hours?',
  'What if a heat wave doubles HVAC demand this week?',
  'What if our main supplier is out of stock on a key part?',
];

const URGENCY_LABELS: Record<string, string> = {
  immediate: 'Immediate',
  today: 'Today',
  this_week: 'This week',
};

export function CausalShockSimulatorPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<CausalShockSimulation | null>(null);
  const [history, setHistory] = useState<CausalShockSimulation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      setHistory(await fetchCausalShockHistory());
    } catch {
      toast('Failed to load simulation history', 'error');
    } finally {
      setLoadingHistory(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadHistory();
  }, [user, loadHistory]);

  const runSimulation = useCallback(async () => {
    if (!question.trim()) {
      toast('Describe a scenario first', 'error');
      return;
    }
    setRunning(true);
    try {
      const result = await runCausalShockSimulation(question.trim());
      setCurrent(result);
      setHistory((prev) => [result, ...prev]);
    } catch {
      toast('Failed to run the simulation', 'error');
    } finally {
      setRunning(false);
    }
  }, [question, toast]);

  const removeSimulation = useCallback(
    async (id: string) => {
      try {
        await deleteCausalShockSimulation(id);
        setHistory((prev) => prev.filter((s) => s.id !== id));
        if (current?.id === id) setCurrent(null);
      } catch {
        toast('Failed to delete', 'error');
      }
    },
    [current, toast],
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Waves size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Causal Shock Simulator</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Ask "what if" once — see the domino effect on customers, SLA, cash, jobs, crew and reputation,
              plus a concrete response plan, all grounded in your real account data.
            </p>
          </div>
        </div>

        <Card className="mb-8 p-6">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What happens if two technicians call in sick tomorrow?"
            rows={3}
            className="w-full rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-primary outline-none focus:border-accent"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setQuestion(p)}
                className="rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent"
              >
                {p}
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={runSimulation} disabled={running}>
              <Sparkles size={14} />
              {running ? 'Simulating…' : 'Run simulation'}
            </Button>
          </div>
        </Card>

        {current && (
          <div className="mb-8 space-y-6">
            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {SHOCK_TYPE_LABELS[current.shock_type]}
                </h2>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${SEVERITY_COLORS[current.severity]}`}>
                  {current.severity.toUpperCase()}
                </span>
              </div>
              {current.summary && <p className="mb-5 text-sm text-text-secondary">{current.summary}</p>}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <ImpactTile label="Jobs affected" value={current.impact.jobs.jobs_affected} />
                <ImpactTile label="Crew loss" value={`${current.impact.crew.capacity_loss_pct}%`} />
                <ImpactTile label="Revenue at risk" value={`$${current.impact.cash.revenue_at_risk_usd.toLocaleString()}`} />
                <ImpactTile label="Avg delay" value={`${current.impact.sla.avg_delay_hours}h`} />
                <ImpactTile label="VIP customers hit" value={current.impact.customer.vip_customers_at_risk} />
                <ImpactTile label="VIP jobs" value={current.impact.reputation.vip_jobs_affected} />
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="mb-4 text-sm font-semibold text-text-primary">Domino chain</h3>
              <div className="space-y-4">
                {current.cascade.map((step, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                        {step.order}
                      </span>
                      {i < current.cascade.length - 1 && <span className="mt-1 h-full w-px flex-1 bg-border" />}
                    </div>
                    <div className="pb-4">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-bg-tertiary px-2 py-0.5 text-[10px] font-semibold uppercase text-text-secondary">
                          {DOMAIN_LABELS[step.domain]}
                        </span>
                        <span className="text-sm font-semibold text-text-primary">{step.headline}</span>
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">{step.detail}</p>
                    </div>
                  </div>
                ))}
                {current.cascade.length === 0 && (
                  <p className="text-sm text-text-secondary">Not enough grounded data to build a chain for this scenario yet.</p>
                )}
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="mb-4 text-sm font-semibold text-text-primary">Response plan</h3>
              <div className="space-y-2">
                {current.response_plan.map((step, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <ArrowRight size={14} className="mt-0.5 shrink-0 text-accent" />
                    <div className="flex-1">
                      <p className="text-sm text-text-primary">{step.step}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {step.owner} · {URGENCY_LABELS[step.urgency]}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        <Card className="p-6">
          <h3 className="mb-4 text-sm font-semibold text-text-primary">Past simulations</h3>
          {loadingHistory ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-text-secondary">No simulations yet.</p>
          ) : (
            <div className="space-y-2">
              {history.map((sim) => (
                <div
                  key={sim.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 hover:border-accent/50"
                >
                  <button type="button" onClick={() => setCurrent(sim)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm text-text-primary">{sim.question}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {new Date(sim.created_at).toLocaleString()} · {SHOCK_TYPE_LABELS[sim.shock_type]}
                    </p>
                  </button>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${SEVERITY_COLORS[sim.severity]}`}>
                    {sim.severity}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSimulation(sim.id)}
                    className="shrink-0 text-text-secondary hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}

function ImpactTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-bg-tertiary p-3 text-center">
      <p className="text-lg font-bold text-text-primary">{value}</p>
      <p className="mt-0.5 text-[11px] text-text-secondary">{label}</p>
    </div>
  );
}
