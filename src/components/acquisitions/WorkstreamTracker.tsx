import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Lock, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Field, Pill, ProgressBar, fieldCls, panelCls, type Tone } from '@/components/acquisitions/acquisitionUi';
import {
  addDependency, createWorkstream, deleteWorkstream, describeAcquisitionError, removeDependency, setWorkstreamStatus, updateWorkstream, type LinkOptions,
} from '@/lib/acquisitionsApi';
import {
  KIND_LABELS, PHASES, PHASE_LABELS, WS_STATUSES, WS_STATUS_LABELS, canMoveTo, currentPhase, dayNumber, dueState, groupByPhase, isClosed,
  isIsoDate, openDependencies, progress, readyToStart, wouldCreateCycle, type Dep, type Phase, type Workstream, type WorkstreamStatus,
} from '@/lib/acquisitions';

interface Props {
  ownerId: string;
  acquisitionId: string;
  closeDate: string;
  today: string;
  workstreams: Workstream[];
  deps: Dep[];
  members: LinkOptions['members'];
  canManage: boolean;
  onWorkstream: (w: Workstream) => void;
  onAdded: (w: Workstream) => void;
  onRemoved: (id: string) => void;
  onDeps: (d: Dep[]) => void;
  /** The database completes / re-opens the acquisition itself; ask the page to re-read it. */
  onStatusMaybeChanged: () => void;
}

const STATUS_TONE: Record<WorkstreamStatus, Tone> = { not_started: 'neutral', in_progress: 'info', blocked: 'bad', done: 'good', skipped: 'neutral' };

