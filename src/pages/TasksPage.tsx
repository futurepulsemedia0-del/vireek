import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  BookUser,
  CheckCircle2,
  Circle,
  Clock,
  ListChecks,
  Lock,
  Pencil,
  Play,
  Plus,
  Repeat,
  Search,
  Trash2,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { TaskFormModal } from '@/components/tasks/TaskFormModal';
import {
  PRIORITY_LABELS,
  bucketOf,
  describeDue,
  describeRecurrence,
  describeReminder,
  filterTasks,
  summarize,
  type TaskBucket,
  type TaskItem,
  type TaskPriority,
  type TaskTab,
} from '@/lib/tasks';
import {
  completeTask,
  deleteTask,
  fetchAssignees,
  fetchTasks,
  reopenTask,
  setTaskStatus,
  type Assignee,
} from '@/lib/tasksApi';

const filterSelect =
  'focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';

const TONE_TEXT = { danger: 'text-danger', accent: 'text-accent', neutral: 'text-text-secondary' } as const;

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  normal: 'bg-bg-tertiary text-text-secondary',
  high: 'bg-warning-500/10 text-warning-500',
  urgent: 'bg-danger/10 text-danger',
};

const GROUPS: { key: Exclude<TaskBucket, 'done'>; title: string }[] = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'today', title: 'Today' },
  { key: 'upcoming', title: 'Upcoming' },
  { key: 'no_date', title: 'No due date' },
];

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface RowProps {
  task: TaskItem;
  now: Date;
  busy: boolean;
  canDelete: boolean;
  onToggle: (t: TaskItem) => void;
  onStart: (t: TaskItem) => void;
  onEdit: (t: TaskItem) => void;
  onDelete: (t: TaskItem) => void;
}

