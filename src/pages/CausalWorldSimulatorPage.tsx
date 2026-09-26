import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, GitBranch, Loader2, Plus, X as XIcon, TrendingUp, TrendingDown,
  AlertTriangle, Users, CheckCircle2, Sparkles, DollarSign, Percent, ShieldCheck, Gauge,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, CausalScenario, CausalSimulation, CausalOutcomeTracking } from '@/lib/supabase';

const CATEGORY_LABELS: Record<CausalScenario['decision_category'], string> = {
  pricing: 'Pricing', dispatch: 'Dispatch', staffing: 'Staffing', marketing: 'Marketing',
  collections: 'Collections', retention: 'Retention', operations: 'Operations', other: 'Other',
};

type ScenarioWithData = CausalScenario & {
  simulation: CausalSimulation | null;
  tracking: CausalOutcomeTracking | null;
};

function ImpactBadge({ pct }: { pct: number }) {
  const positive = pct > 0;
  const Icon = positive ? TrendingUp : pct < 0 ? TrendingDown : Sparkles;
  const color = positive ? 'text-emerald-500 bg-emerald-500/10' : pct < 0 ? 'text-danger bg-danger/10' : 'text-text-secondary bg-bg-primary';
  return (
    <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}>
      <Icon size={13} /> {positive ? '+' : ''}{pct}%
    </span>
  );
}

