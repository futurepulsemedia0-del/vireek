import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, ClipboardList, FileText, Plus, SkipForward, Trash2, UserPlus, Users } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ChecklistForm, type ChecklistValues } from '@/components/hr/ChecklistForm';
import { FormShell, Pill, ProgressBar, Segmented, SelectField, employeeName, type HrCtx, type Tone } from '@/components/hr/HrUi';
import { useToast } from '@/contexts/ToastContext';
import {
  CATEGORY_LABELS,
  DOC_TYPE_LABELS,
  NOTE_LIMIT,
  formatDay,
  groupTasksByCategory,
  isValidIsoDate,
  onboardingProgress,
  relativeDays,
  taskDueState,
  validateStartOnboarding,
  type HrDocument,
  type Onboarding,
  type OnboardingTask,
  type TaskDueState,
} from '@/lib/hrOnboarding';
import {
  cancelOnboarding,
  createDocumentRequest,
  createTask,
  deleteTask,
  describeHrError,
  fetchOnboarding,
  seedStarterTemplates,
  setTaskStatus,
  startOnboarding,
  updateTaskDetails,
} from '@/lib/hrOnboardingApi';

const DUE_TONE: Record<TaskDueState, Tone> = { done: 'success', skipped: 'neutral', no_date: 'neutral', overdue: 'danger', due_today: 'warning', due_soon: 'warning', upcoming: 'neutral' };

type Filter = 'active' | 'completed' | 'all';

