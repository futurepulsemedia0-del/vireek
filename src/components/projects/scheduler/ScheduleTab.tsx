import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarRange, Copy, Link2, RotateCw, Undo2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatDate, friendlyError, phaseProgress, todayIso, type ProjectPhase } from '@/lib/installProjects';
import {
  ZOOM_PX,
  autoSchedule,
  calendarFor,
  conflictCounts,
  conflictsByPhase,
  criticalPath,
  currentWindows,
  detectConflicts,
  materialStartConstraints,
  projectedFinish,
  sequentialLinks,
  setPhaseWindow,
  type ScheduleChange,
  type ScheduleResult,
  type Win,
  type Zoom,
} from '@/lib/projectScheduler';
import {
  addDependencies,
  fetchSchedulerData,
  progressLink,
  removeDependency,
  reschedulePhases,
  saveBaseline,
  setMaterialPlan,
  setPhaseCrew,
  setPhaseLocked,
  setSharing,
  setWorkWeekends,
  updateDependency,
  type ProjectSharing,
  type SchedulerData,
} from '@/lib/projectSchedulerApi';
import { SectionHeader, Stat, panelClass, useAction, useConfirm, type TabProps } from '../projectUi';
import { GanttChart, type GanttMarker } from './GanttChart';
import { PhaseInspector } from './PhaseInspector';

const ZOOMS: { key: Zoom; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];
const BLOCKED_COPY = {
  locked: 'That phase is locked. Unlock it to change its dates.',
  completed: 'Completed phases cannot be rescheduled.',
  invalid: 'Those dates are not valid.',
} as const;

function SharePanel({ projectId, sharing, onChange }: { projectId: string; sharing: ProjectSharing | null; onChange: (s: ProjectSharing) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (opts: Parameters<typeof setSharing>[1], ok: string) => {
    setBusy(true);
    try { onChange(await setSharing(projectId, opts)); toast(ok, 'success'); } catch (e) { toast(friendlyError(e, 'Could not update the customer link.'), 'error'); } finally { setBusy(false); }
  };
  const link = sharing ? progressLink(sharing.token) : '';
  return (
    <section className={`${panelClass} space-y-3`} aria-label="Customer progress link">
      <SectionHeader title="Customer progress view" description="A private link your customer can open to follow phases and milestones. It never shows prices, notes or crew names." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={!!sharing?.enabled} disabled={busy} onClick={() => void act({ enabled: !sharing?.enabled }, sharing?.enabled ? 'Customer link turned off.' : 'Customer link turned on.')} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
          <span className={`h-2.5 w-2.5 rounded-full ${sharing?.enabled ? 'bg-success-500' : 'bg-text-secondary'}`} aria-hidden="true" /> {sharing?.enabled ? 'Link is on' : 'Link is off'}
        </button>
        {sharing?.enabled && (
          <>
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" checked={sharing.show_dates} disabled={busy} onChange={(e) => void act({ showDates: e.target.checked }, 'Saved.')} /> Show dates
            </label>
            <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast('Link copied.', 'success'), () => toast('Could not copy. Select the link and copy it.', 'error')); }}><Copy size={14} aria-hidden="true" /> Copy link</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ rotate: true }, 'New link created. The old one no longer works.')}><RotateCw size={14} aria-hidden="true" /> New link</Button>
          </>
        )}
      </div>
      {sharing?.enabled && <p className="break-all rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary" data-testid="share-link">{link}</p>}
    </section>
  );
}