export function WorkstreamTracker(p: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Workstream | null>(null);
  const [draft, setDraft] = useState<{ title: string; phase: Phase; due_date: string }>({ title: '', phase: 'day_30', due_date: '' });
  const [draftError, setDraftError] = useState<string | undefined>();

  const prog = progress(p.workstreams, p.today);
  const groups = groupByPhase(p.workstreams);
  const ready = readyToStart(p.workstreams, p.deps).slice(0, 3);
  const phaseNow = currentPhase(dayNumber(p.closeDate, p.today));

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e) { toast(describeAcquisitionError(e), 'error'); } finally { setBusy(null); }
  };

  const changeStatus = (w: Workstream, status: WorkstreamStatus) => {
    const gate = canMoveTo(status, w.id, p.workstreams, p.deps);
    if (!gate.ok) { toast(gate.reason ?? 'Finish the earlier workstreams first.', 'error'); return; }
    void run(w.id, async () => { p.onWorkstream(await setWorkstreamStatus(w.id, p.ownerId, status)); p.onStatusMaybeChanged(); });
  };
  const patch = (w: Workstream, values: Parameters<typeof updateWorkstream>[2]) =>
    void run(w.id, async () => { p.onWorkstream(await updateWorkstream(w.id, p.ownerId, values)); });

  const addDep = (w: Workstream, parentId: string) => {
    if (!parentId) return;
    if (wouldCreateCycle(w.id, parentId, p.deps)) { toast('That dependency would create a loop.', 'error'); return; }
    void run(w.id, async () => { await addDependency(p.ownerId, w.id, parentId); p.onDeps([...p.deps, { workstream_id: w.id, depends_on_id: parentId }]); });
  };
  const dropDep = (w: Workstream, parentId: string) =>
    void run(w.id, async () => { await removeDependency(p.ownerId, w.id, parentId); p.onDeps(p.deps.filter((d) => !(d.workstream_id === w.id && d.depends_on_id === parentId))); });

  const addCustom = () => {
    if (draft.title.trim().length < 1) { setDraftError('Give the workstream a name.'); return; }
    if (draft.due_date && !isIsoDate(draft.due_date)) { setDraftError('Pick a valid date.'); return; }
    setDraftError(undefined);
    void run('new', async () => {
      const w = await createWorkstream(p.ownerId, p.acquisitionId, draft, (p.workstreams.reduce((m, x) => Math.max(m, x.sort_order), 0) || 0) + 10);
      p.onAdded(w); setDraft({ title: '', phase: draft.phase, due_date: '' }); p.onStatusMaybeChanged();
    });
  };

  return (
    <div className="space-y-5">
      <div className={panelCls}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-text-primary">{prog.closed} of {prog.total} workstreams complete</p>
          <div className="flex flex-wrap gap-2">
            {prog.overdue > 0 && <Pill tone="bad"><AlertTriangle size={12} aria-hidden="true" /> {prog.overdue} overdue</Pill>}
            {prog.blocked > 0 && <Pill tone="warn">{prog.blocked} blocked</Pill>}
            <Pill tone="info">{prog.inProgress} in progress</Pill>
          </div>
        </div>
        <div className="mt-3"><ProgressBar pct={prog.pct} label="Integration progress" /></div>
        {ready.length > 0 && (
          <p className="mt-3 text-xs text-text-secondary">
            Ready to start now: {ready.map((w) => w.title).join(' · ')}
          </p>
        )}
      </div>

      {p.workstreams.length === 0 && (
        <EmptyState icon={CheckCircle2} title="No workstreams yet" description="Add the first workstream below to start tracking this integration." />
      )}

      {PHASES.map((phase) => (
        <section key={phase} aria-labelledby={`phase-${phase}`}>
          <h3 id={`phase-${phase}`} className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
            {PHASE_LABELS[phase]} {phaseNow === phase && <Pill tone="info">Now</Pill>}
          </h3>
          {groups[phase].length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">Nothing scheduled in this window.</p>
          ) : (
            <ul className="space-y-3">
              {groups[phase].map((w) => {
                const waiting = openDependencies(w.id, p.workstreams, p.deps);
                const due = dueState(w, p.today);
                const myDeps = p.deps.filter((d) => d.workstream_id === w.id);
                const addable = p.workstreams.filter((x) => x.id !== w.id && !myDeps.some((d) => d.depends_on_id === x.id) && !wouldCreateCycle(w.id, x.id, p.deps));
                const isBusy = busy === w.id;
                return (
                  <li key={w.id} className={panelCls}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-primary">{w.title}</p>
                        {w.description && <p className="mt-0.5 text-sm text-text-secondary">{w.description}</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {w.kind !== 'custom' && <Pill>{KIND_LABELS[w.kind]}</Pill>}
                        <Pill tone={STATUS_TONE[w.status]}>{WS_STATUS_LABELS[w.status]}</Pill>
                        {due === 'overdue' && <Pill tone="bad">Overdue</Pill>}
                        {due === 'due_soon' && <Pill tone="warn">Due soon</Pill>}
                        {waiting.length > 0 && <Pill tone="warn"><Lock size={11} aria-hidden="true" /> Waiting on {waiting.length}</Pill>}
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Field label="Status">
                        <select className={fieldCls} value={w.status} disabled={!p.canManage || isBusy} onChange={(e) => changeStatus(w, e.target.value as WorkstreamStatus)}>
                          {WS_STATUSES.map((s) => <option key={s} value={s}>{WS_STATUS_LABELS[s]}</option>)}
                        </select>
                      </Field>
                      <Field label="Owner">
                        <select className={fieldCls} value={w.owner_member_id ?? ''} disabled={!p.canManage || isBusy}
                          onChange={(e) => patch(w, { owner_member_id: e.target.value || null, owner_label: e.target.value ? null : w.owner_label })}>
                          <option value="">{w.owner_label ? `External: ${w.owner_label}` : 'Unassigned'}</option>
                          {p.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Due date">
                        <input type="date" className={fieldCls} value={w.due_date ?? ''} disabled={!p.canManage || isBusy}
                          onChange={(e) => patch(w, { due_date: e.target.value && isIsoDate(e.target.value) ? e.target.value : null })} />
                      </Field>
                    </div>

                    <button type="button" className="focus-ring mt-3 rounded-lg text-xs font-medium text-accent hover:underline" aria-expanded={open === w.id}
                      onClick={() => setOpen(open === w.id ? null : w.id)}>
                      {open === w.id ? 'Hide details' : 'Dependencies & notes'}
                    </button>

                    {open === w.id && (
                      <div className="mt-3 space-y-3 border-t border-border pt-3">
                        <div>
                          <p className="mb-1 block text-xs font-medium text-text-secondary"><Link2 size={12} className="mr-1 inline" aria-hidden="true" />Waits on</p>
                          {myDeps.length === 0 && <p className="text-xs text-text-secondary">No dependencies.</p>}
                          <ul className="flex flex-wrap gap-2">
                            {myDeps.map((d) => {
                              const up = p.workstreams.find((x) => x.id === d.depends_on_id);
                              if (!up) return null;
                              return (
                                <li key={d.depends_on_id} className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-primary">
                                  {isClosed(up.status) ? <CheckCircle2 size={12} className="text-success" aria-label="done" /> : <Lock size={12} className="text-warning-500" aria-label="open" />}
                                  {up.title}
                                  {p.canManage && (
                                    <button type="button" aria-label={`Remove dependency on ${up.title}`} disabled={isBusy} onClick={() => dropDep(w, up.id)} className="focus-ring rounded-full p-0.5 hover:bg-bg-secondary"><X size={12} /></button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                          {p.canManage && addable.length > 0 && (
                            <select aria-label="Add a dependency" className={`${fieldCls} mt-2 sm:max-w-xs`} value="" disabled={isBusy} onChange={(e) => addDep(w, e.target.value)}>
                              <option value="">Add a dependency…</option>
                              {addable.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                            </select>
                          )}
                        </div>
                        <NotesEditor key={`${w.id}-${w.notes ?? ''}`} initial={w.notes ?? ''} disabled={!p.canManage || isBusy} onSave={(notes) => patch(w, { notes: notes.trim() === '' ? null : notes.trim() })} />
                        {p.canManage && w.kind === 'custom' && (
                          <Button variant="ghost" size="sm" onClick={() => setRemoving(w)}><Trash2 size={14} aria-hidden="true" /> Remove workstream</Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}

      {p.canManage && (
        <div className={panelCls}>
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Add a custom workstream</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <Input label="Name" value={draft.title} maxLength={120} error={draftError} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <Field label="Window">
              <select className={fieldCls} value={draft.phase} onChange={(e) => setDraft({ ...draft, phase: e.target.value as Phase })}>
                {PHASES.map((x) => <option key={x} value={x}>{PHASE_LABELS[x]}</option>)}
              </select>
            </Field>
            <Input label="Due" type="date" value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} />
            <Button size="sm" onClick={addCustom} disabled={busy === 'new'}><Plus size={14} aria-hidden="true" /> Add</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this workstream?"
        description={removing ? `“${removing.title}” and its dependencies will be removed. This cannot be undone.` : ''}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const w = removing; setRemoving(null);
          if (!w) return;
          await run(w.id, async () => { await deleteWorkstream(w.id, p.ownerId); p.onRemoved(w.id); p.onStatusMaybeChanged(); });
        }}
      />
    </div>
  );
}

function NotesEditor({ initial, disabled, onSave }: { initial: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Field label="Notes">
      <textarea className={fieldCls} rows={3} maxLength={2000} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== initial) onSave(v); }} />
    </Field>
  );
}
