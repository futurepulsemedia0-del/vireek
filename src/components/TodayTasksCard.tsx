import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, ListChecks, Plus, Repeat } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { describeDue, isOverdue, type TaskItem } from '@/lib/tasks';
import { completeTask, fetchTodayTasks } from '@/lib/tasksApi';

const MAX_ROWS = 5;
const TONE_TEXT = { danger: 'text-danger', accent: 'text-accent', neutral: 'text-text-secondary' } as const;

/**
 * Overview widget: open tasks due by the end of today (overdue first) that are
 * assigned to me or unassigned. RLS decides what each person may see.
 */
export function TodayTasksCard() {
  const { user, isOwner, teamMember } = useAuth();
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const userId = user?.id ?? null;
  const canAccess = isOwner || teamMember !== null;

  const load = useCallback(
    async (showSkeleton: boolean) => {
      if (!userId) return;
      const requestId = ++requestRef.current;
      if (showSkeleton) setStatus('loading');
      try {
        const rows = await fetchTodayTasks(userId);
        if (requestId !== requestRef.current) return;
        setTasks(rows);
        setStatus('ready');
      } catch {
        if (requestId === requestRef.current) setStatus('error');
      }
    },
    [userId],
  );

  useEffect(() => {
    if (canAccess) void load(true);
  }, [canAccess, load]);

  if (!canAccess) return null;

  const now = new Date();
  const overdueCount = tasks.filter((t) => isOverdue(t, now)).length;
  const shown = tasks.slice(0, MAX_ROWS);

  const handleComplete = async (t: TaskItem) => {
    if (busyId) return;
    setBusyId(t.id);
    try {
      await completeTask(t);
      setTasks((prev) => prev.filter((x) => x.id !== t.id));
      toast('Task completed.', 'success');
      void load(false); // pick up a spawned next occurrence if it is due today
    } catch {
      toast('Could not complete this task.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      aria-label="Tasks due today"
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <ListChecks size={16} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Today</h2>
            <p className="text-xs text-text-secondary/70">
              {status === 'ready' && tasks.length > 0
                ? `${tasks.length} due${overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}`
                : 'Tasks due today'}
            </p>
          </div>
        </div>
        <Link
          to="/dashboard/tasks?new=1"
          className="focus-ring flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-accent hover:bg-accent/10"
        >
          <Plus size={14} /> Add task
        </Link>
      </div>

      {status === 'loading' ? (
        <div className="mt-4 space-y-2" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-xl bg-bg-tertiary" />
          ))}
        </div>
      ) : status === 'error' ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-bg-tertiary/60 px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-text-secondary">
            <AlertTriangle size={15} className="text-danger" aria-hidden="true" /> Couldn't load tasks.
          </span>
          <button type="button" onClick={() => void load(true)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">
            Retry
          </button>
        </div>
      ) : tasks.length === 0 ? (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-bg-tertiary/60 px-4 py-3 text-sm text-text-secondary">
          <CheckCircle2 size={16} className="text-success" aria-hidden="true" />
          You're all caught up — nothing due today.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-1.5">
            {shown.map((t) => {
              const due = describeDue(t, now);
              return (
                <li key={t.id} className="flex items-center gap-3 rounded-xl bg-bg-tertiary/60 px-3 py-2.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={false}
                    aria-label={`Mark "${t.title}" as done`}
                    disabled={busyId !== null}
                    onClick={() => void handleComplete(t)}
                    className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary hover:text-accent disabled:opacity-50"
                  >
                    <Circle size={20} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{t.title}</p>
                    <p className={`flex items-center gap-1.5 truncate text-xs ${TONE_TEXT[due.tone]}`}>
                      {t.recurrence !== 'none' && <Repeat size={11} aria-label="Repeats" />}
                      {due.text}
                      {t.customer?.name ? <span className="text-text-secondary"> · {t.customer.name}</span> : null}
                    </p>
                  </div>
                  {(t.priority === 'urgent' || t.priority === 'high') && (
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${t.priority === 'urgent' ? 'bg-danger' : 'bg-warning-500'}`}
                      title={t.priority === 'urgent' ? 'Urgent' : 'High priority'}
                      role="img"
                      aria-label={t.priority === 'urgent' ? 'Urgent' : 'High priority'}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <Link
            to="/dashboard/tasks"
            className="focus-ring mt-3 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-accent hover:underline"
          >
            {tasks.length > MAX_ROWS ? `View all ${tasks.length} tasks` : 'Open tasks'} <ArrowRight size={12} />
          </Link>
        </>
      )}
    </motion.section>
  );
}
