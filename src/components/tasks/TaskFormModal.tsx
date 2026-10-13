import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  PRIORITY_LABELS,
  RECURRENCE_LABELS,
  REMINDER_PRESETS,
  STATUS_LABELS,
  TITLE_MAX,
  draftFromTask,
  emptyDraft,
  validateDraft,
  type DraftErrors,
  type TaskDraft,
  type TaskItem,
  type TaskPriority,
  type TaskRecurrence,
  type TaskStatus,
} from '@/lib/tasks';
import { createTask, updateTask, type Assignee } from '@/lib/tasksApi';
import { TaskLinkPicker } from '@/components/tasks/TaskLinkPicker';

interface LinkState {
  customer: { id: string; label: string } | null;
  job: { id: string; label: string } | null;
  lead: { id: string; label: string } | null;
}

interface Props {
  open: boolean;
  /** null = create */
  task: TaskItem | null;
  assignees: Assignee[];
  /** Managers may pick any assignee; others are locked to themselves/unassigned. */
  canAssign: boolean;
  meId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

function linksFromTask(t: TaskItem | null): LinkState {
  return {
    customer: t?.customer ? { id: t.customer.id, label: t.customer.name } : t?.customer_id ? { id: t.customer_id, label: 'Linked customer' } : null,
    job: t?.job
      ? { id: t.job.id, label: [t.job.customer_name, t.job.service_type].filter(Boolean).join(' · ') }
      : t?.job_id
        ? { id: t.job_id, label: 'Linked job' }
        : null,
    lead: t?.lead ? { id: t.lead.id, label: t.lead.name } : t?.lead_id ? { id: t.lead_id, label: 'Linked lead' } : null,
  };
}

export function TaskFormModal({ open, task, assignees, canAssign, meId, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(open);
  const [draft, setDraft] = useState<TaskDraft>(() => emptyDraft(meId));
  const [links, setLinks] = useState<LinkState>({ customer: null, job: null, lead: null });
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);

  useEscapeToClose(open && !saving, onClose);

  // Reset the form each time the dialog opens (create vs. edit).
  useEffect(() => {
    if (!open) return;
    setDraft(task ? draftFromTask(task) : emptyDraft(meId));
    setLinks(linksFromTask(task));
    setErrors({});
    setSaving(false);
  }, [open, task, meId]);

  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const assigneeOptions = useMemo(() => {
    // Keep a currently-assigned person selectable even if they are no longer listed.
    if (draft.assignedTo && !assignees.some((a) => a.userId === draft.assignedTo)) {
      return [...assignees, { userId: draft.assignedTo, name: task?.assigned_to_name ?? 'Former teammate', role: '' }];
    }
    return assignees;
  }, [assignees, draft.assignedTo, task]);

  const handleSubmit = async () => {
    if (saving) return;
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const name = draft.assignedTo ? (assigneeOptions.find((a) => a.userId === draft.assignedTo)?.name ?? task?.assigned_to_name ?? null) : null;
    setSaving(true);
    try {
      if (task) await updateTask(task.id, draft, name);
      else await createTask(draft, name);
      toast(task ? 'Task updated.' : 'Task created.', 'success');
      onSaved();
      onClose();
    } catch {
      toast('Could not save this task. Check your access and try again.', 'error');
      setSaving(false);
    }
  };

  const hasDue = draft.dueLocal !== '';

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => !saving && onClose()}
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-form-title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[101] flex max-h-[92vh] flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[92vw] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 id="task-form-title" className="text-lg font-semibold text-text-primary">
                {task ? 'Edit task' : 'New task'}
              </h2>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-5 py-5">
              <Input
                label="Title"
                required
                value={draft.title}
                maxLength={TITLE_MAX}
                placeholder="e.g. Call back about the quote"
                error={errors.title}
                onChange={(e) => set('title', e.target.value)}
                autoFocus
              />