// Reads the deterministic Revenue/Margin/SLA/Capacity baseline that the
// edge function now stores alongside each simulation (causal_simulations.baseline_metrics).
// A metric shows "n/a" rather than 0 when this account's schema doesn't
// yet expose it (e.g. no job_profitability view) — never invents a number.
function BusinessSnapshot({ metrics }: { metrics: Record<string, unknown> | null | undefined }) {
  if (!metrics) return null;

  const revenue = typeof metrics.revenue_last_30d === 'number' ? metrics.revenue_last_30d : null;
  const margin = typeof metrics.gross_margin_pct === 'number' ? metrics.gross_margin_pct : null;
  const sla = typeof metrics.sla_on_time_pct === 'number' ? metrics.sla_on_time_pct : null;
  const capacity = typeof metrics.capacity_load_pct === 'number' ? metrics.capacity_load_pct : null;

  const cells = [
    { icon: DollarSign, label: 'Revenue (30d)', value: revenue !== null ? `$${Math.round(revenue).toLocaleString('en-US')}` : 'n/a' },
    { icon: Percent, label: 'Gross margin', value: margin !== null ? `${margin}%` : 'n/a' },
    { icon: ShieldCheck, label: 'On-time / SLA', value: sla !== null ? `${sla}%` : 'n/a' },
    { icon: Gauge, label: 'Capacity load', value: capacity !== null ? `${capacity}%` : 'n/a' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border border-border bg-bg-primary p-2.5">
          <div className="flex items-center gap-1.5 text-text-secondary">
            <c.icon size={12} />
            <span className="text-[11px] font-medium">{c.label}</span>
          </div>
          <p className="mt-1 text-sm font-semibold text-text-primary">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

function ScenarioCard({ item, onMarkImplemented, index }: { item: ScenarioWithData; onMarkImplemented: (id: string) => void; index: number }) {
  const sim = item.simulation;
  return (
    <motion.div
      layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{CATEGORY_LABELS[item.decision_category]}</span>
          <h3 className="font-semibold text-text-primary">{item.title}</h3>
        </div>
        {sim && <ImpactBadge pct={sim.predicted_impact_pct} />}
      </div>

      <p className="text-sm text-text-secondary">{item.decision_description}</p>

      {item.status === 'simulating' && (
        <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Simulating…</p>
      )}
      {item.status === 'failed' && (
        <p className="flex items-center gap-2 text-sm text-danger"><AlertTriangle size={14} /> Simulation failed. Try again.</p>
      )}

      {sim && (
        <>
          <BusinessSnapshot metrics={sim.baseline_metrics} />

          <p className="rounded-lg bg-bg-primary p-3 text-sm text-text-primary">{sim.counterfactual_narrative}</p>

          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <Users size={13} />
              {sim.cohort_available
                ? `Based on ${sim.cohort_sample_size} similar businesses (${sim.cohort_success_rate}% saw a positive outcome)`
                : 'Not enough platform data yet for this category — qualitative estimate only'}
            </span>
            <span className="rounded-full bg-accent/10 px-2 py-0.5 font-semibold text-accent">{sim.predicted_confidence}% confidence</span>
            <span>Measured over {sim.timeframe_days} days</span>
          </div>

          {sim.causal_factors.length > 0 && (
            <ul className="space-y-1.5">
              {sim.causal_factors.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${f.direction === 'positive' ? 'bg-emerald-500' : f.direction === 'negative' ? 'bg-danger' : 'bg-text-secondary'}`} />
                  <span><strong className="text-text-primary">{f.factor}:</strong> <span className="text-text-secondary">{f.explanation}</span></span>
                </li>
              ))}
            </ul>
          )}

          {sim.risk_factors.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-text-secondary">
              <p className="mb-1 flex items-center gap-1 font-semibold text-amber-500"><AlertTriangle size={13} /> Risks</p>
              <ul className="list-inside list-disc space-y-0.5">{sim.risk_factors.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}

          <div className="pt-1">
            {!item.tracking ? (
              <button onClick={() => onMarkImplemented(item.id)} className="focus-ring flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-primary">
                <CheckCircle2 size={16} /> I did this — track the real outcome
              </button>
            ) : item.tracking.outcome_recorded_at ? (
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                Actual result: <ImpactBadge pct={item.tracking.actual_impact_pct ?? 0} />
              </span>
            ) : (
              <span className="text-xs text-text-secondary">Tracking real outcome — result will appear automatically once {item.tracking.timeframe_days} days have passed.</span>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}

export function CausalWorldSimulatorPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<ScenarioWithData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [running, setRunning] = useState(false);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<CausalScenario['decision_category']>('pricing');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data: scenarios } = await supabase.from('causal_scenarios').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
    const scenarioIds = (scenarios ?? []).map((s) => s.id);
    const [{ data: sims }, { data: tracks }] = await Promise.all([
      scenarioIds.length ? supabase.from('causal_simulations').select('*').in('scenario_id', scenarioIds) : Promise.resolve({ data: [] }),
      scenarioIds.length ? supabase.from('causal_outcome_tracking').select('*').in('scenario_id', scenarioIds) : Promise.resolve({ data: [] }),
    ]);
    const combined: ScenarioWithData[] = (scenarios ?? []).map((s) => ({
      ...s,
      simulation: (sims ?? []).find((sim) => sim.scenario_id === s.id) ?? null,
      tracking: (tracks ?? []).find((t) => t.scenario_id === s.id) ?? null,
    }));
    setItems(combined);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const invoke = async (payload: Record<string, unknown>) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    return supabase.functions.invoke('causal-world-simulator', {
      body: payload,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  };

  const handleRun = async () => {
    if (title.trim().length < 3 || description.trim().length < 10) {
      toast('Add a short title and describe the decision in a bit more detail.', 'error');
      return;
    }
    setRunning(true);
    try {
      const { error } = await invoke({ action: 'simulate', title, decision_category: category, decision_description: description });
      if (error) throw error;
      toast('Simulation complete.', 'success');
      setShowForm(false);
      setTitle(''); setDescription(''); setCategory('pricing');
      await load();
    } catch {
      toast('Could not run the simulation. Please try again.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleMarkImplemented = async (scenarioId: string) => {
    try {
      const { error } = await invoke({ action: 'mark_implemented', scenario_id: scenarioId });
      if (error) throw error;
      toast('Tracking the real outcome now — check back once the window closes.', 'success');
      await load();
    } catch {
      toast('Could not start tracking this scenario.', 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Causal World Simulator">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <GitBranch size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Causal World Simulator</h1>
            <p className="text-sm text-text-secondary">"If I do this, what happens — and what would happen if I didn't?" Grounded in your data and real outcomes from similar businesses.</p>
          </div>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          {showForm ? <XIcon size={16} /> : <Plus size={16} />} {showForm ? 'Cancel' : 'New scenario'}
        </button>
      </div>

      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Raise emergency call-out fee by 15%" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value as CausalScenario['decision_category'])} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Describe the decision</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What exactly are you considering, and why?" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              </div>
              <button onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
                {running ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Run simulation
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">No scenarios yet. Create one to see a grounded, causal answer.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <AnimatePresence>
            {items.map((item, i) => <ScenarioCard key={item.id} item={item} onMarkImplemented={handleMarkImplemented} index={i} />)}
          </AnimatePresence>
        </div>
      )}
    </DashboardLayout>
  );
}