function TaskRow({ task, now, busy, canDelete, onToggle, onStart, onEdit, onDelete }: RowProps) {
  const done = task.status === 'done';
  const due = describeDue(task, now);
  const recurrence = describeRecurrence(task.recurrence, task.recurrence_ends_on);
  const reminder = describeReminder(task.reminder_offset_minutes);

  return (
    <li
      className={`rounded-2xl border border-border bg-bg-secondary p-4 shadow-card transition-opacity dark:shadow-card-dark ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? `Reopen "${task.title}"` : `Mark "${task.title}" as done`}
          disabled={busy}
          onClick={() => onToggle(task)}
          className={`focus-ring mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed ${done ? 'text-success' : 'text-text-secondary hover:text-accent'}`}
        >
          {done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm font-medium ${done ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{task.title}</p>
            {(task.priority === 'high' || task.priority === 'urgent') && !done && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY_STYLE[task.priority]}`}>
                {PRIORITY_LABELS[task.priority]}
              </span>
            )}
            {task.status === 'in_progress' && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">In progress</span>
            )}
          </div>

          {task.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{task.description}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={`flex items-center gap-1 ${done ? 'text-text-secondary' : TONE_TEXT[due.tone]}`}>
              {due.tone === 'danger' && !done ? <AlertTriangle size={12} /> : <Clock size={12} />}
              {done && task.completed_at
                ? `Done ${new Date(task.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                : due.text}
            </span>
            {task.assigned_to_name && (
              <span className="flex items-center gap-1 text-text-secondary">
                <User size={12} /> {task.assigned_to_name}
              </span>
            )}
            {recurrence && (
              <span className="flex items-center gap-1 text-text-secondary">
                <Repeat size={12} /> {recurrence}
              </span>
            )}
            {reminder && !done && (
              <span className="flex items-center gap-1 text-text-secondary">
                <Bell size={12} /> {reminder}
              </span>
            )}
          </div>

          {(task.customer_id || task.job_id || task.lead_id) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {task.customer_id && (
                <Link
                  to={`/dashboard/customers/${task.customer_id}`}
                  className="focus-ring flex max-w-full items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-accent"
                >
                  <BookUser size={11} /> <span className="truncate">{task.customer?.name ?? 'Customer'}</span>
                </Link>
              )}
              {task.job_id && (
                <Link
                  to="/dashboard/jobs"
                  className="focus-ring flex max-w-full items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-accent"
                >
                  <Wrench size={11} />{' '}
                  <span className="truncate">
                    {task.job ? [task.job.customer_name, task.job.service_type].filter(Boolean).join(' · ') : 'Job'}
                  </span>
                </Link>
              )}
              {task.lead_id && (
                <Link
                  to="/dashboard/leads"
                  className="focus-ring flex max-w-full items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-accent"
                >
                  <Users size={11} /> <span className="truncate">{task.lead?.name ?? 'Lead'}</span>
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {task.status === 'todo' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onStart(task)}
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-accent disabled:opacity-50"
              aria-label={`Start "${task.title}"`}
              title="Mark in progress"
            >
              <Play size={15} />
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(task)}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            aria-label={`Edit "${task.title}"`}
            title="Edit"
          >
            <Pencil size={15} />
          </button>
          {canDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(task)}
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              aria-label={`Delete "${task.title}"`}
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function TasksPage() {
  const { user, profile, isOwner, teamMember, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useNow(60_000);

  const resolving = profileLoading || !profile;
  const canAccess = isOwner || teamMember !== null;
  const canManage = isOwner || permissions.can_view_all_jobs;
  const meId = user?.id ?? null;
  const selfName = profile?.full_name || profile?.company_name || user?.email || 'Me';

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const [tab, setTab] = useState<TaskTab>('open');
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState<'all' | TaskPriority>('all');
  const [assignee, setAssignee] = useState('all');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TaskItem | null>(null);
  const [deleting, setDeleting] = useState<TaskItem | null>(null);

  const requestRef = useRef(0);

  const load = useCallback(
    async (silent: boolean) => {
      const requestId = ++requestRef.current;
      if (!silent) setStatus('loading');
      try {
        const rows = await fetchTasks();
        if (requestId !== requestRef.current) return;
        setTasks(rows);
        setStatus('ready');
      } catch {
        if (requestId !== requestRef.current) return;
        if (silent) toast('Could not refresh tasks.', 'error');
        else setStatus('error');
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!canAccess || !meId) return;
    void load(false);
  }, [canAccess, meId, load]);

  useEffect(() => {
    if (!canAccess || !meId) return;
    let cancelled = false;
    fetchAssignees({ userId: meId, selfName, isManager: canManage }).then((rows) => {
      if (!cancelled) setAssignees(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [canAccess, canManage, meId, selfName]);

  // Quietly refresh when the tab becomes visible again (max once / 30s).
  useEffect(() => {
    if (!canAccess) return;
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 30_000) {
        last = Date.now();
        void load(true);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [canAccess, load]);

  // Deep link from the Overview widget: /dashboard/tasks?new=1
  useEffect(() => {
    if (searchParams.get('new') === '1' && canAccess && !resolving) {
      setEditing(null);
      setFormOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, canAccess, resolving, setSearchParams]);

  const withBusy = async (id: string, fn: () => Promise<void>, failure: string) => {
    setBusyIds((s) => new Set(s).add(id));
    try {
      await fn();
      await load(true);
    } catch {
      toast(failure, 'error');
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const handleToggle = (t: TaskItem) =>
    withBusy(
      t.id,
      async () => {
        if (t.status === 'done') {
          await reopenTask(t.id);
          toast('Task reopened.', 'success');
        } else {
          const spawned = await completeTask(t);
          toast(spawned ? 'Done — the next one is scheduled.' : 'Task completed.', 'success');
        }
      },
      'Could not update this task.',
    );

  const handleStart = (t: TaskItem) =>
    withBusy(t.id, () => setTaskStatus(t.id, 'in_progress'), 'Could not update this task.');

  const confirmDelete = async () => {
    const t = deleting;
    if (!t) return;
    setDeleting(null);
    await withBusy(
      t.id,
      async () => {
        await deleteTask(t.id);
        toast('Task deleted.', 'success');
      },
      'Could not delete this task.',
    );
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const summary = useMemo(() => summarize(tasks, now), [tasks, now]);

  const visible = useMemo(
    () => filterTasks(tasks, { tab, search, priority, assignee, meId }, now),
    [tasks, tab, search, priority, assignee, meId, now],
  );

  const grouped = useMemo(() => {
    if (tab !== 'open') return null;
    return GROUPS.map((g) => ({ ...g, items: visible.filter((t) => bucketOf(t, now) === g.key) })).filter(
      (g) => g.items.length > 0,
    );
  }, [tab, visible, now]);

  const filtersActive = search.trim() !== '' || priority !== 'all' || assignee !== 'all';
  const clearFilters = () => {
    setSearch('');
    setPriority('all');
    setAssignee('all');
  };

  const TABS: { key: TaskTab; label: string; count: number }[] = [
    { key: 'open', label: 'Open', count: summary.open },
    { key: 'today', label: 'Today', count: summary.dueToday + summary.overdue },
    { key: 'overdue', label: 'Overdue', count: summary.overdue },
    { key: 'done', label: 'Done', count: summary.completedRecently },
  ];

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <ListChecks size={16} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Tasks</h1>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          {canManage ? 'Everything your team needs to get done' : 'Your tasks, in one place'}
        </p>
      </div>
      {canAccess && !resolving && (
        <Button size="sm" onClick={openCreate}>
          <Plus size={16} /> New task
        </Button>
      )}
    </div>
  );

  if (resolving) {
    return (
      <DashboardLayout activeLabel="Tasks">
        {header}
        <SkeletonStatGrid count={4} />
        <div className="mt-6">
          <SkeletonCardList count={4} />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Tasks">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Tasks are available to account owners and team members. Ask your account owner for access.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Tasks">
      {header}

      {status === 'loading' ? (
        <>
          <SkeletonStatGrid count={4} />
          <div className="mt-6">
            <SkeletonCardList count={4} />
          </div>
        </>
      ) : status === 'error' ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <AlertTriangle size={22} />
          </span>
          <h3 className="mt-4 text-base font-semibold text-text-primary">Couldn't load your tasks</h3>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">Check your connection and try again.</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load(false)}>
            Try again
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No tasks yet"
          description="Create your first task — assign it, set a due date, and link it to a customer, job or lead."
          action={{ label: 'New task', onClick: openCreate }}
        />
      ) : (
        <FadeIn>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Open', value: summary.open, icon: ListChecks, tone: 'text-accent' },
              { label: 'Due today', value: summary.dueToday, icon: Clock, tone: 'text-warning-500' },
              { label: 'Overdue', value: summary.overdue, icon: AlertTriangle, tone: 'text-danger' },
              { label: 'Done (30 days)', value: summary.completedRecently, icon: CheckCircle2, tone: 'text-success' },
            ].map((s) => (
              <div key={s.label} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                <div className={`flex items-center gap-2 ${s.tone}`}>
                  <s.icon size={14} />
                  <span className="text-xs font-medium">{s.label}</span>
                </div>
                <p className="mt-2 text-xl font-bold text-text-primary">{s.value}</p>
              </div>
            ))}
          </div>

          <div role="tablist" aria-label="Task views" className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`focus-ring shrink-0 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
                {t.count > 0 && <span className="ml-1.5 opacity-80">{t.count}</span>}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <Input
                icon={Search}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tasks, people, customers…"
                aria-label="Search tasks"
                className="!py-2.5 !text-sm"
              />
            </div>
            <select className={filterSelect} value={priority} onChange={(e) => setPriority(e.target.value as 'all' | TaskPriority)} aria-label="Filter by priority">
              <option value="all">All priorities</option>
              {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </select>
            {canManage && (
              <select className={filterSelect} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
                <option value="all">Everyone</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
                {assignees
                  .filter((a) => a.userId !== meId)
                  .map((a) => (
                    <option key={a.userId} value={a.userId}>{a.name}</option>
                  ))}
              </select>
            )}
          </div>

          <div className="mt-4" aria-live="polite">
            {visible.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title={filtersActive ? 'Nothing matches your filters' : tab === 'done' ? 'Nothing completed recently' : 'You are all caught up'}
                description={
                  filtersActive
                    ? 'Try a different search or clear the filters.'
                    : tab === 'done'
                      ? 'Tasks you complete show up here for 30 days.'
                      : 'Nothing in this view right now.'
                }
                action={filtersActive ? { label: 'Clear filters', onClick: clearFilters } : undefined}
              />
            ) : grouped ? (
              <div className="space-y-6">
                {grouped.map((g) => (
                  <section key={g.key} aria-label={g.title}>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      {g.title} <span className="font-normal opacity-70">· {g.items.length}</span>
                    </h2>
                    <ul className="space-y-2">
                      {g.items.map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          now={now}
                          busy={busyIds.has(t.id)}
                          canDelete={canManage || t.created_by === meId}
                          onToggle={handleToggle}
                          onStart={handleStart}
                          onEdit={(task) => {
                            setEditing(task);
                            setFormOpen(true);
                          }}
                          onDelete={setDeleting}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="space-y-2">
                {visible.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    now={now}
                    busy={busyIds.has(t.id)}
                    canDelete={canManage || t.created_by === meId}
                    onToggle={handleToggle}
                    onStart={handleStart}
                    onEdit={(task) => {
                      setEditing(task);
                      setFormOpen(true);
                    }}
                    onDelete={setDeleting}
                  />
                ))}
              </ul>
            )}
          </div>
        </FadeIn>
      )}

      <TaskFormModal
        open={formOpen}
        task={editing}
        assignees={assignees}
        canAssign={canManage}
        meId={meId}
        onClose={() => setFormOpen(false)}
        onSaved={() => void load(true)}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this task?"
        description={deleting ? `"${deleting.title}" will be permanently removed.` : ''}
        confirmLabel="Delete task"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
