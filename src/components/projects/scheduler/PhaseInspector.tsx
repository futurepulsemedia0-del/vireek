import { useEffect, useMemo, useState } from 'react';
import { Lock, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyStateInline } from '@/components/EmptyState';
import { MATERIAL_STATUS_LABEL, PHASE_STATUS_LABEL, addDaysIso, formatDate, type ProjectMaterial, type ProjectPhase } from '@/lib/installProjects';
import {
  DEP_TYPE_LABEL,
  MAX_LAG_DAYS,
  MIN_LAG_DAYS,
  phaseWindow,
  wouldCreateCycle,
  workdaysInclusive,
  type DepType,
  type PhaseCrewRow,
  type PhaseDependency,
  type ScheduleConflict,
  type WorkCalendar,
} from '@/lib/projectScheduler';
import type { TechnicianOption } from '@/lib/projectSchedulerApi';
import { Pill, compactInput, materialTone, panelClass, phaseTone, selectClass } from '../projectUi';

interface Props {
  phase: ProjectPhase;
  phases: ProjectPhase[];
  deps: PhaseDependency[];
  crew: PhaseCrewRow[];
  technicians: TechnicianOption[];
  materials: ProjectMaterial[];
  conflicts: ScheduleConflict[];
  cal: WorkCalendar;
  readOnly: boolean;
  busy: boolean;
  onApplyDates: (start: string, end: string) => void;
  onToggleLock: () => void;
  onSaveCrew: (technicianIds: string[]) => void;
  onAddDep: (row: { predecessor_id: string; successor_id: string; dep_type: DepType; lag_days: number }) => void;
  onUpdateDep: (id: string, values: { dep_type?: DepType; lag_days?: number }) => void;
  onRemoveDep: (id: string) => void;
  onSaveMaterial: (id: string, values: { lead_time_days?: number; expected_date?: string | null }) => void;
  onClose: () => void;
}

const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-text-secondary';

