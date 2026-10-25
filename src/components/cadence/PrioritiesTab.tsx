import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Link2, Pencil, Plus, Trash2, Flag as FlagIcon } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { CadenceModal, ErrorBlock, cardClass, errMsg, iconBtn, labelClass, selectClass, type TabProps } from '@/components/cadence/shared';
import {
  isOverdue,
  quarterEnd,
  quarterLabel,
  quarterStart,
  sortPriorities,
  validatePriority,
  type Priority,
  type PriorityDraft,
  type PriorityErrors,
  type PriorityStatus,
} from '@/lib/cadence';
import {
  createPriority,
  deletePriority,
  fetchGoals,
  fetchPriorities,
  setPriorityProgress,
  updatePriority,
  type GoalOption,
} from '@/lib/cadenceApi';

type Filter = 'active' | 'done' | 'all';

const STATUS_STYLE: Record<PriorityStatus, string> = {
  on_track: 'bg-success-500/10 text-success-500',
  off_track: 'bg-danger-500/10 text-danger-500',
  done: 'bg-bg-tertiary text-text-secondary',
};
const STATUS_LABEL: Record<PriorityStatus, string> = { on_track: 'On track', off_track: 'Off track', done: 'Done' };

export function PrioritiesTab({ canManage, today, meId, assignees }: TabProps) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [items, setItems] = useState<Priority[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [form, setForm] = useState<{ open: boolean; item: Priority | null }>({ open: false, item: null });
  const [removing, setRemoving] = useState<Priority | null>(null);

  const qStart = quarterStart(today);

  const load = useCallback(
    async (skeleton: boolean) => {
      if (skeleton) setState('loading');
      try {
        const [p, g] = await Promise.all([fetchPriorities(qStart), fetchGoals()]);
        setItems(p);
        setGoals(g);
        setState('ready');
      } catch (e) {
        setError(errMsg(e));
        setState('error');
      }
    },
    [qStart],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const goalById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  const shown = useMemo(() => {
    const f = items.filter((p) => (filter === 'all' ? true : filter === 'done' ? p.status === 'done' : p.status !== 'done'));
    return sortPriorities(f, today);
  }, [items, filter, today]);

  const update = async (p: Priority, status: PriorityStatus, progress: number) => {
    const prev = items;
    setItems((cur) => cur.map((x) => (x.id === p.id ? { ...x, status, progress_pct: status === 'done' ? 100 : progress } : x)));
    try {
      await setPriorityProgress(p.id, status, progress);
    } catch (e) {
      setItems(prev);
      toast(errMsg(e, 'Could not update the priority.'), 'error');
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await deletePriority(removing.id);
      toast('Priority deleted.', 'success');
      setRemoving(null);
      void load(false);
    } catch (e) {
      toast(errMsg(e, 'Could not delete the priority.'), 'error');
    }
  };

  if (state === 'loading') return <SkeletonCardList count={3} />;
  if (state === 'error') return <ErrorBlock message={error} onRetry={() => void load(true)} />;

  return (
    <FadeIn>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border bg-bg-secondary p-1" role="tablist" aria-label="Priority filter">
          {(['active', 'done', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`focus-ring min-h-[36px] rounded-lg px-3.5 text-sm font-medium capitalize transition-colors ${filter === f ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-secondary">{quarterLabel(today)}</span>
          {canManage && (
            <Button size="sm" onClick={() => setForm({ open: true, item: null })}>
              <Plus size={16} /> New priority
            </Button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={FlagIcon}
          title={filter === 'done' ? 'Nothing completed yet' : 'No priorities for this quarter'}
          description="Pick the 3–7 things that matter most this quarter, give each one an owner and a due date."
          action={canManage && filter !== 'done' ? { label: 'Add a priority', onClick: () => setForm({ open: true, item: null }) } : undefined}
        />
      ) : (
        <ul className="space-y-3" aria-live="polite">
          {shown.map((p) => {
            const overdue = isOverdue(p, today);
            const goal = p.goal_id ? goalById.get(p.goal_id) : undefined;
            const canReport = canManage || p.owner_user_id === meId;
            return (
              <li key={p.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                      {overdue && <span className="rounded-full bg-danger-500/10 px-2.5 py-0.5 text-xs font-semibold text-danger-500">Overdue</span>}
                    </div>
                    <h3 className="mt-1.5 text-base font-semibold text-text-primary">{p.title}</h3>
                    {p.description && <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{p.description}</p>}
                    <p className="mt-2 text-xs text-text-secondary">
                      {p.owner_name ?? 'Unassigned'} · due {p.due_date}
                      {goal && (
                        <span className="ml-2 inline-flex items-center gap-1 text-accent">
                          <Link2 size={12} /> Goal: {goal.vision.length > 48 ? `${goal.vision.slice(0, 48)}…` : goal.vision} ({Math.round(goal.progress_pct)}%)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {canReport && p.status !== 'done' && (
                      <button type="button" onClick={() => void update(p, 'done', 100)} aria-label={`Mark ${p.title} done`} title="Mark done" className={`${iconBtn} hover:text-success-500`}>
                        <CheckCircle2 size={16} />
                      </button>
                    )}
                    {canManage && (
                      <>
                        <button type="button" onClick={() => setForm({ open: true, item: p })} aria-label={`Edit ${p.title}`} title="Edit" className={iconBtn}>
                          <Pencil size={15} />
                        </button>
                        <button type="button" onClick={() => setRemoving(p)} aria-label={`Delete ${p.title}`} title="Delete" className={`${iconBtn} hover:text-danger-500`}>
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-4">
                  <ProgressControl priority={p} disabled={!canReport} onCommit={(status, pct) => void update(p, status, pct)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <PriorityForm
        open={form.open}
        item={form.item}
        goals={goals}
        assignees={assignees}
        defaultDue={quarterEnd(today)}
        onClose={() => setForm({ open: false, item: null })}
        onSaved={() => {
          setForm({ open: false, item: null });
          toast('Priority saved.', 'success');
          void load(false);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Delete this priority?"
        description="It will be removed for everyone. This can’t be undone."
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </FadeIn>
  );
}

function ProgressControl({ priority, disabled, onCommit }: { priority: Priority; disabled: boolean; onCommit: (status: PriorityStatus, pct: number) => void }) {
  const [pct, setPct] = useState(priority.progress_pct);
  useEffect(() => setPct(priority.progress_pct), [priority.progress_pct]);
  const id = `prio-${priority.id}`;
  const commit = () => pct !== priority.progress_pct && onCommit(priority.status === 'done' ? 'on_track' : priority.status, pct);
  return (
    <>
      <div className="flex min-w-[200px] flex-1 items-center gap-3">
        <label htmlFor={id} className="sr-only">
          Progress for {priority.title}
        </label>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          disabled={disabled || priority.status === 'done'}
          onChange={(e) => setPct(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="focus-ring h-2 w-full cursor-pointer accent-accent disabled:cursor-not-allowed"
        />
        <span className="w-10 text-right text-sm font-semibold tabular-nums text-text-primary">{pct}%</span>
      </div>
      {!disabled && priority.status !== 'done' && (
        <select
          aria-label={`Status of ${priority.title}`}
          value={priority.status}
          onChange={(e) => onCommit(e.target.value as PriorityStatus, pct)}
          className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
        >
          <option value="on_track">On track</option>
          <option value="off_track">Off track</option>
        </select>
      )}
    </>
  );
}

function PriorityForm({
  open,
  item,
  goals,
  assignees,
  defaultDue,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: Priority | null;
  goals: GoalOption[];
  assignees: TabProps['assignees'];
  defaultDue: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<PriorityDraft>({ title: '', description: '', ownerUserId: '', dueDate: defaultDue, goalId: '' });
  const [errors, setErrors] = useState<PriorityErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setDraft(
      item
        ? { title: item.title, description: item.description ?? '', ownerUserId: item.owner_user_id ?? '', dueDate: item.due_date, goalId: item.goal_id ?? '' }
        : { title: '', description: '', ownerUserId: '', dueDate: defaultDue, goalId: '' },
    );
  }, [open, item, defaultDue]);

  const set = <K extends keyof PriorityDraft>(k: K, v: PriorityDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (busy) return;
    const errs = validatePriority(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const owner = assignees.find((a) => a.userId === draft.ownerUserId);
    const input = {
      title: draft.title,
      description: draft.description.trim() || null,
      owner_user_id: owner?.userId ?? null,
      owner_name: owner?.name ?? null,
      due_date: draft.dueDate,
      goal_id: draft.goalId || null,
    };
    setBusy(true);
    try {
      if (item) await updatePriority(item.id, input);
      else await createPriority(input);
      onSaved();
    } catch (e) {
      toast(errMsg(e, 'Could not save the priority.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CadenceModal open={open} title={item ? 'Edit priority' : 'New priority'} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        {goals.length > 0 && (
          <div>
            <label htmlFor="prio-goal" className={labelClass}>
              Linked goal (optional)
            </label>
            <select
              id="prio-goal"
              className={selectClass}
              value={draft.goalId}
              onChange={(e) => {
                const g = goals.find((x) => x.id === e.target.value);
                setDraft((d) => ({ ...d, goalId: e.target.value, title: d.title.trim() || !g ? d.title : g.vision.slice(0, 200) }));
              }}
            >
              <option value="">No linked goal</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.vision.length > 70 ? `${g.vision.slice(0, 70)}…` : g.vision}
                </option>
              ))}
            </select>
          </div>
        )}
        <Input label="Priority" required maxLength={200} value={draft.title} error={errors.title} onChange={(e) => set('title', e.target.value)} />
        <Textarea label="What does done look like? (optional)" rows={3} maxLength={4000} value={draft.description} error={errors.description} onChange={(e) => set('description', e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="prio-owner" className={labelClass}>
              Owner
            </label>
            <select id="prio-owner" className={selectClass} value={draft.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)}>
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Input label="Due date" type="date" required value={draft.dueDate} error={errors.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save priority'}
          </Button>
        </div>
      </div>
    </CadenceModal>
  );
}
