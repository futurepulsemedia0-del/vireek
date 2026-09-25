/**
 * Autonomy Budget — /dashboard/autonomy-budget
 * Per-agent ceiling on independent authority: spend, action count, session
 * duration, an explicit tool allowlist, and a declared risk level. Builds
 * on the agent/tool vocabulary already registered in agent_action_catalog
 * (see Agent Governance) — this is the "how much rope" layer on top of
 * that "which actions" layer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Timer, Loader2, Plus, Trash2, History } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { fetchAgentCatalog, type AgentActionCatalogEntry } from '@/lib/agentGovernance';
import {
  RISK_COLOR,
  RISK_LABELS,
  deleteAutonomyBudget,
  fetchAutonomyBudgets,
  fetchAutonomySessions,
  upsertAutonomyBudget,
  type AutonomyBudget,
  type AutonomySession,
  type BudgetPeriod,
  type RiskLevel,
} from '@/lib/autonomyBudget';

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const PERIODS: BudgetPeriod[] = ['daily', 'weekly', 'monthly'];
const STATUS_COLOR: Record<string, string> = {
  running: 'text-accent', completed: 'text-success-500', terminated_budget_exceeded: 'text-error-500',
};

const emptyForm = {
  agent_source: '',
  risk_level: 'medium' as RiskLevel,
  spend_limit_dollars: '',
  spend_period: 'daily' as BudgetPeriod,
  max_actions: '',
  actions_period: 'daily' as BudgetPeriod,
  max_session_minutes: '',
  allowed_tools: [] as string[],
  enabled: true,
};

export function AutonomyBudgetPage() {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<AgentActionCatalogEntry[]>([]);
  const [budgets, setBudgets] = useState<AutonomyBudget[]>([]);
  const [sessions, setSessions] = useState<AutonomySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const agentSources = useMemo(() => [...new Set(catalog.map((c) => c.agent_source))].sort(), [catalog]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, b, s] = await Promise.all([fetchAgentCatalog(), fetchAutonomyBudgets(), fetchAutonomySessions()]);
      setCatalog(c); setBudgets(b); setSessions(s);
      if (!form.agent_source && c.length) setForm((f) => ({ ...f, agent_source: c[0].agent_source }));
    } catch {
      toast('Could not load autonomy budgets.', 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const toggleTool = (slug: string) => {
    setForm((f) => ({ ...f, allowed_tools: f.allowed_tools.includes(slug) ? f.allowed_tools.filter((s) => s !== slug) : [...f.allowed_tools, slug] }));
  };

  const handleSave = async () => {
    if (!form.agent_source.trim()) {
      toast('Pick or type an agent.', 'error');
      return;
    }
    setSaving(true);
    try {
      await upsertAutonomyBudget({
        agent_source: form.agent_source.trim(),
        risk_level: form.risk_level,
        spend_limit_cents: form.spend_limit_dollars.trim() === '' ? null : Math.round(Number(form.spend_limit_dollars) * 100),
        spend_period: form.spend_period,
        max_actions: form.max_actions.trim() === '' ? null : Math.max(1, Number(form.max_actions)),
        actions_period: form.actions_period,
        max_session_minutes: form.max_session_minutes.trim() === '' ? null : Math.max(1, Number(form.max_session_minutes)),
        allowed_tools: form.allowed_tools,
        enabled: form.enabled,
      });
      toast('Autonomy budget saved.', 'success');
      setForm(emptyForm);
      void load();
    } catch {
      toast('Could not save this budget.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Remove this autonomy budget? The agent will be blocked from starting new sessions until a new one is set.')) return;
    try {
      await deleteAutonomyBudget(id);
      toast('Budget removed.', 'success');
      void load();
    } catch {
      toast('Could not remove this budget.', 'error');
    }
  };

  const edit = (b: AutonomyBudget) => {
    setForm({
      agent_source: b.agent_source,
      risk_level: b.risk_level,
      spend_limit_dollars: b.spend_limit_cents != null ? String(b.spend_limit_cents / 100) : '',
      spend_period: b.spend_period,
      max_actions: b.max_actions != null ? String(b.max_actions) : '',
      actions_period: b.actions_period,
      max_session_minutes: b.max_session_minutes != null ? String(b.max_session_minutes) : '',
      allowed_tools: b.allowed_tools,
      enabled: b.enabled,
    });
  };

  if (loading) {
    return <DashboardLayout activeLabel="Autonomy Budget"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Autonomy Budget">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Timer className="text-cta" size={20} />
          <div>
            <p className="text-sm font-semibold text-text-primary">Autonomy Budget</p>
            <p className="text-xs text-text-secondary">How much independent authority each agent gets in one run — spend, actions, duration, tools, risk.</p>
          </div>
        </div>

        {/* Form */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Set a budget</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <input list="agent-sources" className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" placeholder="Agent (e.g. outbound-dialer)" value={form.agent_source} onChange={(e) => setForm({ ...form, agent_source: e.target.value })} />
            <datalist id="agent-sources">{agentSources.map((a) => <option key={a} value={a} />)}</datalist>
            <select className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value as RiskLevel })}>
              {RISK_LEVELS.map((r) => <option key={r} value={r}>{RISK_LABELS[r]} risk</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled
            </label>

            <div className="flex gap-2">
              <input className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Spend limit ($)" value={form.spend_limit_dollars} onChange={(e) => setForm({ ...form, spend_limit_dollars: e.target.value })} />
              <select className="focus-ring rounded-xl border border-border bg-bg-primary px-2 py-2 text-sm text-text-primary" value={form.spend_period} onChange={(e) => setForm({ ...form, spend_period: e.target.value as BudgetPeriod })}>
                {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <input className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Max actions" value={form.max_actions} onChange={(e) => setForm({ ...form, max_actions: e.target.value })} />
              <select className="focus-ring rounded-xl border border-border bg-bg-primary px-2 py-2 text-sm text-text-primary" value={form.actions_period} onChange={(e) => setForm({ ...form, actions_period: e.target.value as BudgetPeriod })}>
                {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Max session (minutes)" value={form.max_session_minutes} onChange={(e) => setForm({ ...form, max_session_minutes: e.target.value })} />
          </div>

          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium text-text-secondary">Allowed tools (none checked = no restriction)</p>
            <div className="flex flex-wrap gap-2">
              {catalog.map((c) => (
                <label key={c.slug} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${form.allowed_tools.includes(c.slug) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                  <input type="checkbox" className="hidden" checked={form.allowed_tools.includes(c.slug)} onChange={() => toggleTool(c.slug)} />
                  {c.label}
                </label>
              ))}
            </div>
          </div>

          <button onClick={handleSave} disabled={saving} className="focus-ring mt-3 flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save budget
          </button>
        </div>

        {/* Budgets list */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Agent budgets ({budgets.length})</p>
          {budgets.length === 0 ? (
            <p className="text-sm text-text-secondary">No budgets set yet — agents with no budget can't start an autonomy session.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {budgets.map((b) => (
                <div key={b.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-text-primary">{b.agent_source} {!b.enabled && <span className="text-xs text-text-secondary">(disabled)</span>}</p>
                      <p className={`text-xs font-semibold uppercase ${RISK_COLOR[b.risk_level]}`}>{RISK_LABELS[b.risk_level]} risk</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => edit(b)} className="focus-ring rounded-lg bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-secondary">Edit</button>
                      <button onClick={() => handleDelete(b.id)} className="focus-ring rounded-lg bg-error-500/15 p-1.5 text-error-500"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <div className="mt-2 space-y-0.5 text-[11px] text-text-secondary">
                    <p>Spend: {b.spend_limit_cents != null ? `$${(b.spend_limit_cents / 100).toLocaleString()} / ${b.spend_period}` : 'unlimited'}</p>
                    <p>Actions: {b.max_actions != null ? `${b.max_actions} / ${b.actions_period}` : 'unlimited'}</p>
                    <p>Session length: {b.max_session_minutes != null ? `${b.max_session_minutes} min` : 'unlimited'}</p>
                    <p>Tools: {b.allowed_tools.length > 0 ? b.allowed_tools.join(', ') : 'no restriction'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent sessions */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center gap-2"><History size={16} className="text-text-secondary" /><p className="text-sm font-semibold text-text-primary">Recent sessions</p></div>
          {sessions.length === 0 ? (
            <p className="text-sm text-text-secondary">No autonomy sessions recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div>
                    <span className="font-medium text-text-primary">{s.agent_source}</span>{' '}
                    <span className={`text-xs font-semibold ${STATUS_COLOR[s.status]}`}>{s.status.replace(/_/g, ' ')}</span>
                    {s.termination_reason && <span className="ml-1 text-xs text-text-secondary">— {s.termination_reason}</span>}
                  </div>
                  <span className="text-xs text-text-secondary">{s.actions_taken} actions · ${(s.spend_cents / 100).toFixed(2)} · {new Date(s.started_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