export function PhaseInspector(p: Props) {
  const { phase, phases, deps, crew, technicians, materials, conflicts, cal, readOnly, busy } = p;
  const win = phaseWindow(phase);
  const [start, setStart] = useState(win?.start ?? '');
  const [end, setEnd] = useState(win?.end ?? '');
  const [newPred, setNewPred] = useState('');
  const [newType, setNewType] = useState<DepType>('FS');
  const [newLag, setNewLag] = useState('0');
  const currentCrew = useMemo(() => crew.filter((c) => c.phase_id === phase.id).map((c) => c.technician_id), [crew, phase.id]);
  const [picked, setPicked] = useState<string[]>(currentCrew);

  useEffect(() => { setStart(win?.start ?? ''); setEnd(win?.end ?? ''); }, [win?.start, win?.end, phase.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPicked(currentCrew), [currentCrew]);

  const locked = phase.locked === true;
  const closed = readOnly || phase.status === 'completed';
  const datesValid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start;
  const datesChanged = start !== (win?.start ?? '') || end !== (win?.end ?? '');
  const duration = datesValid ? workdaysInclusive(start, end, cal) : 0;
  const nameOf = (id: string) => phases.find((x) => x.id === id)?.name ?? 'Phase';

  const preds = deps.filter((d) => d.successor_id === phase.id);
  const succs = deps.filter((d) => d.predecessor_id === phase.id);
  const candidates = phases.filter((x) => x.id !== phase.id && !preds.some((d) => d.predecessor_id === x.id) && !wouldCreateCycle(deps, x.id, phase.id));
  const lagNum = Math.round(Number(newLag));
  const lagValid = Number.isFinite(lagNum) && lagNum >= MIN_LAG_DAYS && lagNum <= MAX_LAG_DAYS;
  const crewChanged = picked.length !== currentCrew.length || picked.some((t) => !currentCrew.includes(t));
  const mine = materials.filter((m) => m.phase_id === phase.id);

  return (
    <section className={`${panelClass} space-y-5`} aria-label={`Schedule details for ${phase.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{phase.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill tone={phaseTone[phase.status]}>{PHASE_STATUS_LABEL[phase.status]}</Pill>
            {locked && <Pill tone="warning">Locked</Pill>}
          </div>
        </div>
        <button type="button" aria-label="Close details" onClick={p.onClose} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={18} aria-hidden="true" /></button>
      </div>

      {conflicts.length > 0 && (
        <ul className="space-y-1.5" aria-label="Issues for this phase">
          {conflicts.map((c) => (
            <li key={c.id} className={`rounded-xl px-3 py-2 text-sm ${c.severity === 'error' ? 'bg-danger-500/10 text-danger-500' : c.severity === 'warning' ? 'bg-warning-500/15 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>
              {c.message}{c.hint ? <span className="block text-xs opacity-80">{c.hint}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <p className={sectionTitle}>Dates</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input aria-label="Start date" type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={closed || locked} className={compactInput} />
          <Input aria-label="End date" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} disabled={closed || locked} className={compactInput} />
          <Button size="sm" disabled={busy || closed || locked || !datesValid || !datesChanged} onClick={() => p.onApplyDates(start, end)}>Apply</Button>
        </div>
        <p className="text-xs text-text-secondary">{datesValid ? `${duration} working day${duration === 1 ? '' : 's'}. Later phases that depend on this one are pushed back automatically.` : 'Set a start and end date.'}</p>
        {!closed && (
          <button type="button" role="switch" aria-checked={locked} disabled={busy} onClick={p.onToggleLock} className="focus-ring inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary">
            <Lock size={14} aria-hidden="true" /> {locked ? 'Locked — dates will not move' : 'Lock these dates'}
          </button>
        )}
      </div>

      <div className="space-y-2">
        <p className={sectionTitle}>Depends on</p>
        {preds.length === 0 ? <EmptyStateInline text="No predecessors — this phase can start any time." /> : (
          <ul className="space-y-2">
            {preds.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{nameOf(d.predecessor_id)}</span>
                <select aria-label={`Link type for ${nameOf(d.predecessor_id)}`} className={`${selectClass} !w-auto`} value={d.dep_type} disabled={busy || closed} onChange={(e) => p.onUpdateDep(d.id, { dep_type: e.target.value as DepType })}>
                  {(Object.keys(DEP_TYPE_LABEL) as DepType[]).map((t) => <option key={t} value={t}>{DEP_TYPE_LABEL[t]}</option>)}
                </select>
                <input aria-label={`Lag in working days for ${nameOf(d.predecessor_id)}`} type="number" min={MIN_LAG_DAYS} max={MAX_LAG_DAYS} defaultValue={d.lag_days} disabled={busy || closed}
                  onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= MIN_LAG_DAYS && v <= MAX_LAG_DAYS && v !== d.lag_days) p.onUpdateDep(d.id, { lag_days: v }); }}
                  className="focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm" />
                <button type="button" aria-label={`Remove link from ${nameOf(d.predecessor_id)}`} disabled={busy || closed} onClick={() => p.onRemoveDep(d.id)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={14} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        {!closed && candidates.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_80px_auto]">
            <select aria-label="Add predecessor" className={selectClass} value={newPred} onChange={(e) => setNewPred(e.target.value)}>
              <option value="">Add a predecessor…</option>
              {candidates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select aria-label="New link type" className={`${selectClass} !w-auto`} value={newType} onChange={(e) => setNewType(e.target.value as DepType)}>
              {(Object.keys(DEP_TYPE_LABEL) as DepType[]).map((t) => <option key={t} value={t}>{DEP_TYPE_LABEL[t]}</option>)}
            </select>
            <Input aria-label="New link lag in working days" type="number" value={newLag} onChange={(e) => setNewLag(e.target.value)} className={compactInput} />
            <Button size="sm" variant="secondary" disabled={busy || !newPred || !lagValid} onClick={() => { p.onAddDep({ predecessor_id: newPred, successor_id: phase.id, dep_type: newType, lag_days: lagNum }); setNewPred(''); setNewLag('0'); }}>Link</Button>
          </div>
        )}
        {succs.length > 0 && <p className="text-xs text-text-secondary">Blocks: {succs.map((d) => nameOf(d.successor_id)).join(', ')}</p>}
      </div>

      <div className="space-y-2">
        <p className={sectionTitle}>Crew</p>
        {technicians.length === 0 ? <EmptyStateInline text="No team members yet. Invite people in Team to assign them." /> : (
          <>
            <ul className="grid max-h-44 gap-1 overflow-y-auto sm:grid-cols-2">
              {technicians.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-tertiary">
                    <input type="checkbox" disabled={busy || closed} checked={picked.includes(t.id)} onChange={(e) => setPicked((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
                    <span className="truncate">{t.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!closed && <Button size="sm" variant="secondary" disabled={busy || !crewChanged} onClick={() => p.onSaveCrew(picked)}>Save crew</Button>}
          </>
        )}
      </div>

      <div className="space-y-2">
        <p className={sectionTitle}>Materials & lead times</p>
        {mine.length === 0 ? <EmptyStateInline text="No materials tied to this phase. Add them in the Materials tab." /> : (
          <ul className="space-y-2">
            {mine.map((m) => {
              const lead = Math.max(0, m.lead_time_days ?? 0);
              const orderBy = win && m.status === 'planned' ? addDaysIso(win.start, -lead) : null;
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{m.description}</span>
                  <Pill tone={materialTone[m.status]}>{MATERIAL_STATUS_LABEL[m.status]}</Pill>
                  <label className="flex items-center gap-1 text-xs text-text-secondary">Lead (days)
                    <input type="number" min={0} max={365} defaultValue={lead} disabled={busy || closed} aria-label={`Lead time in days for ${m.description}`}
                      onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= 0 && v <= 365 && v !== lead) p.onSaveMaterial(m.id, { lead_time_days: v }); }}
                      className="focus-ring w-16 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" />
                  </label>
                  <input type="date" defaultValue={m.expected_date ?? ''} disabled={busy || closed} aria-label={`Expected delivery for ${m.description}`}
                    onBlur={(e) => { if (e.target.value !== (m.expected_date ?? '')) p.onSaveMaterial(m.id, { expected_date: e.target.value || null }); }}
                    className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary" />
                  {orderBy && <span className="w-full text-xs text-text-secondary">Order by {formatDate(orderBy)} to be on site when the phase starts.</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
