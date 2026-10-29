import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  WEATHER_LABEL,
  addDays,
  formatHours,
  formatLogDate,
  formatMinutes,
  isIsoDate,
  isTooFarAhead,
  missingLogDates,
} from '@/lib/dailyLogs';
import { fetchLogList, type LogListRow } from '@/lib/dailyLogsApi';
import { DailyLogEditor } from './DailyLogEditor';
import { Pill, SectionHeader, Stat, compactInput, panelClass, type TabProps } from './projectUi';

export function DailyLogsTab({ ownerId, bundle, today }: TabProps) {
  const { project } = bundle;
  const { toast } = useToast();
  const [rows, setRows] = useState<LogListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [pick, setPick] = useState(today);

  const load = useCallback(async () => {
    try {
      setRows(await fetchLogList(ownerId, project.id));
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast(e instanceof Error ? e.message : 'Could not load daily logs.', 'error');
    }
  }, [ownerId, project.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const missing = useMemo(
    () => (rows && project.status === 'active' ? missingLogDates(project.start_date, today, new Set(rows.map((r) => r.log_date))) : []),
    [rows, project.status, project.start_date, today],
  );
  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      submitted: list.filter((r) => r.status === 'submitted').length,
      hours: list.reduce((s, r) => s + r.crew_hours, 0),
      delay: list.reduce((s, r) => s + r.delay_minutes, 0),
    };
  }, [rows]);

  const openPicked = () => {
    if (!isIsoDate(pick)) { toast('Choose a valid date.', 'error'); return; }
    if (isTooFarAhead(pick, today)) { toast('Logs cannot be created for dates more than one day ahead.', 'error'); return; }
    setOpenDate(pick);
  };

  if (openDate) {
    return (
      <DailyLogEditor
        ownerId={ownerId}
        projectId={project.id}
        date={openDate}
        today={today}
        onChanged={() => void load()}
        onClose={() => { setOpenDate(null); void load(); }}
      />
    );
  }

  if (failed && rows === null) return <EmptyStateError icon={ClipboardList} title="Could not load daily logs" onRetry={() => { setFailed(false); void load(); }} />;

  if (rows === null) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading daily logs">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const todayRow = rows.find((r) => r.log_date === today);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Daily logs"
        description="One log per day: weather, crew and hours, work done, photos, delays and visitors. Locked once submitted."
        action={<Button size="sm" onClick={() => setOpenDate(today)}><Plus size={14} aria-hidden="true" /> {todayRow ? (todayRow.status === 'submitted' ? "View today's log" : "Continue today's log") : "Today's log"}</Button>}
      />

      {rows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Submitted logs" value={totals.submitted} hint={`${rows.length} in total`} />
          <Stat label="Crew hours logged" value={formatHours(totals.hours)} />
          <Stat label="Time lost to delays" value={formatMinutes(totals.delay)} tone={totals.delay > 0 ? 'warning' : undefined} />
        </div>
      )}

      {missing.length > 0 && (
        <section className={`${panelClass} space-y-2`} aria-label="Missing logs">
          <p className="text-sm font-semibold text-text-primary">{missing.length === 1 ? '1 weekday has' : `${missing.length} weekdays have`} no log yet</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((d) => (
              <button key={d} type="button" onClick={() => setOpenDate(d)} className="focus-ring rounded-full border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent/40">
                {formatLogDate(d)}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Input label="Open another date" type="date" value={pick} max={addDays(today, 1)} onChange={(e) => setPick(e.target.value)} className={compactInput} />
        </div>
        <Button size="sm" variant="secondary" onClick={openPicked}>Open</Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No daily logs yet"
          description="Record what happened on site today. Submitted logs are locked, so they work as the project's day-by-day record."
          action={{ label: "Start today's log", onClick: () => setOpenDate(today) }}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpenDate(r.log_date)} className={`${panelClass} focus-ring flex w-full flex-wrap items-center justify-between gap-3 text-left transition-colors hover:border-accent/40`}>
                <span className="block min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">{formatLogDate(r.log_date)}</span>
                  <span className="mt-0.5 block text-xs text-text-secondary">
                    {r.weather_code ? WEATHER_LABEL[r.weather_code] : 'No weather'}
                    {r.temp_high_f !== null ? ` · ${r.temp_high_f}°F` : ''}
                    {` · ${r.crew_count} crew · ${formatHours(r.crew_hours)}`}
                    {r.delay_minutes > 0 ? ` · ${formatMinutes(r.delay_minutes)} delayed` : ''}
                    {r.photo_count > 0 ? ` · ${r.photo_count} photo${r.photo_count === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {r.ai_summary && r.ai_generated_at && <Pill tone="info">AI draft</Pill>}
                  <Pill tone={r.status === 'submitted' ? 'success' : 'warning'}>{r.status === 'submitted' ? 'Submitted' : 'Draft'}</Pill>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
