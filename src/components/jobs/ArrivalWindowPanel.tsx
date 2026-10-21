import { useCallback, useEffect, useState } from 'react';
import { BellRing, Clock } from 'lucide-react';
import {
  fetchWindowNotifications,
  setJobArrivalWindow,
  type SetWindowStatus,
  type WindowNotificationRow,
} from '@/lib/arrivalWindowsApi';
import {
  formatLength,
  formatWindowDay,
  formatWindowRange,
  narrowArrivalWindow,
  narrowingChoices,
} from '@/lib/arrivalWindows';

/** The few job fields this panel needs (Job from '@/lib/supabase' satisfies it). */
export interface ArrivalWindowJob {
  id: string;
  job_status: string;
  scheduled_datetime: string | null;
  arrival_window_start?: string | null;
  arrival_window_end?: string | null;
  arrival_window_original_start?: string | null;
  arrival_window_original_end?: string | null;
  arrival_window_narrowed_at?: string | null;
}

const ERRORS: Partial<Record<SetWindowStatus, string>> = {
  not_editable: 'This job is no longer scheduled, so its window cannot change.',
  invalid_window: 'Windows must be between 1 and 4 hours.',
  anchor_outside_window: 'The planned arrival time would fall outside that window.',
  error: 'Could not update the window. Try again.',
};

const KIND_LABEL = { confirmed: 'Booking confirmation', narrowed: 'Window narrowed', changed: 'Window changed' } as const;

export function ArrivalWindowPanel({ job, onChanged }: { job: ArrivalWindowJob; onChanged?: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [log, setLog] = useState<WindowNotificationRow[]>([]);

  const hasWindow = !!(job.arrival_window_start && job.arrival_window_end);
  const refreshLog = useCallback(() => {
    fetchWindowNotifications(job.id).then(setLog).catch(() => setLog([]));
  }, [job.id]);

  useEffect(() => {
    if (hasWindow) refreshLog();
  }, [hasWindow, job.arrival_window_start, job.arrival_window_end, refreshLog]);

  if (!hasWindow) return null;

  const current = { start: new Date(job.arrival_window_start as string), end: new Date(job.arrival_window_end as string) };
  const original =
    job.arrival_window_original_start && job.arrival_window_original_end
      ? { start: new Date(job.arrival_window_original_start), end: new Date(job.arrival_window_original_end) }
      : null;
  const editable = job.job_status === 'scheduled' || job.job_status === 'en_route';
  const anchor = job.scheduled_datetime ? new Date(job.scheduled_datetime) : current.start;
  const choices = editable ? narrowingChoices(current) : [];

  const narrowTo = async (minutes: number) => {
    setBusy(minutes);
    setMessage(null);
    const status = await setJobArrivalWindow(job.id, narrowArrivalWindow(current, anchor, minutes));
    setBusy(null);
    if (status === 'ok') {
      setMessage('Window updated. The customer will be notified in about 2 minutes.');
      onChanged?.();
      refreshLog();
    } else if (status !== 'unchanged') {
      setMessage(ERRORS[status] ?? ERRORS.error ?? null);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Arrival window">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Clock size={15} className="text-accent" aria-hidden /> Arrival window
      </h3>
      <p className="mt-2 text-lg font-semibold text-text-primary">
        {formatWindowDay(current.start)}, {formatWindowRange(current)}
      </p>
      {original && job.arrival_window_narrowed_at && (
        <p className="mt-1 text-xs text-text-secondary">Booked as {formatWindowRange(original)}; narrowed on dispatch.</p>
      )}

      {choices.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-text-secondary">Narrow to</p>
          <div className="flex flex-wrap gap-2">
            {choices.map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy !== null}
                onClick={() => narrowTo(m)}
                className="focus-ring rounded-full border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                {busy === m ? 'Updating…' : formatLength(m)}
              </button>
            ))}
          </div>
        </div>
      )}
      {message && <p className="mt-3 text-xs text-text-secondary" role="status">{message}</p>}

      {log.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <BellRing size={13} aria-hidden /> Customer notifications
          </p>
          <ul className="space-y-1.5">
            {log.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-3 text-xs text-text-secondary">
                <span>{KIND_LABEL[n.kind]} · {formatWindowRange({ start: new Date(n.window_start), end: new Date(n.window_end) })}</span>
                <span title={n.error ?? undefined} className={n.status === 'failed' ? 'text-red-500' : undefined}>
                  {n.status === 'skipped' && n.error ? `skipped (${n.error})` : n.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
