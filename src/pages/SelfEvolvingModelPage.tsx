/**
 * Self-Evolving Company Operating Model — /dashboard/operating-model
 * Observe -> learn -> propose -> human decides -> apply. Deterministic,
 * bounded, fully explained — see the migration header for the full loop.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Loader2, RefreshCw, Plus, Check, X, History, TrendingUp, TrendingDown } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  DOMAIN_LABELS,
  decideProposal,
  fetchCycles,
  fetchPolicies,
  fetchProposals,
  logObservation,
  runEvolutionCycle,
  seedDefaultPolicies,
  type EvolutionCycle,
  type EvolutionProposal,
  type OperatingPolicy,
} from '@/lib/selfEvolvingModel';

export function SelfEvolvingModelPage() {
  const { toast } = useToast();
  const [policies, setPolicies] = useState<OperatingPolicy[]>([]);
  const [proposals, setProposals] = useState<EvolutionProposal[]>([]);
  const [cycles, setCycles] = useState<EvolutionCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const [obsPolicyId, setObsPolicyId] = useState('');
  const [obsObserved, setObsObserved] = useState('');
  const [obsTarget, setObsTarget] = useState('');
  const [obsSamples, setObsSamples] = useState('10');
  const [obsSaving, setObsSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await seedDefaultPolicies();
      const [p, pr, c] = await Promise.all([fetchPolicies(), fetchProposals('pending'), fetchCycles()]);
      setPolicies(p);
      setProposals(pr);
      setCycles(c);
      if (!obsPolicyId && p.length) setObsPolicyId(p[0].id);
    } catch {
      toast('Could not load the operating model.', 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const policyById = useMemo(() => new Map(policies.map((p) => [p.id, p])), [policies]);
  const grouped = useMemo(() => {
    const g = new Map<string, OperatingPolicy[]>();
    for (const p of policies) g.set(p.domain, [...(g.get(p.domain) ?? []), p]);
    return g;
  }, [policies]);

  const handleRunCycle = async () => {
    setRunning(true);
    try {
      const res = await runEvolutionCycle();
      toast(
        res.proposals_created > 0
          ? `Reviewed ${res.policies_reviewed} policies — ${res.proposals_created} new proposal(s) ready for review.`
          : `Reviewed ${res.policies_reviewed} policies — no adjustment cleared the evidence bar this time.`,
        'success',
      );
      void load();
    } catch {
      toast('Could not run an evolution cycle.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleLogObservation = async () => {
    if (!obsPolicyId || obsObserved.trim() === '' || obsTarget.trim() === '') {
      toast('Fill in the policy, observed value, and target.', 'error');
      return;
    }
    setObsSaving(true);
    try {
      const today = new Date();
      const periodStart = new Date(today);
      periodStart.setDate(periodStart.getDate() - 30);
      await logObservation({
        policy_id: obsPolicyId,
        observed_metric: Number(obsObserved),
        target_metric: Number(obsTarget),
        sample_size: Math.max(1, Number(obsSamples) || 1),
        period_start: periodStart.toISOString().slice(0, 10),
        period_end: today.toISOString().slice(0, 10),
      });
      setObsObserved(''); setObsTarget('');
      toast('Observation logged.', 'success');
      void load();
    } catch {
      toast('Could not log this observation.', 'error');
    } finally {
      setObsSaving(false);
    }
  };

  const handleDecide = async (proposal: EvolutionProposal, decision: 'approved' | 'rejected') => {
    let reason: string | null = '';
    if (decision === 'rejected') {
      reason = window.prompt('Reason for rejecting this proposal (required):');
      if (!reason) return;
    }
    try {
      await decideProposal(proposal.id, decision, reason || undefined);
      toast(decision === 'approved' ? 'Adjustment applied.' : 'Proposal rejected.', 'success');
      void load();
    } catch {
      toast('Could not record this decision.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Self-Evolving Operating Model"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Self-Evolving Operating Model">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="text-cta" size={20} />
            <div>
              <p className="text-sm font-semibold text-text-primary">Self-Evolving Operating Model</p>
              <p className="text-xs text-text-secondary">Observe outcomes → propose a bounded policy nudge → you decide → it applies.</p>
            </div>
          </div>
          <button onClick={handleRunCycle} disabled={running} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Run evolution cycle
          </button>
        </div>

        {/* Policies by domain */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Operating policies ({policies.length})</p>
          <div className="space-y-4">
            {[...grouped.entries()].map(([domain, list]) => (
              <div key={domain}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{DOMAIN_LABELS[domain as keyof typeof DOMAIN_LABELS] ?? domain}</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((p) => (
                    <div key={p.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                      <p className="font-medium text-text-primary">{p.label}</p>
                      <p className="mt-1 text-lg font-semibold text-text-primary">{p.current_value} <span className="text-xs font-normal text-text-secondary">{p.unit}</span></p>
                      <p className="mt-1 text-[11px] text-text-secondary">Range {p.guardrail_min}–{p.guardrail_max} {p.unit} · evolved {p.evolution_count}×</p>
                      {p.last_evolved_at && <p className="text-[11px] text-text-secondary">Last change {new Date(p.last_evolved_at).toLocaleDateString()}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Log an observation */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Log an observation (last 30 days)</p>
          <div className="grid gap-2 sm:grid-cols-4">
            <select className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary sm:col-span-2" value={obsPolicyId} onChange={(e) => setObsPolicyId(e.target.value)}>
              {policies.map((p) => <option key={p.id} value={p.id}>{DOMAIN_LABELS[p.domain]} — {p.label}</option>)}
            </select>
            <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Observed value" value={obsObserved} onChange={(e) => setObsObserved(e.target.value)} />
            <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" placeholder="Target value" value={obsTarget} onChange={(e) => setObsTarget(e.target.value)} />
            <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" type="number" min={1} placeholder="Sample size" value={obsSamples} onChange={(e) => setObsSamples(e.target.value)} />
          </div>
          <button onClick={handleLogObservation} disabled={obsSaving} className="focus-ring mt-3 flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {obsSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Log observation
          </button>
          <p className="mt-2 text-[11px] text-text-secondary">Needs at least 5 samples and an 8%+ deviation from target, accumulated over 60 days, before a cycle will propose anything.</p>
        </div>

        {/* Pending proposals */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Pending proposals ({proposals.length})</p>
          {proposals.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing pending — run an evolution cycle after logging enough observations.</p>
          ) : (
            <div className="space-y-2">
              {proposals.map((pr) => {
                const policy = policyById.get(pr.policy_id);
                return (
                  <div key={pr.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2">
                        {pr.direction === 'increase' ? <TrendingUp size={16} className="mt-0.5 text-success-500" /> : <TrendingDown size={16} className="mt-0.5 text-warning-500" />}
                        <div>
                          <p className="font-medium text-text-primary">{policy?.label ?? 'Policy'}: {pr.current_value_snapshot} → {pr.proposed_value} {policy?.unit}</p>
                          <p className="mt-1 text-xs text-text-secondary">{pr.rationale}</p>
                          <p className="mt-1 text-[11px] text-text-secondary">Confidence: <span className="font-medium">{pr.confidence}</span> · {pr.evidence.sample_size} samples · {pr.evidence.deviation_pct}% deviation</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button onClick={() => handleDecide(pr, 'approved')} className="focus-ring flex items-center gap-1 rounded-lg bg-success-500/15 px-3 py-1.5 text-xs font-medium text-success-500"><Check size={14} /> Approve</button>
                        <button onClick={() => handleDecide(pr, 'rejected')} className="focus-ring flex items-center gap-1 rounded-lg bg-error-500/15 px-3 py-1.5 text-xs font-medium text-error-500"><X size={14} /> Reject</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Cycle history */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center gap-2"><History size={16} className="text-text-secondary" /><p className="text-sm font-semibold text-text-primary">Cycle history</p></div>
          {cycles.length === 0 ? (
            <p className="text-sm text-text-secondary">No cycles run yet.</p>
          ) : (
            <div className="space-y-2">
              {cycles.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span className="text-text-primary">{c.summary ?? 'Running…'}</span>
                  <span className="text-xs text-text-secondary">{new Date(c.started_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
