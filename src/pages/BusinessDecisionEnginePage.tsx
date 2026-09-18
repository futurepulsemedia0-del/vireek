import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, RefreshCw, Cpu, DollarSign, Users, Megaphone, Wrench, Heart, Settings as SettingsIcon, Check, X as XIcon, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, BusinessDecision, BusinessDecisionSettings } from '@/lib/supabase';

const CATEGORY_CONFIG: Record<BusinessDecision['category'], { icon: typeof DollarSign; label: string; color: string }> = {
  pricing: { icon: DollarSign, label: 'Pricing', color: 'text-emerald-500 bg-emerald-500/10' },
  dispatch: { icon: Zap, label: 'Dispatch', color: 'text-amber-500 bg-amber-500/10' },
  staffing: { icon: Wrench, label: 'Staffing', color: 'text-blue-500 bg-blue-500/10' },
  marketing: { icon: Megaphone, label: 'Marketing', color: 'text-violet-500 bg-violet-500/10' },
  collections: { icon: DollarSign, label: 'Collections', color: 'text-danger bg-danger/10' },
  retention: { icon: Heart, label: 'Retention', color: 'text-pink-500 bg-pink-500/10' },
  operations: { icon: Users, label: 'Operations', color: 'text-slate-500 bg-slate-500/10' },
};

function DecisionCard({ decision, onUpdate, index }: { decision: BusinessDecision; onUpdate: (id: string, status: 'approved' | 'rejected') => void; index: number }) {
  const config = CATEGORY_CONFIG[decision.category];
  const Icon = config.icon;
  const isPending = decision.status === 'pending';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 20, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${config.color}`}>
            <Icon size={20} />
          </span>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{config.label}</span>
            <h3 className="font-semibold text-text-primary">{decision.title}</h3>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
          {decision.confidence_score}% confidence
        </span>
      </div>

      <p className="text-sm text-text-secondary">{decision.reasoning}</p>
      <p className="rounded-lg bg-bg-primary p-3 text-sm text-text-primary">
        <strong>Recommended:</strong> {decision.recommended_action}
      </p>

      {decision.estimated_impact != null && decision.estimated_impact > 0 && (
        <p className="text-xs text-text-secondary">Estimated impact: ${decision.estimated_impact.toLocaleString()}</p>
      )}

      {isPending ? (
        <div className="flex gap-2 pt-1">
          <button onClick={() => onUpdate(decision.id, 'approved')} className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Check size={16} /> Approve
          </button>
          <button onClick={() => onUpdate(decision.id, 'rejected')} className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-bg-primary">
            <XIcon size={16} /> Dismiss
          </button>
        </div>
      ) : (
        <span className="w-fit rounded-full border border-border px-2.5 py-1 text-xs font-medium capitalize text-text-secondary">
          {decision.status.replace('_', ' ')}
        </span>
      )}
    </motion.div>
  );
}

export function BusinessDecisionEnginePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [decisions, setDecisions] = useState<BusinessDecision[]>([]);
  const [settings, setSettings] = useState<BusinessDecisionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: d }, { data: s }] = await Promise.all([
      supabase.from('business_decisions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('business_decision_settings').select('*').eq('user_id', user.id).maybeSingle(),
    ]);
    setDecisions((d ?? []) as BusinessDecision[]);
    setSettings(s as BusinessDecisionSettings | null);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke('business-decision-engine', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (error) throw error;
      const generated = data?.generated ?? 0;
      const autoExecuted = data?.auto_executed ?? 0;
      if (generated || autoExecuted) {
        toast(`${generated} new decision${generated !== 1 ? 's' : ''} to review${autoExecuted ? `, ${autoExecuted} auto-executed` : ''}.`, 'success');
      } else {
        toast('No new decisions — nothing notable right now.', 'info');
      }
      await load();
    } catch {
      toast('Could not run the decision engine. Please try again.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleUpdate = async (id: string, status: 'approved' | 'rejected') => {
    setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d)));
    const { error } = await supabase.from('business_decisions').update({ status }).eq('id', id);
    if (error) { toast('Could not update this decision.', 'error'); load(); }
  };

  const handleSettingChange = async (patch: Partial<BusinessDecisionSettings>) => {
    if (!user || !settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const { error } = await supabase.from('business_decision_settings').update(patch).eq('user_id', user.id);
    if (error) { toast('Could not save settings.', 'error'); load(); }
  };

  const pending = decisions.filter((d) => d.status === 'pending');
  const history = decisions.filter((d) => d.status !== 'pending');

  return (
    <DashboardLayout activeLabel="Business Decision Engine">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Cpu size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Business Decision Engine</h1>
            <p className="text-sm text-text-secondary">Grounded, explainable recommendations — approve them or let safe ones run automatically.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowSettings((s) => !s)} className="focus-ring flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-bg-secondary">
            <SettingsIcon size={16} /> Autonomy Settings
          </button>
          <button onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
            <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> Run Analysis
          </button>
        </div>
      </div>

      {showSettings && settings && (
        <div className="mb-6 space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Allow autonomous execution</span>
            <input type="checkbox" checked={settings.autonomy_enabled} onChange={(e) => handleSettingChange({ autonomy_enabled: e.target.checked })} className="h-5 w-5 accent-accent" />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Auto-manage surge mode during emergency spikes</span>
            <input type="checkbox" disabled={!settings.autonomy_enabled} checked={settings.surge_mode_auto_control} onChange={(e) => handleSettingChange({ surge_mode_auto_control: e.target.checked })} className="h-5 w-5 accent-accent" />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-text-primary">Minimum confidence to surface a decision ({settings.min_confidence_threshold}%)</span>
            <input type="range" min={50} max={95} step={5} value={settings.min_confidence_threshold} onChange={(e) => handleSettingChange({ min_confidence_threshold: Number(e.target.value) })} className="w-40 accent-accent" />
          </label>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-semibold text-text-primary">Awaiting your review ({pending.length})</h2>
            {pending.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">No pending decisions. Run an analysis to check for new ones.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <AnimatePresence>
                  {pending.map((d, i) => <DecisionCard key={d.id} decision={d} onUpdate={handleUpdate} index={i} />)}
                </AnimatePresence>
              </div>
            )}
          </section>

          {history.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-text-primary">History</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {history.map((d, i) => <DecisionCard key={d.id} decision={d} onUpdate={handleUpdate} index={i} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
