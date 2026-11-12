import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { listCsTasks, updateCsTask, type CsTaskChange } from '@/lib/csTasksApi';
import { dueLabel, type CsTask } from '@/lib/csTasks';

interface CsTasksPanelProps {
  /** account id -> display name, from the at-risk rows. */
  labels: Record<string, string>;
  /** Bumped by the parent after a sync so the list reloads. */
  version: number;
  onOpen: (accountId: string) => void;
}

/** Staff-only follow-up tasks created from at-risk accounts. Renders nothing while the `cs_auto_tasks` flag is off. */
export function CsTasksPanel({ labels, version, onOpen }: CsTasksPanelProps) {
  const [tasks, setTasks] = useState<CsTask[] | null>(null);
  const [state, setState] = useState<'loading' | 'off' | 'error' | 'ready'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);

  const load = useCallback(async () => {
    const r = await listCsTasks();
    if (r.ok) {
      setTasks(r.tasks);
      setState('ready');
    } else {
      setState(r.reason === 'flag_off' ? 'off' : 'error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const act = async (id: string, change: CsTaskChange) => {
    setBusy(id);
    setActionError(false);
    try {
      await updateCsTask(id, change);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setBusy(null);
    }
  };

  if (state === 'off') return null;
  if (state === 'loading') {
    return <Card className="space-y-2 p-4 hover:translate-y-0" aria-busy="true"><Skeleton className="h-4 w-40" /><Skeleton className="h-10 w-full" /></Card>;
  }
  if (state === 'error' || !tasks) {
    return (
      <Card className="flex items-center justify-between gap-3 p-4 hover:translate-y-0">
        <p className="text-xs text-text-secondary">Follow-up tasks couldn’t be loaded.</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>
      </Card>
    );
  }
  if (tasks.length === 0) {
    return <Card className="p-4 hover:translate-y-0"><p className="text-xs text-text-secondary">No open follow-up tasks.</p></Card>;
  }

  return (
    <Card className="space-y-3 p-4 hover:translate-y-0">
      <h3 className="text-sm font-semibold text-text-primary">Follow-up tasks · {tasks.length}</h3>
      {actionError && <p role="alert" className="text-xs text-warning-500">That change didn’t save. Nothing was changed; try again.</p>}
      <ul className="space-y-2">
        {tasks.map((t) => {
          const due = dueLabel(t.dueAt);
          const disabled = busy === t.id;
          return (
            <li key={t.id} className="rounded-xl border border-border bg-bg-secondary p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <button type="button" onClick={() => onOpen(t.accountId)} className="focus-ring min-w-0 text-left">
                  <span className="block truncate text-sm font-medium text-text-primary">{labels[t.accountId] ?? t.title}</span>
                  <span className="block text-[11px] text-text-secondary">
                    <span className="capitalize">{t.riskLevel}</span> risk · <span className={due.overdue ? 'font-medium text-warning-500' : ''}>{due.text}</span> · {t.status === 'in_progress' ? 'In progress' : 'Open'} · {t.mine ? 'Assigned to you' : t.assigned ? 'Assigned' : 'Unassigned'}
                  </span>
                </button>
                <span className="flex flex-wrap gap-1.5">
                  {!t.mine && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void act(t.id, { assignMe: true })}>Assign to me</Button>}
                  {t.status === 'open' && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void act(t.id, { status: 'in_progress' })}>Start</Button>}
                  <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => void act(t.id, { status: 'done' })}>Done</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void act(t.id, { status: 'dismissed' })}>Dismiss</Button>
                </span>
              </div>
              {t.suggestedAction && <p className="mt-1.5 text-xs text-accent">Next: {t.suggestedAction}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
