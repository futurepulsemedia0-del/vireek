import { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { Pill } from '@/components/tradePacks/shared';
import {
  completeVisit,
  countVisitPhotos,
  friendlyLandscapingError,
  listVisitTasks,
  setTask,
  startVisit,
  type VisitTask,
  type VisitWithContext,
} from '@/lib/landscapingApi';

/** Per-visit checklist with before/after photo gate. Photos themselves are uploaded on the job (existing gallery). */
export function VisitChecklist({ ownerId, visit, onChanged }: { ownerId: string; visit: VisitWithContext; onChanged: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<VisitTask[] | null>(null);
  const [photos, setPhotos] = useState<{ before: number; after: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naFor, setNaFor] = useState<string | null>(null);
  const [naNote, setNaNote] = useState('');
  const open = visit.status === 'scheduled' || visit.status === 'in_progress';

  const load = async () => {
    try {
      setError(null);
      const [t, p] = await Promise.all([listVisitTasks(ownerId, visit.id), visit.job_id ? countVisitPhotos(ownerId, visit.job_id) : Promise.resolve({ before: 0, after: 0 })]);
      setTasks(t);
      setPhotos(p);
    } catch (e) {
      setError(friendlyLandscapingError(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit.id, visit.job_id]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
      onChanged();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p role="alert" className="text-sm text-danger">{error} <button className="underline" onClick={() => void load()}>Retry</button></p>;
  if (!tasks) return <div aria-busy="true"><Skeleton className="h-16 w-full" /></div>;

  const requiredOpen = tasks.filter((t) => t.required && t.state === 'todo').length;
  const photosOk = !!photos && photos.before > 0 && photos.after > 0;

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
      {tasks.length === 0 ? (
        <p className="text-sm text-text-secondary">This contract has no checklist tasks.</p>
      ) : (
        <ul className="space-y-2" aria-label="Visit checklist">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={t.state === 'done'}
                  disabled={!open || busy}
                  onChange={(e) => void run(() => setTask(visit.id, t.task_key, e.target.checked ? 'done' : 'todo', null))}
                />
                <span className={t.state === 'na' ? 'text-text-secondary line-through' : ''}>{t.label}</span>
                {t.required && <Pill tone="neutral">required</Pill>}
                {t.state === 'na' && <Pill tone="warning">n/a{t.note ? `: ${t.note}` : ''}</Pill>}
              </label>
              {open && t.state !== 'na' && (
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setNaFor(t.task_key); setNaNote(''); }}>Not applicable</Button>
              )}
              {naFor === t.task_key && (
                <div className="flex w-full items-end gap-2">
                  <Input label="Why does it not apply?" value={naNote} onChange={(e) => setNaNote(e.target.value)} maxLength={500} />
                  <Button size="sm" disabled={busy || naNote.trim().length < 3} onClick={() => void run(async () => { await setTask(visit.id, t.task_key, 'na', naNote.trim()); setNaFor(null); })}>Save</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Camera className="h-4 w-4 text-text-secondary" aria-hidden="true" />
        <Pill tone={photos && photos.before > 0 ? 'success' : 'warning'}>Before: {photos?.before ?? 0}</Pill>
        <Pill tone={photos && photos.after > 0 ? 'success' : 'warning'}>After: {photos?.after ?? 0}</Pill>
        {visit.job_id ? (
          <Link className="text-accent underline" to={`/dashboard/jobs/${visit.job_id}`}>Add photos on the job</Link>
        ) : (
          <span className="text-warning">No job yet — re-route or reassign this visit</span>
        )}
      </div>

      {open && (
        <div className="flex flex-wrap gap-2">
          {visit.status === 'scheduled' && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => startVisit(visit.id), 'Visit started')}>
              <Play className="mr-1 h-4 w-4" aria-hidden="true" />Start
            </Button>
          )}
          <Button size="sm" loading={busy} disabled={requiredOpen > 0} onClick={() => void run(() => completeVisit(visit.id), 'Visit completed')}>
            <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />Complete
          </Button>
          {requiredOpen > 0 && <span className="self-center text-xs text-text-secondary">{requiredOpen} required task(s) open</span>}
          {requiredOpen === 0 && !photosOk && <span className="self-center text-xs text-text-secondary">Before + after photos are required if the contract says so.</span>}
        </div>
      )}
    </div>
  );
}
