import { useState } from 'react';
import { Check, CircleSlash, Layers, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateInline } from '@/components/EmptyState';
import { addMilestone, addPhase, deleteMilestone, deletePhase, setMilestoneDueDate, setMilestoneStatus, setPhaseStatus } from '@/lib/installProjectsApi';
import {
  MILESTONE_KIND_LABEL,
  PHASE_STATUS_LABEL,
  formatDate,
  phaseProgress,
  type MilestoneKind,
  type PhaseStatus,
  type ProjectMilestone,
  type ProjectPhase,
} from '@/lib/installProjects';
import { Pill, ProgressBar, SectionHeader, compactInput, panelClass, phaseTone, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

function AddMilestone({ phase, nextSort, ownerId, projectId, run, busy }: { phase: ProjectPhase; nextSort: number; ownerId: string; projectId: string; run: ReturnType<typeof useAction>['run']; busy: boolean }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MilestoneKind>('task');
  const [due, setDue] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const ok = await run(`ms-add-${phase.id}`, () => addMilestone(ownerId, { projectId, phaseId: phase.id, title, kind, dueDate: due, sortOrder: nextSort }), 'Milestone added.');
    if (ok) { setTitle(''); setDue(''); }
  };
  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_150px_auto]">
      <Input aria-label="Milestone title" placeholder="Add a milestone…" value={title} onChange={(e) => setTitle(e.target.value)} className={compactInput} maxLength={160} />
      <select aria-label="Milestone type" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as MilestoneKind)}>
        {(Object.keys(MILESTONE_KIND_LABEL) as MilestoneKind[]).map((k) => <option key={k} value={k}>{MILESTONE_KIND_LABEL[k]}</option>)}
      </select>
      <Input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} className={compactInput} />
      <Button type="submit" size="sm" variant="secondary" disabled={busy || !title.trim()}><Plus size={14} aria-hidden="true" /> Add</Button>
    </form>
  );
}

