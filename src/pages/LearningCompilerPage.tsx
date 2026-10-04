/**
 * Learning Compiler — /dashboard/learning-compiler
 *
 * Experience -> Observation -> Pattern -> Rule -> Playbook -> Policy
 * -> Workflow blueprint -> Evaluation. The compiler proposes; the account
 * owner reviews; active policies are enforced through checkLearnedPolicies()
 * and measured against similar jobs they did not cover.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Play, RefreshCw, ShieldAlert, Workflow, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  KIND_LABELS,
  VERDICT_LABELS,
  type Enforcement,
  type EvaluationVerdict,
  type LearnedPolicy,
  type PolicySeverity,
} from '@/lib/learningCompiler';
import {
  decidePolicy,
  evaluateActivePolicies,
  fetchLearnedPolicies,
  invalidateLearnedPolicyCache,
  runCompiler,
  type CompilerRunSummary,
} from '@/lib/learningCompilerApi';

type Tab = 'proposed' | 'active' | 'history';

const SEVERITY_STYLES: Record<PolicySeverity, string> = {
  avoid: 'bg-red-500/10 text-red-600 border-red-500/25',
  caution: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  info: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25',
};

const VERDICT_STYLES: Record<EvaluationVerdict, string> = {
  effective: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25',
  harmful: 'bg-red-500/10 text-red-600 border-red-500/25',
  inconclusive: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  insufficient_data: 'bg-bg-tertiary text-text-secondary border-border',
  not_applicable: 'bg-bg-tertiary text-text-secondary border-border',
};

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(x * 100)} pts`;

function RateBar({ label, rate, detail, tone }: { label: string; rate: number; detail: string; tone: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-text-secondary">
        <span>{label}</span>
        <span className="font-medium text-text-primary">{pct(rate)} <span className="font-normal text-text-secondary">({detail})</span></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, Math.round(rate * 100)))}%` }} />
      </div>
    </div>
  );
}

function PolicyCard({
  policy,
  isOwner,
  busy,
  onDecide,
}: {
  policy: LearnedPolicy;
  isOwner: boolean;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject' | 'retire', enforcement: Enforcement, note: string) => void;
}) {
  const [enforcement, setEnforcement] = useState<Enforcement>('advise');
  const [note, setNote] = useState('');
  const e = policy.evidence;
  const b = policy.backtest;
  const ev = policy.evaluation;
  const canEnforce = policy.kind !== 'dispatch_prefer';

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{policy.title}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{KIND_LABELS[policy.kind]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {policy.status === 'active' && (
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
              {policy.enforcement === 'require_approval' ? 'Requires approval' : 'Advisory'}
            </span>
          )}
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${SEVERITY_STYLES[policy.severity]}`}>{policy.severity}</span>
        </div>
      </div>

      <p className="mt-3 text-sm text-text-primary">{policy.rationale}</p>

      <div className="mt-3 space-y-2">
        <RateBar label="With this condition" rate={e.rate} detail={`${e.failures}/${e.samples}`} tone={policy.severity === 'info' ? 'bg-emerald-500' : 'bg-red-500'} />
        <RateBar label="Same job type otherwise" rate={e.complementRate} detail={`${e.complementFailures}/${e.complementSamples}`} tone="bg-text-secondary/50" />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-lg bg-bg-tertiary px-2 py-1 text-text-secondary">
          Confidence <span className="font-medium text-text-primary">q = {e.qValue < 0.001 ? '<0.001' : e.qValue.toFixed(3)}</span>
        </span>
        {b.earlyLift !== null && b.lateLift !== null && (
          <span className="rounded-lg bg-bg-tertiary px-2 py-1 text-text-secondary">
            Backtest <span className="font-medium text-text-primary">{signed(b.earlyLift)} → {signed(b.lateLift)}</span>
          </span>
        )}
      </div>

      <details className="mt-3 rounded-xl border border-border/60 px-3 py-2">
        <summary className="focus-ring cursor-pointer text-xs font-medium text-text-secondary">Playbook & workflow blueprint</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-text-primary">
          {policy.playbook.map((step) => <li key={step}>{step}</li>)}
        </ol>
        {policy.workflow_blueprint && (
          <div className="mt-3 border-t border-border/60 pt-2 text-xs text-text-secondary">
            <p className="flex items-center gap-1 font-medium text-text-primary"><Workflow size={12} /> {policy.workflow_blueprint.name}</p>
            <p className="mt-1">Trigger: <span className="text-text-primary">{policy.workflow_blueprint.trigger_event}</span> → human approval</p>
            <p className="mt-1">{policy.workflow_blueprint.steps[0]?.config.reason}</p>
            <p className="mt-1 italic">{policy.workflow_blueprint.note}</p>
          </div>
        )}
      </details>

      {policy.status === 'active' && ev && (
        <div className="mt-3 rounded-xl border border-border/60 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className={`rounded-full border px-2.5 py-1 font-semibold ${VERDICT_STYLES[ev.verdict]}`}>{VERDICT_LABELS[ev.verdict]}</span>
            {ev.didEffect !== null && <span className="text-text-secondary">Net effect <span className="font-medium text-text-primary">{signed(ev.didEffect)}</span></span>}
          </div>
          <p className="mt-2 flex items-center gap-1 text-text-secondary">
            Before {pct(ev.before.rate)} ({ev.before.n}) <ArrowRight size={11} /> after {pct(ev.after.rate)} ({ev.after.n})
            {ev.control.used && <span> · control {pct(ev.control.beforeRate)} → {pct(ev.control.afterRate)}</span>}
          </p>
        </div>
      )}

      {isOwner && (policy.status === 'proposed' || policy.status === 'active') && (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          {policy.status === 'proposed' && canEnforce && (
            <select
              value={enforcement}
              onChange={(ev2) => setEnforcement(ev2.target.value as Enforcement)}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary"
              aria-label="Enforcement level"
            >
              <option value="advise">Advisory — warn, a person decides</option>
              <option value="require_approval">Require approval before it proceeds</option>
            </select>
          )}
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={(ev2) => setNote(ev2.target.value)}
              maxLength={500}
              placeholder={policy.status === 'proposed' ? 'Review note (optional)' : 'Why retire this policy? (optional)'}
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
            />
            {policy.status === 'proposed' ? (
              <>
                <button type="button" disabled={busy} onClick={() => onDecide(policy.id, 'approve', canEnforce ? enforcement : 'advise', note)} className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  <Check size={13} /> Approve
                </button>
                <button type="button" disabled={busy} onClick={() => onDecide(policy.id, 'reject', 'advise', note)} className="focus-ring flex items-center gap-1 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary disabled:opacity-40">
                  <X size={13} /> Reject
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => onDecide(policy.id, 'retire', 'advise', note)} className="focus-ring rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary disabled:opacity-40">
                Retire
              </button>
            )}
          </div>
        </div>
      )}

      {policy.decision_note && policy.status !== 'proposed' && (
        <p className="mt-3 border-t border-border/60 pt-3 text-xs text-text-secondary">Note: {policy.decision_note}</p>
      )}
    </motion.div>
  );
}

export function LearningCompilerPage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();

  const [policies, setPolicies] = useState<LearnedPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('proposed');
  const [lastRun, setLastRun] = useState<CompilerRunSummary | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setPolicies(await fetchLearnedPolicies());
    } catch {
      toast('Could not load learned policies', 'error');
    }
    setLoading(false);
  }, [user, toast]);

  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => ({
    proposed: policies.filter((p) => p.status === 'proposed'),
    active: policies.filter((p) => p.status === 'active'),
    history: policies.filter((p) => p.status === 'rejected' || p.status === 'retired' || p.status === 'superseded'),
  }), [policies]);

  const stages = useMemo(() => {
    const s = lastRun?.result.stages;
    const live = [...grouped.proposed, ...grouped.active];
    return [
      { label: 'Experience', value: s ? s.experiences : null },
      { label: 'Observation', value: s ? s.observations : null },
      { label: 'Pattern', value: s ? s.replicated : null },
      { label: 'Rule', value: s ? s.rules : null },
      { label: 'Playbook', value: live.length },
      { label: 'Policy', value: grouped.active.length },
      { label: 'Workflow', value: live.filter((p) => p.workflow_blueprint !== null).length },
      { label: 'Evaluation', value: grouped.active.filter((p) => p.evaluation && p.evaluation.verdict !== 'insufficient_data' && p.evaluation.verdict !== 'not_applicable').length },
    ];
  }, [lastRun, grouped]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const summary = await runCompiler();
      setLastRun(summary);
      await load();
      const { inserted, refreshed, superseded } = summary.saved;
      toast(
        inserted + refreshed + superseded === 0
          ? 'Compiled — no pattern is strong enough yet to propose a policy'
          : `Compiled — ${inserted} new, ${refreshed} refreshed, ${superseded} no longer supported`,
        'success',
      );
    } catch {
      toast('The compiler could not run', 'error');
    }
    setRunning(false);
  };

  const handleEvaluate = async () => {
    setEvaluating(true);
    try {
      await evaluateActivePolicies(policies);
      await load();
      toast('Active policies evaluated', 'success');
    } catch {
      toast('Could not evaluate active policies', 'error');
    }
    setEvaluating(false);
  };

  const handleDecide = async (id: string, decision: 'approve' | 'reject' | 'retire', enforcement: Enforcement, note: string) => {
    setBusyId(id);
    try {
      await decidePolicy(id, decision, { enforcement, note });
      invalidateLearnedPolicyCache();
      await load();
      toast(decision === 'approve' ? 'Policy activated' : decision === 'reject' ? 'Proposal rejected' : 'Policy retired', 'success');
    } catch {
      toast('Could not save that decision', 'error');
    }
    setBusyId(null);
  };

  const visible = grouped[tab];

  return (
    <DashboardLayout activeLabel="Learning Compiler">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Workflow size={22} className="text-accent" /> Organizational Learning Compiler
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Turns what actually happened on your jobs into executable policy. Patterns must survive false-discovery
              control and replicate across time before they are proposed. Nothing goes live without your approval.
            </p>
          </div>
          {isOwner && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={handleEvaluate} disabled={evaluating || grouped.active.length === 0} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-accent disabled:opacity-40">
                <RefreshCw size={13} className={evaluating ? 'animate-spin' : ''} /> Evaluate active
              </button>
              <button type="button" onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50">
                <Play size={13} /> {running ? 'Compiling…' : 'Compile now'}
              </button>
            </div>
          )}
        </div>

        <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {stages.map((s, i) => (
            <div key={s.label} className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{i + 1}. {s.label}</p>
              <p className="mt-1 text-lg font-bold text-text-primary">{s.value === null ? '—' : s.value}</p>
            </div>
          ))}
        </div>

        {!isOwner && (
          <p className="mb-4 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
            Only the account owner can compile, approve or retire policies. You can review everything here.
          </p>
        )}

        <div className="mb-4 flex gap-1 border-b border-border">
          {([['proposed', 'Awaiting review'], ['active', 'Active'], ['history', 'History']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`focus-ring -mb-px border-b-2 px-3 py-2 text-xs font-semibold ${tab === key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {label} <span className="ml-1 text-text-secondary">{grouped[key].length}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-48 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              {tab === 'proposed'
                ? 'Nothing awaiting review. Compile after more completed jobs have recorded outcomes — a pattern needs enough evidence before it is proposed.'
                : tab === 'active'
                  ? 'No active policies yet. Approve a proposal to start enforcing and measuring it.'
                  : 'No rejected, retired or superseded policies.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {visible.map((p) => (
              <PolicyCard key={p.id} policy={p} isOwner={isOwner} busy={busyId === p.id} onDecide={handleDecide} />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
