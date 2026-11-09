import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Clock, Loader2, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { decideAgentAction, fetchAgentActionLog, formatCents, type AgentActionLogEntry } from '@/lib/agentGovernance';
import { fetchApprovalContext, fetchRunTimeline, type ApprovalContext } from '@/lib/agentRuns';
import {
  approvalState,
  runBudgetSummary,
  stepStatusLabel,
  summarizeToolInput,
  type RunStepView,
} from '@/lib/agentRunsCore';

/**
 * Pending agent actions, with what an approver needs to decide: the plan step, the evidence (what will be
 * sent/done), cost, whether it can be rolled back, and how long the approval stays valid (approvals older
 * than 24h are refused by the server so they never execute on outdated facts).
 */
export function AgentApprovalPanel({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<AgentActionLogEntry[]>([]);
  const [context, setContext] = useState<Map<string, ApprovalContext>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<RunStepView[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const pending = await fetchAgentActionLog({ status: 'pending_approval', limit: 50 });
      setEntries(pending);
      // Context is best-effort: the approval itself must work even if the run ledger is unavailable.
      setContext(await fetchApprovalContext(pending.map((p) => p.id)).catch(() => new Map()));
    } catch {
      toast('Could not load pending approvals.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (entry: AgentActionLogEntry, approve: boolean) => {
    setBusyId(entry.id);
    try {
      await decideAgentAction(entry.id, approve, approve ? undefined : 'Rejected from the approvals panel');
      toast(approve ? 'Approved. The agent will continue on its next run.' : 'Rejected.', 'success');
      await load();
      onChanged?.();
    } catch {
      toast('Could not record your decision.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleTimeline = async (runId: string | undefined, id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setTimeline([]);
    if (!runId) return;
    try {
      setTimeline((await fetchRunTimeline(runId)).steps);
    } catch {
      toast('Could not load the run timeline.', 'error');
    }
  };

  return (
    <section aria-label="Pending agent approvals" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={16} className="text-cta" />
        <p className="text-sm font-semibold text-text-primary">Waiting for your approval</p>
      </div>

      {loading ? (
        <div className="flex h-16 items-center justify-center"><Loader2 className="animate-spin" /></div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-text-secondary">Nothing is waiting for approval.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map((e) => {
            const ctx = context.get(e.id);
            const state = approvalState(ctx?.step.updated_at ?? e.created_at, Date.now());
            const evidence = ctx ? summarizeToolInput(ctx.step.input) : [];
            const busy = busyId === e.id;
            return (
              <li key={e.id} className="rounded-xl border border-border bg-bg-primary p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">{e.action_slug.replace(/_/g, ' ')}</p>
                    <p className="text-xs text-text-secondary">
                      {e.agent_source} · {new Date(e.created_at).toLocaleString()}
                      {e.amount_cents ? ` · ${formatCents(e.amount_cents)}` : ''}
                    </p>
                  </div>
                  <span className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${state.expired ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500'}`}>
                    <Clock size={11} /> {state.label}
                  </span>
                </div>

                {e.reasoning && <p className="mt-2 text-text-secondary">{e.reasoning}</p>}

                {evidence.length > 0 && (
                  <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                    {evidence.map((row) => (
                      <div key={row.label} className="contents">
                        <dt className="capitalize text-text-secondary">{row.label}</dt>
                        <dd className="break-words text-text-primary">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                  {ctx?.run && <span>Run budget: {runBudgetSummary(ctx.run)}</span>}
                  <span className="flex items-center gap-1">
                    <Undo2 size={11} />
                    {e.rollback_patch ? 'Can be rolled back after it runs' : 'Cannot be rolled back once done'}
                  </span>
                </div>

                {state.expired && (
                  <p className="mt-2 text-xs text-danger">
                    This approval is too old to run safely. Reject it; the agent will plan again with current facts.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || state.expired}
                    onClick={() => decide(e, true)}
                    aria-label={`Approve ${e.action_slug.replace(/_/g, ' ')}`}
                    className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => decide(e, false)}
                    aria-label={`Reject ${e.action_slug.replace(/_/g, ' ')}`}
                    className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary disabled:opacity-50"
                  >
                    <XCircle size={12} /> Reject
                  </button>
                  {ctx && (
                    <button
                      type="button"
                      onClick={() => toggleTimeline(ctx.run?.id ?? ctx.step.run_id, e.id)}
                      aria-expanded={openId === e.id}
                      className="focus-ring ml-auto flex items-center gap-1 text-xs text-text-secondary"
                    >
                      Run timeline {openId === e.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                  )}
                </div>

                {openId === e.id && (
                  <ol className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
                    {timeline.length === 0 ? (
                      <li className="text-text-secondary">Loading…</li>
                    ) : (
                      timeline.map((s) => (
                        <li key={s.id} className="flex flex-wrap justify-between gap-2">
                          <span className="text-text-primary">{s.step_index + 1}. {s.tool.replace(/_/g, ' ')}</span>
                          <span className="text-text-secondary">
                            {stepStatusLabel(s.status)}
                            {s.attempt_count > 1 ? ` · attempt ${s.attempt_count}` : ''}
                            {s.verification === 'verified' ? ' · verified' : ''}
                            {s.error ? ` · ${s.error}` : ''}
                          </span>
                        </li>
                      ))
                    )}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