export function ScheduleTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, phases, milestones, materials } = bundle;
  const { toast } = useToast();
  const [, setParams] = useSearchParams();
  const { ask, dialog } = useConfirm();
  const { busyKey, run } = useAction(onChanged);
  const [data, setData] = useState<SchedulerData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [overrides, setOverrides] = useState<Map<string, Win> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [showCritical, setShowCritical] = useState(true);
  const [showBaseline, setShowBaseline] = useState(true);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [undoStack, setUndoStack] = useState<ScheduleChange[][]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const undoRef = useRef<ScheduleChange[][]>([]);
  undoRef.current = undoStack;

  const cal = useMemo(() => calendarFor(project), [project]);
  const readOnly = project.status === 'completed' || project.status === 'cancelled';

  const load = useCallback(async (spinner: boolean) => {
    if (spinner) setState('loading');
    try { setData(await fetchSchedulerData(ownerId, bundle)); setState('ready'); } catch (e) {
      if (spinner) setState('error');
      toast(friendlyError(e, 'Could not load the schedule.'), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, project.id, toast]);

  useEffect(() => { void load(true); }, [load]);

  // Phases as the user sees them: committed dates plus any optimistic move in flight.
  const view = useMemo<ProjectPhase[]>(() => (overrides ? phases.map((p) => { const o = overrides.get(p.id); return o ? { ...p, planned_start: o.start, planned_end: o.end } : p; }) : phases), [phases, overrides]);
  const windows = useMemo(() => currentWindows(view), [view]);
  const deps = data?.dependencies ?? [];
  const cp = useMemo(() => criticalPath(view, deps, windows, cal), [view, deps, windows, cal]);
  const conflicts = useMemo(
    () => detectConflicts({ project, phases: view, deps, windows, crew: data?.crew ?? [], techNames: new Map((data?.technicians ?? []).map((t) => [t.id, t.name])), bookings: data?.bookings ?? [], timeOff: data?.timeOff ?? [], blackouts: data?.blackouts ?? [], materials, today, cal }),
    [project, view, deps, windows, data, materials, today, cal],
  );
  const counts = conflictCounts(conflicts);
  const progress = useMemo(() => new Map(phases.map((p) => [p.id, phaseProgress(p, milestones)])), [phases, milestones]);
  const crewCounts = useMemo(() => { const m = new Map<string, number>(); for (const c of data?.crew ?? []) m.set(c.phase_id, (m.get(c.phase_id) ?? 0) + 1); return m; }, [data?.crew]);
  const markers = useMemo<GanttMarker[]>(() => [
    ...milestones.filter((m) => m.due_date).map((m): GanttMarker => ({ id: `m-${m.id}`, phaseId: m.phase_id, date: m.due_date!, label: m.title, tone: m.status === 'done' ? 'done' : m.status === 'pending' && m.due_date! < today ? 'late' : 'pending' })),
    ...bundle.jobs.filter((j) => j.phase_id && j.scheduled_datetime).map((j): GanttMarker => ({ id: `j-${j.job_id}`, phaseId: j.phase_id!, date: todayIso(new Date(j.scheduled_datetime!)), label: `Job · ${j.customer_name}`, tone: 'job' })),
  ], [milestones, bundle.jobs, today]);
  const finish = projectedFinish(windows);
  const selected = view.find((p) => p.id === selectedId) ?? null;
  const updatedAt = (id: string) => phases.find((p) => p.id === id)?.updated_at;

  const commit = useCallback(async (res: ScheduleResult, label: string, record = true) => {
    if (res.blocked) { toast(BLOCKED_COPY[res.blocked], 'info'); return; }
    if (res.cyclic) { toast('The phase links form a loop. Remove one link first.', 'error'); return; }
    if (!res.changes.length || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    setOverrides(new Map(res.changes.map((c) => [c.id, { start: c.start, end: c.end }])));
    try {
      await reschedulePhases(project.id, res.changes.map((c) => ({ id: c.id, start: c.start, end: c.end, expectedUpdatedAt: updatedAt(c.id) })));
      if (record) setUndoStack((s) => [...s.slice(-19), res.changes]);
      await onChanged();
      setOverrides(null);
      toast(label, 'success', record ? { action: { label: 'Undo', onClick: () => void undo() } } : undefined);
      void load(false);
    } catch (e) {
      setOverrides(null);
      toast(friendlyError(e, 'Could not reschedule.'), 'error');
      await onChanged();
    } finally { savingRef.current = false; setSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, onChanged, toast, load, phases]);

  const undo = useCallback(async () => {
    const last = undoRef.current[undoRef.current.length - 1];
    if (!last || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      await reschedulePhases(project.id, last.map((c) => ({ id: c.id, start: c.prevStart, end: c.prevEnd })));
      setUndoStack((s) => s.slice(0, -1));
      await onChanged();
      toast('Change undone.', 'success');
      void load(false);
    } catch (e) { toast(friendlyError(e, 'Could not undo.'), 'error'); } finally { savingRef.current = false; setSaving(false); }
  }, [project.id, onChanged, toast, load]);

  const onAuto = () => {
    const res = autoSchedule({ phases: view, deps, cal, anchor: project.start_date, today, materialStart: materialStartConstraints(materials, today, cal) });
    if (res.cyclic) { toast('The phase links form a loop. Remove one link first.', 'error'); return; }
    if (!res.changes.length) { toast('The schedule is already as early as the links, materials and calendar allow.', 'info'); return; }
    ask({ title: 'Auto-schedule phases?', description: `${res.changes.length} phase${res.changes.length === 1 ? '' : 's'} will move to the earliest dates that respect links, material lead times and the work week. Completed, locked and in-progress phases stay put. You can undo this.`, label: 'Auto-schedule', onConfirm: () => commit(res, 'Schedule updated.') });
  };

  const afterEdit = async (key: string, fn: () => Promise<unknown>, ok: string) => { if (await run(key, fn, ok)) void load(false); };

  if (state === 'loading') return <div className="space-y-4" aria-busy="true" aria-label="Loading schedule"><Skeleton className="h-10 w-full" /><SkeletonCard rows={4} /></div>;
  if (state === 'error' || !data) return <EmptyStateError icon={CalendarRange} title="Could not load the schedule" onRetry={() => void load(true)} />;
  if (phases.length === 0) return <EmptyState icon={CalendarRange} title="Add phases to build a schedule" description="The Gantt chart is built from your project phases. Add them first, then come back to plan dates, crews and dependencies." action={{ label: 'Go to phases', onClick: () => setParams({ tab: 'phases' }, { replace: true }) }} />;

  const hasDates = windows.size > 0;
  const unlinked = deps.length === 0 && phases.length > 1;

  return (
    <div className="space-y-5">
      <SectionHeader title="Schedule" description="Drag a bar to reschedule it, drag its edges to change the length, or use the arrow keys. Later phases move automatically when links require it." />
      {readOnly && <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">This project is {project.status}. The schedule is read-only — reopen the project to change it.</p>}
      {data.notes.length > 0 && <p className="rounded-xl bg-warning-500/10 px-4 py-3 text-sm text-warning-500">Conflict checks are missing: {data.notes.join(', ')} could not be loaded.</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projected finish" value={finish ? formatDate(finish) : '—'} hint={project.target_end_date ? `Target ${formatDate(project.target_end_date)}` : 'No target date'} tone={finish && project.target_end_date && finish > project.target_end_date ? 'danger' : undefined} />
        <Stat label="Critical path" value={`${cp.criticalIds.length} phase${cp.criticalIds.length === 1 ? '' : 's'}`} hint={cp.cyclic ? 'Links form a loop' : 'Zero-float phases'} tone={cp.cyclic ? 'danger' : undefined} />
        <Stat label="Errors" value={counts.error} tone={counts.error ? 'danger' : 'success'} hint="Must fix" />
        <Stat label="Warnings" value={counts.warning} tone={counts.warning ? 'warning' : 'success'} hint="Worth a look" />
      </div>

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Schedule controls">
        <div role="group" aria-label="Zoom" className="inline-flex overflow-hidden rounded-xl border border-border">
          {ZOOMS.map((z) => <button key={z.key} type="button" aria-pressed={zoom === z.key} onClick={() => setZoom(z.key)} className={`focus-ring px-3 py-2 text-sm font-medium ${zoom === z.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'}`}>{z.label}</button>)}
        </div>
        <Button size="sm" variant="secondary" onClick={() => setScrollSignal((n) => n + 1)}>Today</Button>
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} /> Critical path</label>
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Baseline</label>
        {!readOnly && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={saving || undoStack.length === 0} onClick={() => void undo()}><Undo2 size={14} aria-hidden="true" /> Undo</Button>
            {unlinked && <Button size="sm" variant="secondary" disabled={saving || busyKey === 'chain'} onClick={() => void afterEdit('chain', () => addDependencies(ownerId, project.id, sequentialLinks(phases, deps)), 'Phases linked in order.')}><Link2 size={14} aria-hidden="true" /> Link phases in order</Button>}
            <Button size="sm" variant="secondary" disabled={saving} onClick={onAuto}><Wand2 size={14} aria-hidden="true" /> Auto-schedule</Button>
            <Button size="sm" variant="secondary" disabled={!hasDates || busyKey === 'baseline'} onClick={() => ask({ title: 'Save baseline?', description: 'The current planned dates become the baseline shown as thin bars under each phase, so you can see how far the plan has slipped.', label: 'Save baseline', onConfirm: () => run('baseline', () => saveBaseline(project.id), 'Baseline saved.') })}>Save baseline</Button>
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={project.work_weekends === true} disabled={busyKey === 'weekends'} onChange={(e) => void run('weekends', () => setWorkWeekends(ownerId, project.id, e.target.checked), e.target.checked ? 'Weekends are now working days.' : 'Weekends are now days off.')} /> Work weekends</label>
          </div>
        )}
      </div>

      {!hasDates && !readOnly && <p className="rounded-xl bg-accent/10 px-4 py-3 text-sm text-text-primary">No phase has dates yet. Use <strong>Auto-schedule</strong> to build a first plan from phase weights and links, then adjust it.</p>}

      <GanttChart
        phases={view}
        dependencies={deps}
        cal={cal}
        today={today}
        zoom={zoom}
        progress={progress}
        critical={cp.nodes}
        conflicts={conflictsByPhase(conflicts)}
        crewCounts={crewCounts}
        markers={markers}
        showCritical={showCritical}
        showBaseline={showBaseline}
        readOnly={readOnly || saving}
        selectedId={selectedId}
        scrollSignal={scrollSignal}
        onSelect={setSelectedId}
        onOpen={setSelectedId}
        onCommit={(res, id) => void commit(res, `“${phases.find((p) => p.id === id)?.name ?? 'Phase'}” rescheduled${res.changes.length > 1 ? ` (+${res.changes.length - 1} dependent)` : ''}.`)}
      />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary" aria-label="Legend">
        <span><span className="mr-1 inline-block h-2.5 w-4 rounded bg-accent align-middle" />In progress</span>
        <span><span className="mr-1 inline-block h-2.5 w-4 rounded bg-success-500 align-middle" />Complete</span>
        <span><span className="mr-1 inline-block h-2.5 w-4 rounded ring-2 ring-danger-500 align-middle" />Critical path</span>
        <span><span className="mr-1 inline-block h-2 w-2 rotate-45 bg-text-secondary align-middle" />Milestone</span>
        <span><span className="mr-1 inline-block h-2 w-2 rotate-45 bg-warning-500 align-middle" />Linked job</span>
      </p>

      {selected && (
        <PhaseInspector
          phase={selected}
          phases={view}
          deps={deps}
          crew={data.crew}
          technicians={data.technicians}
          materials={materials}
          conflicts={conflicts.filter((c) => c.phaseIds.includes(selected.id))}
          cal={cal}
          readOnly={readOnly}
          busy={saving || busyKey !== null}
          onClose={() => setSelectedId(null)}
          onApplyDates={(s, e) => void commit(setPhaseWindow(view, deps, cal, selected.id, s, e), 'Dates updated.')}
          onToggleLock={() => void afterEdit(`lock-${selected.id}`, async () => { await setPhaseLocked(ownerId, selected.id, !selected.locked); await onChanged(); }, selected.locked ? 'Phase unlocked.' : 'Phase locked.')}
          onSaveCrew={(ids) => void afterEdit(`crew-${selected.id}`, () => setPhaseCrew(ownerId, project.id, selected.id, ids, data.crew.filter((c) => c.phase_id === selected.id).map((c) => c.technician_id)), 'Crew saved.')}
          onAddDep={(row) => void afterEdit('dep-add', () => addDependencies(ownerId, project.id, [row]), 'Link added.')}
          onUpdateDep={(id, v) => void afterEdit(`dep-${id}`, () => updateDependency(ownerId, id, v), 'Link updated.')}
          onRemoveDep={(id) => void afterEdit(`dep-${id}`, () => removeDependency(ownerId, id), 'Link removed.')}
          onSaveMaterial={(id, v) => void afterEdit(`mat-${id}`, () => setMaterialPlan(ownerId, id, v), 'Material updated.')}
        />
      )}

      <section className={panelClass} aria-label="Scheduling issues">
        <SectionHeader title="Scheduling issues" description={conflicts.length ? 'Click an issue to open the phase.' : 'No conflicts found.'} />
        {conflicts.length > 0 && (
          <ul className="space-y-2">
            {conflicts.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => c.phaseIds[0] && setSelectedId(c.phaseIds[0])} className={`focus-ring w-full rounded-xl px-3 py-2 text-left text-sm ${c.severity === 'error' ? 'bg-danger-500/10 text-danger-500' : c.severity === 'warning' ? 'bg-warning-500/15 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                  <span className="font-semibold uppercase tracking-wide text-[11px]">{c.severity}</span> · {c.message}{c.hint ? <span className="block text-xs opacity-80">{c.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SharePanel projectId={project.id} sharing={data.sharing} onChange={(s) => setData((d) => (d ? { ...d, sharing: s } : d))} />
      {dialog}
    </div>
  );
}

// Re-exported so tests and docs can reference the pixel scale without importing the engine.
export const SCHEDULE_ZOOM_PX = ZOOM_PX;