function MilestoneRow({ m, today, ownerId, run, busyKey, ask }: { m: ProjectMilestone; today: string; ownerId: string; run: ReturnType<typeof useAction>['run']; busyKey: string | null; ask: ReturnType<typeof useConfirm>['ask'] }) {
  const done = m.status === 'done';
  const skipped = m.status === 'skipped';
  const late = m.status === 'pending' && m.due_date !== null && m.due_date < today;
  const busy = busyKey === `ms-${m.id}`;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`${done ? 'Reopen' : 'Complete'} ${m.title}`}
        disabled={busy}
        onClick={() => run(`ms-${m.id}`, () => setMilestoneStatus(ownerId, m.id, done ? 'pending' : 'done'))}
        className={`focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${done ? 'border-success-500 bg-success-500 text-white' : 'border-border bg-bg-primary text-transparent hover:border-accent'}`}
      >
        <Check size={14} aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${done || skipped ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{m.title}</p>
        <p className="text-xs text-text-secondary">
          {MILESTONE_KIND_LABEL[m.kind]}
          {done && m.completed_at ? ` · done ${formatDate(m.completed_at)}` : ''}
          {skipped ? ' · skipped' : ''}
        </p>
      </div>
      <label className="sr-only" htmlFor={`due-${m.id}`}>Due date for {m.title}</label>
      <input
        id={`due-${m.id}`}
        type="date"
        defaultValue={m.due_date ?? ''}
        onBlur={(e) => { if (e.target.value !== (m.due_date ?? '')) void run(`ms-${m.id}`, () => setMilestoneDueDate(ownerId, m.id, e.target.value)); }}
        className={`focus-ring rounded-lg border bg-bg-primary px-2 py-1 text-xs ${late ? 'border-danger-500 text-danger-500' : 'border-border text-text-secondary'}`}
      />
      {m.status !== 'done' && (
        <button type="button" disabled={busy} aria-label={skipped ? `Restore ${m.title}` : `Skip ${m.title}`} title={skipped ? 'Restore' : 'Skip (not needed)'} onClick={() => run(`ms-${m.id}`, () => setMilestoneStatus(ownerId, m.id, skipped ? 'pending' : 'skipped'))} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary">
          {skipped ? <Undo2 size={14} aria-hidden="true" /> : <CircleSlash size={14} aria-hidden="true" />}
        </button>
      )}
      <button type="button" aria-label={`Delete ${m.title}`} onClick={() => ask({ title: 'Delete milestone?', description: `“${m.title}” will be removed from this project.`, label: 'Delete milestone', onConfirm: () => run(`ms-${m.id}`, () => deleteMilestone(ownerId, m.id), 'Milestone deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

export function PhasesTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, phases, milestones } = bundle;
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState('');
  const [weight, setWeight] = useState('1');

  const submitPhase = async (e: React.FormEvent) => {
    e.preventDefault();
    const w = Math.round(Number(weight));
    if (!name.trim() || !Number.isFinite(w) || w < 1 || w > 100) return;
    const ok = await run('phase-add', () => addPhase(ownerId, project.id, { name, weight: w, sortOrder: phases.length ? Math.max(...phases.map((p) => p.sort_order)) + 1 : 0 }), 'Phase added.');
    if (ok) { setName(''); setWeight('1'); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Phases & milestones" description="Progress is the weighted share of completed milestones. Weight a phase higher when it carries more of the job." />
      {phases.length === 0 && (
        <EmptyState icon={Layers} title="No phases yet" description="Break the install into phases — survey, procurement, install, closeout — then track milestones inside each." />
      )}
      {phases.map((p) => {
        const items = milestones.filter((m) => m.phase_id === p.id);
        const pct = phaseProgress(p, milestones);
        const allDone = items.length > 0 && items.every((m) => m.status !== 'pending') && p.status !== 'completed';
        return (
          <section key={p.id} className={panelClass} aria-label={p.name}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-text-primary">{p.name}</h3>
                <p className="text-xs text-text-secondary">Weight {p.weight} · {pct}% complete{p.actual_end ? ` · finished ${formatDate(p.actual_end)}` : p.actual_start ? ` · started ${formatDate(p.actual_start)}` : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={phaseTone[p.status]}>{PHASE_STATUS_LABEL[p.status]}</Pill>
                <select aria-label={`Status for ${p.name}`} className={`${selectClass} !w-auto`} value={p.status} disabled={busyKey === `ph-${p.id}`} onChange={(e) => run(`ph-${p.id}`, () => setPhaseStatus(ownerId, p.id, e.target.value as PhaseStatus))}>
                  {(Object.keys(PHASE_STATUS_LABEL) as PhaseStatus[]).map((s) => <option key={s} value={s}>{PHASE_STATUS_LABEL[s]}</option>)}
                </select>
                <button type="button" aria-label={`Delete phase ${p.name}`} onClick={() => ask({ title: 'Delete phase?', description: `“${p.name}” and its ${items.length} milestone${items.length === 1 ? '' : 's'} will be deleted. Billing steps and materials tied to it are kept.`, label: 'Delete phase', onConfirm: () => run(`ph-${p.id}`, () => deletePhase(ownerId, p.id), 'Phase deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="mt-3"><ProgressBar value={pct} label={`${p.name} progress`} tone={p.status === 'blocked' ? 'danger' : pct === 100 ? 'success' : 'info'} /></div>
            {allDone && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-success-500/10 p-3 text-sm text-success-500">
                All milestones are finished.
                <Button size="sm" variant="secondary" disabled={busyKey === `ph-${p.id}`} onClick={() => run(`ph-${p.id}`, () => setPhaseStatus(ownerId, p.id, 'completed'), 'Phase completed.')}>Mark phase complete</Button>
              </div>
            )}
            {items.length === 0 ? <div className="mt-3"><EmptyStateInline text="No milestones in this phase yet." /></div> : (
              <ul className="mt-2 divide-y divide-border">
                {items.map((m) => <MilestoneRow key={m.id} m={m} today={today} ownerId={ownerId} run={run} busyKey={busyKey} ask={ask} />)}
              </ul>
            )}
            <AddMilestone phase={p} nextSort={items.length ? Math.max(...items.map((m) => m.sort_order)) + 1 : 0} ownerId={ownerId} projectId={project.id} run={run} busy={busyKey === `ms-add-${p.id}`} />
          </section>
        );
      })}
      <form onSubmit={submitPhase} className={`${panelClass} grid gap-2 sm:grid-cols-[1fr_110px_auto]`}>
        <Input aria-label="New phase name" placeholder="New phase name" value={name} onChange={(e) => setName(e.target.value)} className={compactInput} maxLength={120} />
        <Input aria-label="Phase weight" type="number" min={1} max={100} value={weight} onChange={(e) => setWeight(e.target.value)} className={compactInput} />
        <Button type="submit" size="sm" disabled={busyKey === 'phase-add' || !name.trim()}><Plus size={14} aria-hidden="true" /> Add phase</Button>
      </form>
      {dialog}
    </div>
  );
}