              <Textarea
                label="Notes"
                rows={3}
                value={draft.description}
                placeholder="Optional details"
                error={errors.description}
                onChange={(e) => set('description', e.target.value)}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="task-priority" className="mb-1.5 block text-sm font-medium text-text-primary">Priority</label>
                  <select id="task-priority" className={selectClass} value={draft.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
                    {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                      <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="task-status" className="mb-1.5 block text-sm font-medium text-text-primary">Status</label>
                  <select id="task-status" className={selectClass} value={draft.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
                    {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="task-assignee" className="mb-1.5 block text-sm font-medium text-text-primary">Assignee</label>
                <select
                  id="task-assignee"
                  className={selectClass}
                  value={draft.assignedTo ?? ''}
                  onChange={(e) => set('assignedTo', e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {assigneeOptions.map((a) => (
                    <option key={a.userId} value={a.userId} disabled={!canAssign && a.userId !== meId}>
                      {a.userId === meId ? `${a.name} (me)` : a.name}
                    </option>
                  ))}
                </select>
                {!canAssign && (
                  <p className="mt-1.5 text-xs text-text-secondary">You can assign tasks to yourself or leave them unassigned.</p>
                )}
              </div>

              <Input
                label="Due"
                type="datetime-local"
                value={draft.dueLocal}
                error={errors.dueLocal}
                onChange={(e) => {
                  const value = e.target.value;
                  // Reminders and repeating only make sense with a due date.
                  setDraft((d) => (value ? { ...d, dueLocal: value } : { ...d, dueLocal: '', reminderOffset: null, recurrence: 'none', recurrenceEndsOn: '' }));
                }}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="task-reminder" className="mb-1.5 block text-sm font-medium text-text-primary">Reminder</label>
                  <select
                    id="task-reminder"
                    className={selectClass}
                    disabled={!hasDue}
                    value={draft.reminderOffset === null ? '' : String(draft.reminderOffset)}
                    onChange={(e) => set('reminderOffset', e.target.value === '' ? null : Number(e.target.value))}
                  >
                    <option value="">No reminder</option>
                    {REMINDER_PRESETS.map((p) => (
                      <option key={p.minutes} value={p.minutes}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="task-recurrence" className="mb-1.5 block text-sm font-medium text-text-primary">Repeat</label>
                  <select
                    id="task-recurrence"
                    className={selectClass}
                    disabled={!hasDue}
                    value={draft.recurrence}
                    onChange={(e) => set('recurrence', e.target.value as TaskRecurrence)}
                  >
                    {(Object.keys(RECURRENCE_LABELS) as TaskRecurrence[]).map((r) => (
                      <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
              </div>
              {!hasDue && <p className="-mt-2 text-xs text-text-secondary">Set a due date to enable reminders and repeating.</p>}

              {hasDue && draft.recurrence !== 'none' && (
                <Input
                  label="Repeat until (optional)"
                  type="date"
                  value={draft.recurrenceEndsOn}
                  error={errors.recurrenceEndsOn}
                  helperText="The next task is created when you complete this one."
                  onChange={(e) => set('recurrenceEndsOn', e.target.value)}
                />
              )}

              <fieldset className="space-y-3 rounded-xl border border-border/70 p-4">
                <legend className="px-1 text-sm font-medium text-text-primary">Related to</legend>
                {(['customer', 'job', 'lead'] as const).map((kind) => (
                  <div key={kind}>
                    <p className="mb-1 text-xs font-medium capitalize text-text-secondary">{kind}</p>
                    <TaskLinkPicker
                      kind={kind}
                      value={links[kind]}
                      disabled={saving}
                      onChange={(next) => {
                        setLinks((l) => ({ ...l, [kind]: next }));
                        set(kind === 'customer' ? 'customerId' : kind === 'job' ? 'jobId' : 'leadId', next ? next.id : null);
                      }}
                    />
                  </div>
                ))}
              </fieldset>
            </div>

            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={handleSubmit} disabled={saving}>
                {saving ? 'Saving…' : task ? 'Save changes' : 'Create task'}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