export function OnboardingPanel({ ctx, startSignal }: { ctx: HrCtx; startSignal: number }) {
  const { data, ownerId, patch, reload } = ctx;
  const { toast } = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('active');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [lastSignal, setLastSignal] = useState(startSignal);
  const [cancelTarget, setCancelTarget] = useState<Onboarding | null>(null);
  const [seeding, setSeeding] = useState(false);

  // The page-level "Start onboarding" button bumps startSignal; open the form once per bump.
  if (startSignal !== lastSignal) {
    setLastSignal(startSignal);
    setShowStart(true);
  }

  const activeEmployeeIds = useMemo(() => new Set(data.onboardings.filter((o) => o.status === 'active').map((o) => o.employee_id)), [data.onboardings]);
  const eligible = useMemo(() => data.employees.filter((e) => e.active && !activeEmployeeIds.has(e.id)), [data.employees, activeEmployeeIds]);
  const shown = useMemo(() => data.onboardings.filter((o) => (filter === 'all' ? true : o.status === filter)), [data.onboardings, filter]);

  const seed = async () => {
    setSeeding(true);
    try {
      await seedStarterTemplates();
      await reload();
      toast('Starter templates added', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    } finally {
      setSeeding(false);
    }
  };

  const confirmCancel = async () => {
    const target = cancelTarget;
    setCancelTarget(null);
    if (!target) return;
    try {
      await cancelOnboarding(target.id, ownerId);
      patch((d) => ({ ...d, onboardings: d.onboardings.map((o) => (o.id === target.id ? { ...o, status: 'cancelled' } : o)) }));
      toast('Onboarding cancelled', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    }
  };

  if (data.employees.filter((e) => e.active).length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Add employees first"
        description="Onboarding is tracked per employee. Add your people under Payroll → Employees, then come back to start their onboarding."
        action={{ label: 'Open Payroll', onClick: () => navigate('/dashboard/payroll') }}
      />
    );
  }

  if (data.templates.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Create your first checklist template"
        description="Templates cover paperwork, tools, uniform, vehicle and training. Start from our ready-made technician and office templates, then edit them."
        action={{ label: seeding ? 'Adding…' : 'Add starter templates', onClick: () => void seed() }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Filter onboardings"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'completed', label: 'Completed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button size="sm" onClick={() => setShowStart(true)} disabled={eligible.length === 0}>
          <UserPlus size={16} aria-hidden="true" /> Start onboarding
        </Button>
      </div>

      {showStart && (
        <StartForm
          ctx={ctx}
          onClose={() => setShowStart(false)}
          onStarted={(id) => {
            setShowStart(false);
            setFilter('active');
            setExpanded(id);
          }}
        />
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title={filter === 'active' ? 'No active onboardings' : 'Nothing here yet'}
          description={eligible.length === 0 ? 'Every active employee already has an onboarding.' : 'Start an onboarding to generate a dated checklist, collect documents and schedule the 30/60/90-day reviews.'}
          action={eligible.length > 0 ? { label: 'Start onboarding', onClick: () => setShowStart(true) } : undefined}
        />
      ) : (
        <ul className="space-y-3" aria-label="Onboardings">
          {shown.map((o) => (
            <OnboardingCard
              key={o.id}
              ctx={ctx}
              onboarding={o}
              open={expanded === o.id}
              onToggle={() => setExpanded((cur) => (cur === o.id ? null : o.id))}
              onCancel={() => setCancelTarget(o)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel this onboarding?"
        description={
          cancelTarget
            ? `${employeeName(data, cancelTarget.employee_id)}'s checklist stays on record but is no longer tracked. You can start a new onboarding for them afterwards.`
            : ''
        }
        confirmLabel="Cancel onboarding"
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}

function StartForm({ ctx, onClose, onStarted }: { ctx: HrCtx; onClose: () => void; onStarted: (id: string) => void }) {
  const { data, today, reload } = ctx;
  const { toast } = useToast();
  const busy = useMemo(() => new Set(data.onboardings.filter((o) => o.status === 'active').map((o) => o.employee_id)), [data.onboardings]);
  const eligible = data.employees.filter((e) => e.active && !busy.has(e.id));
  const [draft, setDraft] = useState({ employee_id: eligible[0]?.id ?? '', template_id: data.templates[0]?.id ?? '', start_date: today });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateStartOnboarding(draft, today, busy);
  const template = data.templates.find((t) => t.id === draft.template_id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      const id = await startOnboarding(draft.employee_id, draft.template_id, draft.start_date);
      await reload();
      toast('Onboarding started — checklist, documents and reviews created', 'success');
      onStarted(id);
    } catch (err) {
      toast(describeHrError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell title="Start onboarding">
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Employee" value={draft.employee_id} error={attempted ? errors.employee_id : undefined} onChange={(e) => setDraft((d) => ({ ...d, employee_id: e.target.value }))}>
            <option value="">Choose…</option>
            {eligible.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Template" value={draft.template_id} error={attempted ? errors.template_id : undefined} onChange={(e) => setDraft((d) => ({ ...d, template_id: e.target.value }))}>
            {data.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
          <Input label="Start date" type="date" value={draft.start_date} error={attempted ? errors.start_date : undefined} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))} />
        </div>
        {template && isValidIsoDate(draft.start_date) && (
          <p className="text-sm text-text-secondary">
            Creates {template.items.length} tasks with due dates from {formatDay(draft.start_date)}, requests {template.items.filter((i) => i.document_type).length} documents and
            schedules the 30, 60 and 90-day reviews.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Starting…' : 'Start onboarding'}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}

function OnboardingCard({ ctx, onboarding, open, onToggle, onCancel }: { ctx: HrCtx; onboarding: Onboarding; open: boolean; onToggle: () => void; onCancel: () => void }) {
  const { data, today, ownerId, patch } = ctx;
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OnboardingTask | null>(null);

  const tasks = useMemo(() => data.tasks.filter((t) => t.onboarding_id === onboarding.id), [data.tasks, onboarding.id]);
  const progress = useMemo(() => onboardingProgress(tasks, today), [tasks, today]);
  const groups = useMemo(() => groupTasksByCategory(tasks), [tasks]);
  const docByTask = useMemo(() => new Map(data.documents.filter((d) => d.task_id).map((d) => [d.task_id as string, d])), [data.documents]);
  const editable = onboarding.status !== 'cancelled';

  const refreshOnboarding = async () => {
    try {
      const fresh = await fetchOnboarding(onboarding.id, ownerId);
      if (fresh) patch((d) => ({ ...d, onboardings: d.onboardings.map((o) => (o.id === fresh.id ? fresh : o)) }));
    } catch {
      /* status is re-read on the next full load */
    }
  };

  const changeStatus = async (task: OnboardingTask, status: OnboardingTask['status']) => {
    if (busyId) return;
    setBusyId(task.id);
    try {
      const saved = await setTaskStatus(task.id, ownerId, status);
      patch((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === saved.id ? saved : t)) }));
      await refreshOnboarding();
    } catch (e) {
      toast(describeHrError(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const addTask = async (v: ChecklistValues): Promise<boolean> => {
    try {
      const nextOrder = tasks.reduce((m, t) => Math.max(m, t.sort_order), 0) + 10;
      const draft = { ...v };
      const created = await createTask(ownerId, onboarding, draft, nextOrder);
      let doc: HrDocument | null = null;
      if (v.document_type) {
        doc = await createDocumentRequest(
          ownerId,
          { employee_id: onboarding.employee_id, doc_type: v.document_type, title: v.title.trim().slice(0, 120), expires_on: '', notes: '' },
          { onboarding_id: onboarding.id, task_id: created.id },
        );
      }
      patch((d) => ({ ...d, tasks: [...d.tasks, created], documents: doc ? [doc, ...d.documents] : d.documents }));
      await refreshOnboarding();
      setAdding(false);
      toast('Task added', 'success');
      return true;
    } catch (e) {
      toast(describeHrError(e), 'error');
      return false;
    }
  };

  const confirmDelete = async () => {
    const t = deleteTarget;
    setDeleteTarget(null);
    if (!t) return;
    try {
      await deleteTask(t.id, ownerId);
      patch((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id), documents: d.documents.map((x) => (x.task_id === t.id ? { ...x, task_id: null } : x)) }));
      await refreshOnboarding();
      toast('Task removed', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    }
  };

  const statusTone: Tone = onboarding.status === 'completed' ? 'success' : onboarding.status === 'cancelled' ? 'neutral' : 'accent';

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 rounded-2xl p-4 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-semibold text-text-primary">{employeeName(data, onboarding.employee_id)}</p>
            <Pill tone={statusTone}>{onboarding.status}</Pill>
            {progress.overdue > 0 && onboarding.status === 'active' && <Pill tone="danger">{progress.overdue} overdue</Pill>}
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">
            {onboarding.template_name ?? 'Custom checklist'} · started {formatDay(onboarding.start_date)} · {progress.done + progress.skipped}/{progress.total} handled
          </p>
          <div className="mt-2.5 max-w-md">
            <ProgressBar percent={progress.percent} label={`Onboarding progress, ${progress.percent} percent`} />
          </div>
        </div>
        {open ? <ChevronUp size={18} aria-hidden="true" className="shrink-0 text-text-secondary" /> : <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-text-secondary" />}
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          {groups.length === 0 && <p className="text-sm text-text-secondary">This onboarding has no tasks yet.</p>}
          {groups.map((g) => (
            <section key={g.category} aria-label={CATEGORY_LABELS[g.category]}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{CATEGORY_LABELS[g.category]}</h4>
              <ul className="space-y-2">
                {g.tasks.map((t) => {
                  const state = taskDueState(t, today);
                  const doc = docByTask.get(t.id);
                  const finished = t.status !== 'pending';
                  return (
                    <li key={t.id} className="rounded-xl border border-border bg-bg-primary p-3">
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          disabled={!editable || busyId === t.id}
                          aria-pressed={t.status === 'done'}
                          aria-label={t.status === 'done' ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
                          onClick={() => void changeStatus(t, t.status === 'done' ? 'pending' : 'done')}
                          className={`focus-ring mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
                            t.status === 'done' ? 'border-success bg-success text-white' : 'border-border text-transparent hover:border-accent'
                          }`}
                        >
                          <Check size={16} aria-hidden="true" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className={`break-words text-sm font-medium ${finished ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{t.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Pill tone={DUE_TONE[state]}>
                              {state === 'done' ? 'Done' : state === 'skipped' ? 'Skipped' : t.due_date ? `${formatDay(t.due_date, { month: 'short', day: 'numeric' })} · ${relativeDays(t.due_date, today)}` : 'No due date'}
                            </Pill>
                            {!t.required && <Pill>Optional</Pill>}
                            {t.document_type && (
                              <Pill tone={doc && doc.status !== 'requested' ? 'success' : 'warning'}>
                                <FileText size={11} aria-hidden="true" className="mr-1" />
                                {DOC_TYPE_LABELS[t.document_type]}
                                {doc && doc.status === 'requested' ? ' · needed' : ''}
                              </Pill>
                            )}
                          </div>
                          {t.description && <p className="mt-1 break-words text-xs text-text-secondary">{t.description}</p>}
                          {t.notes && <p className="mt-1 break-words text-xs italic text-text-secondary">Note: {t.notes}</p>}
                        </div>
                        {editable && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            {t.status !== 'done' && (
                              <Button variant="ghost" size="sm" className="!min-h-[36px] !px-2" disabled={busyId === t.id} aria-label={t.status === 'skipped' ? `Un-skip "${t.title}"` : `Skip "${t.title}"`} onClick={() => void changeStatus(t, t.status === 'skipped' ? 'pending' : 'skipped')}>
                                <SkipForward size={15} aria-hidden="true" />
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="!min-h-[36px] !px-2 text-xs" onClick={() => setEditId(editId === t.id ? null : t.id)}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" className="!min-h-[36px] !px-2" aria-label={`Remove "${t.title}"`} onClick={() => setDeleteTarget(t)}>
                              <Trash2 size={15} aria-hidden="true" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {editId === t.id && (
                        <TaskEditor
                          task={t}
                          onClose={() => setEditId(null)}
                          onSave={async (patchValues) => {
                            try {
                              const saved = await updateTaskDetails(t.id, ownerId, patchValues);
                              patch((d) => ({ ...d, tasks: d.tasks.map((x) => (x.id === saved.id ? saved : x)) }));
                              setEditId(null);
                              return true;
                            } catch (e) {
                              toast(describeHrError(e), 'error');
                              return false;
                            }
                          }}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {editable && (
            <div className="space-y-3">
              {adding ? (
                <ChecklistForm mode="task" heading="Add a task" submitLabel="Add task" initial={{ category: 'other', due_date: today }} onSubmit={addTask} onCancel={() => setAdding(false)} />
              ) : (
                <div className="flex flex-wrap justify-between gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                    <Plus size={16} aria-hidden="true" /> Add task
                  </Button>
                  {onboarding.status === 'active' && (
                    <Button variant="ghost" size="sm" onClick={onCancel}>
                      Cancel onboarding
                    </Button>
                  )}
                </div>
              )}
              <p className="text-xs text-text-secondary">
                Reviews for this employee are under{' '}
                <Link to="/dashboard/hr?tab=reviews" className="focus-ring rounded font-semibold text-accent hover:underline">
                  Reviews
                </Link>
                ; documents under{' '}
                <Link to="/dashboard/hr?tab=documents" className="focus-ring rounded font-semibold text-accent hover:underline">
                  Documents
                </Link>
                .
              </p>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove this task?"
        description={deleteTarget ? `"${deleteTarget.title}" will be removed from this checklist. Any document requested for it stays in Documents.` : ''}
        confirmLabel="Remove task"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </li>
  );
}

function TaskEditor({ task, onSave, onClose }: { task: OnboardingTask; onSave: (v: { due_date: string | null; notes: string }) => Promise<boolean>; onClose: () => void }) {
  const [due, setDue] = useState(task.due_date ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [saving, setSaving] = useState(false);
  const dueError = due !== '' && !isValidIsoDate(due) ? 'Enter a valid date.' : undefined;
  const notesError = notes.length > NOTE_LIMIT ? `Notes must be ${NOTE_LIMIT} characters or fewer.` : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || dueError || notesError) return;
    setSaving(true);
    try {
      await onSave({ due_date: due === '' ? null : due, notes });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-[180px_1fr]">
      <Input label="Due date" type="date" value={due} error={dueError} onChange={(e) => setDue(e.target.value)} />
      <Textarea label="Notes" rows={2} value={notes} error={notesError} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
