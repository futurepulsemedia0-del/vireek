import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertOctagon, CheckCircle2, Gavel, MessageCircle, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { EscalateToIssueButton } from '@/components/cadence/EscalateToIssueButton';
import { CadenceModal, ErrorBlock, cardClass, errMsg, iconBtn, labelClass, selectClass, type TabProps } from '@/components/cadence/shared';
import { fetchTodayActions, CATEGORY_META, type NextBestAction } from '@/lib/nextBestActions';
import {
  impactToCents,
  isLive,
  parseAmountLabel,
  rankIssues,
  validateIssue,
  METRIC_BY_KEY,
  type Issue,
  type IssueDraft,
  type IssueErrors,
  type IssueSource,
} from '@/lib/cadence';
import { createIssue, deleteIssue, fetchIssues, updateIssue } from '@/lib/cadenceApi';

type View = 'live' | 'closed';

const SOURCE_LABEL: Record<IssueSource, string> = {
  manual: 'Added manually',
  alert: 'From an alert',
  kpi_miss: 'KPI miss',
  comment: 'From a comment',
  next_best_action: 'Next best action',
};

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function IssuesTab({ canManage, meId, assignees }: TabProps) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [suggestions, setSuggestions] = useState<NextBestAction[]>([]);
  const [view, setView] = useState<View>('live');
  const [form, setForm] = useState<{ open: boolean; item: Issue | null }>({ open: false, item: null });
  const [solving, setSolving] = useState<Issue | null>(null);
  const [removing, setRemoving] = useState<Issue | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState('loading');
    try {
      // Next-best-action suggestions carry dollar figures: managers only.
      const [i, nba] = await Promise.all([
        fetchIssues(),
        canManage ? fetchTodayActions().catch(() => [] as NextBestAction[]) : Promise.resolve([] as NextBestAction[]),
      ]);
      setIssues(i);
      setSuggestions(nba.filter((a) => a.status === 'open').slice(0, 5));
      setState('ready');
    } catch (e) {
      setError(errMsg(e));
      setState('error');
    }
  }, [canManage]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const live = useMemo(() => rankIssues(issues), [issues]);
  const closed = useMemo(() => issues.filter((i) => !isLive(i)).sort((a, b) => (b.solved_at ?? '').localeCompare(a.solved_at ?? '')), [issues]);
  const totalImpact = live.reduce((s, i) => s + (i.impact_cents ?? 0), 0);
  const canEdit = (i: Issue) => canManage || i.owner_user_id === meId || i.created_by === meId;
  const escalatedRefs = new Set(issues.filter(isLive).filter((i) => i.source_type === 'next_best_action').map((i) => i.source_ref));

  const patch = async (i: Issue, p: Parameters<typeof updateIssue>[1], okMsg?: string) => {
    if (busyId) return;
    setBusyId(i.id);
    try {
      await updateIssue(i.id, p);
      if (okMsg) toast(okMsg, 'success');
      await load(false);
    } catch (e) {
      toast(errMsg(e, 'Could not update the issue.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await deleteIssue(removing.id);
      toast('Issue deleted.', 'success');
      setRemoving(null);
      await load(false);
    } catch (e) {
      toast(errMsg(e, 'Could not delete the issue.'), 'error');
    }
  };

  if (state === 'loading') return <SkeletonCardList count={4} />;
  if (state === 'error') return <ErrorBlock message={error} onRetry={() => void load(true)} />;

  const list = view === 'live' ? live : closed;

  return (
    <FadeIn>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border bg-bg-secondary p-1" role="tablist" aria-label="Issue filter">
          {(['live', 'closed'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`focus-ring min-h-[36px] rounded-lg px-3.5 text-sm font-medium transition-colors ${view === v ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {v === 'live' ? `Open (${live.length})` : `Closed (${closed.length})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {view === 'live' && totalImpact > 0 && (
            <span className="text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">{money(totalImpact)}</span> total impact
            </span>
          )}
          <Button size="sm" onClick={() => setForm({ open: true, item: null })}>
            <Plus size={16} /> New issue
          </Button>
        </div>
      </div>

      {view === 'live' && suggestions.length > 0 && (
        <section className={`${cardClass} mb-4`} aria-label="Suggestions from next best actions">
          <h3 className="text-sm font-semibold text-text-primary">Today’s next best actions</h3>
          <p className="mt-0.5 text-xs text-text-secondary">Escalate anything that needs a team decision instead of a quick fix.</p>
          <ul className="mt-3 divide-y divide-border">
            {suggestions.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{a.title}</p>
                  <p className="text-xs text-text-secondary">
                    {CATEGORY_META[a.category].label}
                    {a.amount_label ? ` · ${a.amount_label}` : ''}
                  </p>
                </div>
                {escalatedRefs.has(a.id) ? (
                  <span className="text-xs font-medium text-text-secondary">On the list</span>
                ) : (
                  <EscalateToIssueButton
                    title={a.title}
                    description={`${a.reasoning}\n\nRecommended: ${a.recommended_action}`.slice(0, 4000)}
                    sourceType="next_best_action"
                    sourceRef={a.id}
                    impactCents={parseAmountLabel(a.amount_label)}
                    onDone={() => void load(false)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={AlertOctagon}
          title={view === 'live' ? 'No open issues' : 'No closed issues yet'}
          description={view === 'live' ? 'Anything that’s slowing the business down goes here — from a KPI miss, an alert, or just a hunch.' : 'Solved and dropped issues show up here.'}
          action={view === 'live' ? { label: 'Add an issue', onClick: () => setForm({ open: true, item: null }) } : undefined}
        />
      ) : (
        <ol className="space-y-3" aria-live="polite">
          {list.map((i, idx) => {
            const editable = canEdit(i);
            const busy = busyId === i.id;
            return (
              <li key={i.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {view === 'live' && <span className="font-bold text-text-secondary">#{idx + 1}</span>}
                      <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 font-medium text-text-secondary">{SOURCE_LABEL[i.source_type]}</span>
                      {i.metric_key && <span className="rounded-full bg-accent/10 px-2.5 py-0.5 font-medium text-accent">{METRIC_BY_KEY[i.metric_key].label}</span>}
                      {i.needs_decision && isLive(i) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2.5 py-0.5 font-semibold text-warning-500">
                          <Gavel size={11} /> Decision needed
                        </span>
                      )}
                      {i.status === 'discussing' && <span className="rounded-full bg-accent/10 px-2.5 py-0.5 font-semibold text-accent">Discussing</span>}
                      {i.status === 'solved' && <span className="rounded-full bg-success-500/10 px-2.5 py-0.5 font-semibold text-success-500">Solved</span>}
                      {i.status === 'dropped' && <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 font-semibold text-text-secondary">Dropped</span>}
                    </div>
                    <h3 className="mt-1.5 text-base font-semibold text-text-primary">{i.title}</h3>
                    {i.description && <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{i.description}</p>}
                    {i.resolution && (
                      <p className="mt-2 rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
                        <span className="font-semibold">Resolution: </span>
                        {i.resolution}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-text-secondary">
                      {i.owner_name ?? 'No owner'} · {i.impact_cents !== null ? <span className="font-semibold text-text-primary">{money(i.impact_cents)} impact</span> : 'Impact not estimated'}
                    </p>
                  </div>

                  {editable && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isLive(i) ? (
                        <>
                          {i.status === 'open' && (
                            <button type="button" disabled={busy} onClick={() => void patch(i, { status: 'discussing' })} aria-label={`Start discussing ${i.title}`} title="Start discussing" className={iconBtn}>
                              <MessageCircle size={15} />
                            </button>
                          )}
                          <button type="button" disabled={busy} onClick={() => setSolving(i)} aria-label={`Solve ${i.title}`} title="Mark solved" className={`${iconBtn} hover:text-success-500`}>
                            <CheckCircle2 size={16} />
                          </button>
                          <button type="button" disabled={busy} onClick={() => void patch(i, { status: 'dropped' }, 'Issue dropped.')} aria-label={`Drop ${i.title}`} title="Drop" className={iconBtn}>
                            <XCircle size={16} />
                          </button>
                        </>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => void patch(i, { status: 'open' }, 'Issue reopened.')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                          Reopen
                        </button>
                      )}
                      <button type="button" onClick={() => setForm({ open: true, item: i })} aria-label={`Edit ${i.title}`} title="Edit" className={iconBtn}>
                        <Pencil size={15} />
                      </button>
                      {canManage && (
                        <button type="button" onClick={() => setRemoving(i)} aria-label={`Delete ${i.title}`} title="Delete" className={`${iconBtn} hover:text-danger-500`}>
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <IssueForm
        open={form.open}
        item={form.item}
        assignees={assignees}
        canManage={canManage}
        onClose={() => setForm({ open: false, item: null })}
        onSaved={() => {
          setForm({ open: false, item: null });
          toast('Issue saved.', 'success');
          void load(false);
        }}
      />
      <SolveModal
        issue={solving}
        onClose={() => setSolving(null)}
        onSolve={async (resolution) => {
          if (!solving) return;
          await patch(solving, { status: 'solved', resolution: resolution.trim() || null }, 'Issue solved.');
          setSolving(null);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Delete this issue?"
        description="It will be removed for everyone. Solving or dropping keeps the history instead."
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </FadeIn>
  );
}

function SolveModal({ issue, onClose, onSolve }: { issue: Issue | null; onClose: () => void; onSolve: (resolution: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (issue) setText(issue.resolution ?? '');
  }, [issue]);
  return (
    <CadenceModal open={issue !== null} title="Mark as solved" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Textarea label="How was it solved? (optional)" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSolve(text);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Mark solved'}
          </Button>
        </div>
      </div>
    </CadenceModal>
  );
}

function IssueForm({
  open,
  item,
  assignees,
  canManage,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: Issue | null;
  assignees: TabProps['assignees'];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const blank: IssueDraft = { title: '', description: '', impact: '', needsDecision: false, ownerUserId: '' };
  const [draft, setDraft] = useState<IssueDraft>(blank);
  const [errors, setErrors] = useState<IssueErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setDraft(
      item
        ? {
            title: item.title,
            description: item.description ?? '',
            impact: item.impact_cents !== null ? String(item.impact_cents / 100) : '',
            needsDecision: item.needs_decision,
            ownerUserId: item.owner_user_id ?? '',
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);

  const set = <K extends keyof IssueDraft>(k: K, v: IssueDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  // Members can raise issues and flag decisions; owner and dollar impact are manager-set.
  const lockedFields = Boolean(item) && !canManage;

  const save = async () => {
    if (busy) return;
    const errs = validateIssue(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const owner = assignees.find((a) => a.userId === draft.ownerUserId);
    setBusy(true);
    try {
      if (item) {
        await updateIssue(item.id, {
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          needs_decision: draft.needsDecision,
          ...(canManage ? { impact_cents: impactToCents(draft.impact), owner_user_id: owner?.userId ?? null, owner_name: owner?.name ?? null } : {}),
        });
      } else {
        await createIssue({
          title: draft.title,
          description: draft.description.trim() || null,
          impact_cents: impactToCents(draft.impact),
          needs_decision: draft.needsDecision,
          owner_user_id: owner?.userId ?? null,
          owner_name: owner?.name ?? null,
        });
      }
      onSaved();
    } catch (e) {
      toast(errMsg(e, 'Could not save the issue.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CadenceModal open={open} title={item ? 'Edit issue' : 'New issue'} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Input label="Issue" required maxLength={200} value={draft.title} error={errors.title} onChange={(e) => set('title', e.target.value)} />
        <Textarea label="Details (optional)" rows={3} maxLength={4000} value={draft.description} error={errors.description} onChange={(e) => set('description', e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Dollar impact (optional)"
            inputMode="decimal"
            placeholder="e.g. 5000"
            value={draft.impact}
            error={errors.impact}
            disabled={lockedFields}
            onChange={(e) => set('impact', e.target.value)}
          />
          <div>
            <label htmlFor="issue-owner" className={labelClass}>
              Owner
            </label>
            <select id="issue-owner" className={selectClass} value={draft.ownerUserId} disabled={lockedFields} onChange={(e) => set('ownerUserId', e.target.value)}>
              <option value="">No owner yet</option>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-text-primary">
          <input type="checkbox" className="focus-ring h-5 w-5 rounded border-border accent-accent" checked={draft.needsDecision} onChange={(e) => set('needsDecision', e.target.checked)} />
          This needs a decision in the weekly meeting
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save issue'}
          </Button>
        </div>
      </div>
    </CadenceModal>
  );
}
