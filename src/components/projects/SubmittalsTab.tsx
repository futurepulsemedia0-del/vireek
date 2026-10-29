import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCheck, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  createSubmittal,
  deleteDraftSubmittal,
  fetchCanReview,
  fetchSubmittalRegister,
  transitionSubmittal,
  updateSubmittal,
  type SubmittalRegister,
} from '@/lib/submittalsApi';
import { formatDate } from '@/lib/installProjects';
import { formatDateTime } from '@/lib/projectItemsCore';
import { countByPurpose, type AttachmentPurpose, type ProjectAttachment } from '@/lib/projectAttachments';
import {
  EMPTY_SUBMITTAL_FORM,
  SUBMITTAL_ACTION_LABEL,
  SUBMITTAL_STATUS_LABEL,
  SUBMITTAL_TYPE_LABEL,
  availableActions,
  ballInCourt,
  checkAction,
  compareSubmittals,
  formatRevision,
  formatSubmittalNumber,
  isOverdue,
  summarizeSubmittals,
  validateSubmittalForm,
  type Submittal,
  type SubmittalAction,
  type SubmittalFormValues,
  type SubmittalRevision,
  type SubmittalStatus,
  type SubmittalType,
} from '@/lib/submittals';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ItemHistory } from './ItemHistory';
import { Pill, SectionHeader, Stat, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const STATUS_TONE: Record<SubmittalStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  in_review: 'info',
  approved: 'success',
  approved_as_noted: 'success',
  revise_resubmit: 'warning',
  rejected: 'danger',
  void: 'neutral',
};

type Filter = 'open' | 'needs_action' | 'awaiting' | 'approved' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'needs_action', label: 'Needs our action' },
  { key: 'awaiting', label: 'With reviewer' },
  { key: 'approved', label: 'Approved' },
  { key: 'all', label: 'All' },
];

function matchesFilter(s: Submittal, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'approved') return s.status === 'approved' || s.status === 'approved_as_noted';
  if (f === 'needs_action') return ballInCourt(s.status) === 'us';
  if (f === 'awaiting') return ballInCourt(s.status) === 'reviewer';
  return s.status !== 'void' && s.status !== 'approved' && s.status !== 'approved_as_noted';
}

const DECIDE_ACTIONS: SubmittalAction[] = ['approve', 'approve_as_noted', 'revise_resubmit', 'reject'];

export function SubmittalsTab({ ownerId, bundle, today }: TabProps) {
  const { toast } = useToast();
  const { project, phases } = bundle;
  const [register, setRegister] = useState<SubmittalRegister | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<SubmittalFormValues>(EMPTY_SUBMITTAL_FORM);
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reg, review] = await Promise.all([fetchSubmittalRegister(ownerId, project.id), fetchCanReview()]);
      setRegister(reg);
      setCanReview(review);
      setFailed(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load submittals.', 'error');
      setFailed(true);
    }
  }, [ownerId, project.id, toast]);

  useEffect(() => { void load(); }, [load]);
  const { busyKey, run } = useAction(load);

  const summary = useMemo(() => summarizeSubmittals(register?.submittals ?? [], today), [register, today]);
  const revisionsBySubmittal = useMemo(() => {
    const m = new Map<string, SubmittalRevision[]>();
    for (const r of register?.revisions ?? []) (m.get(r.submittal_id) ?? m.set(r.submittal_id, []).get(r.submittal_id)!).push(r);
    return m;
  }, [register]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (register?.submittals ?? [])
      .filter((s) => matchesFilter(s, filter))
      .filter((s) => !q || `${formatSubmittalNumber(s.seq)} ${s.spec_section} ${s.title} ${s.reviewer_name ?? ''}`.toLowerCase().includes(q))
      .sort(compareSubmittals);
  }, [register, filter, query]);

  const errors = validateSubmittalForm(form);
  const set = <K extends keyof SubmittalFormValues>(k: K, v: SubmittalFormValues[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    let newId: string | null = null;
    const ok = await run('create', async () => { newId = await createSubmittal(ownerId, project.id, form); }, 'Submittal created. Attach the package, then submit it.');
    if (ok) {
      setForm(EMPTY_SUBMITTAL_FORM);
      setShowErrors(false);
      setAdding(false);
      if (newId) setExpanded(newId);
    }
  };

  if (failed && !register) return <EmptyStateError icon={FileCheck} title="Could not load submittals" onRetry={() => void load()} />;
  if (!register) return <div className="space-y-3" aria-busy="true" aria-label="Loading submittals"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>;

  const err = (k: keyof SubmittalFormValues) => (showErrors ? errors[k] : undefined);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Approved" value={`${summary.approvedPercent}%`} hint={`${summary.approved} of ${summary.active} submittals`} tone={summary.active > 0 && summary.approvedPercent === 100 ? 'success' : undefined} />
        <Stat label="Needs our action" value={summary.needsAction} hint="Drafts and revisions to send" />
        <Stat label="With reviewer" value={summary.awaitingReview} hint="Submitted or in review" />
        <Stat label="Overdue" value={summary.overdue} hint="Past the needed-by date" tone={summary.overdue > 0 ? 'danger' : undefined} />
      </div>

      <section>
        <SectionHeader
          title="Submittal register"
          description="Track every spec-section submittal, its revisions and the reviewer’s decision."
          action={canReview && <Button size="sm" onClick={() => setAdding((a) => !a)}><Plus size={14} aria-hidden="true" /> {adding ? 'Close form' : 'New submittal'}</Button>}
        />

        {adding && canReview && (
          <form onSubmit={submit} noValidate className={`${panelClass} mb-4 space-y-3`}>
            <div className="grid gap-3 sm:grid-cols-6">
              <div className="sm:col-span-2"><Input label="Spec section" placeholder="23 05 00" value={form.specSection} onChange={(e) => set('specSection', e.target.value)} error={err('specSection')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-4"><Input label="Title" placeholder="RTU-1 product data" value={form.title} maxLength={160} onChange={(e) => set('title', e.target.value)} error={err('title')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="sub-type">Type</label>
                <select id="sub-type" className={selectClass} value={form.submittalType} onChange={(e) => set('submittalType', e.target.value as SubmittalType)}>
                  {(Object.keys(SUBMITTAL_TYPE_LABEL) as SubmittalType[]).map((t) => <option key={t} value={t}>{SUBMITTAL_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2"><Input label="Reviewer" placeholder="Architect / engineer" value={form.reviewerName} maxLength={120} onChange={(e) => set('reviewerName', e.target.value)} error={err('reviewerName')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2"><Input label="Reviewer email" type="email" value={form.reviewerEmail} onChange={(e) => set('reviewerEmail', e.target.value)} error={err('reviewerEmail')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-3"><Input label="Needed by" type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="py-2 text-sm" /></div>
              <div className="sm:col-span-3">
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="sub-phase">Phase</label>
                <select id="sub-phase" className={selectClass} value={form.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
                  <option value="">Any phase</option>
                  {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-6"><Textarea label="Description (optional)" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} error={err('description')} className="py-2 text-sm" /></div>
            </div>
            <div className="flex justify-end"><Button type="submit" size="sm" disabled={busyKey === 'create'}>Create submittal</Button></div>
          </form>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter submittals" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
            ))}
          </div>
          <div className="min-w-[12rem] flex-1 sm:max-w-xs"><Input aria-label="Search submittals" icon={Search} placeholder="Search number, section, title…" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" /></div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={FileCheck} title={register.submittals.length === 0 ? 'No submittals yet' : 'Nothing matches this view'} description={register.submittals.length === 0 ? 'Create a submittal for each spec section the reviewer must approve before you order or install.' : 'Try another filter or clear the search.'} />
        ) : (
          <ul className="space-y-2">
            {visible.map((s) => (
              <SubmittalRow
                key={s.id}
                s={s}
                revisions={revisionsBySubmittal.get(s.id) ?? []}
                open={expanded === s.id}
                onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
                phaseName={phases.find((p) => p.id === s.phase_id)?.name ?? null}
                ownerId={ownerId}
                projectId={project.id}
                today={today}
                canReview={canReview}
                reload={load}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface RowProps {
  s: Submittal;
  revisions: SubmittalRevision[];
  open: boolean;
  onToggle: () => void;
  phaseName: string | null;
  ownerId: string;
  projectId: string;
  today: string;
  canReview: boolean;
  reload: () => Promise<void>;
}

function SubmittalRow({ s, revisions, open, onToggle, phaseName, ownerId, projectId, today, canReview, reload }: RowProps) {
  const { toast } = useToast();
  const { ask, dialog } = useConfirm();
  const { busyKey, run } = useAction(reload);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<ProjectAttachment[]>([]);
  const [viewRev, setViewRev] = useState(s.current_revision);
  const [reviewer, setReviewer] = useState({ name: s.reviewer_name ?? '', email: s.reviewer_email ?? '', due: s.due_date ?? '' });

  useEffect(() => { setViewRev(s.current_revision); setNote(''); }, [s.current_revision, s.status]);
  useEffect(() => { setReviewer({ name: s.reviewer_name ?? '', email: s.reviewer_email ?? '', due: s.due_date ?? '' }); }, [s.reviewer_name, s.reviewer_email, s.due_date]);

  const overdue = isOverdue(s, today);
  const sorted = [...revisions].sort((a, b) => a.revision_number - b.revision_number);
  const shown = sorted.find((r) => r.revision_number === viewRev) ?? sorted[sorted.length - 1];
  const isCurrent = viewRev === s.current_revision;
  const purposes: AttachmentPurpose[] = shown?.submitted_at ? ['review'] : ['package'];
  const packageCount = isCurrent ? countByPurpose(files, 'package') : 0;
  const frozen = s.status === 'void';

  const act = (action: SubmittalAction) => {
    const check = checkAction({ action, status: s.status, currentRevision: s.current_revision, reviewerName: s.reviewer_name, packageCount, note });
    if (!check.ok) { toast(check.message, 'error'); return; }
    const go = () => run(`act-${action}`, () => transitionSubmittal(s.id, action, note), `${SUBMITTAL_ACTION_LABEL[action]} — done.`);
    if (action === 'void' || action === 'reject') {
      ask({ title: action === 'void' ? 'Void this submittal?' : 'Reject this submittal?', description: 'This is recorded in the history. A rejected submittal needs a new revision.', label: SUBMITTAL_ACTION_LABEL[action], onConfirm: go });
    } else void go();
  };

  const saveReviewer = () =>
    run('save', () => updateSubmittal(ownerId, s.id, { reviewer_name: reviewer.name.trim() || null, reviewer_email: reviewer.email.trim() || null, due_date: reviewer.due || null }), 'Saved.');

  const actions = canReview ? availableActions(s.status) : [];
  const decisions = actions.filter((a) => DECIDE_ACTIONS.includes(a));
  const primary = actions.filter((a) => !DECIDE_ACTIONS.includes(a) && a !== 'void');

  return (
    <li className={`${panelClass} !p-0`}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="focus-ring flex w-full items-start gap-3 rounded-2xl p-4 text-left">
        {open ? <ChevronDown size={16} className="mt-1 shrink-0 text-text-secondary" aria-hidden="true" /> : <ChevronRight size={16} className="mt-1 shrink-0 text-text-secondary" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">{formatSubmittalNumber(s.seq)} · {s.spec_section} — {s.title}</span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary">
            {SUBMITTAL_TYPE_LABEL[s.submittal_type]}
            {s.reviewer_name ? ` · ${s.reviewer_name}` : ' · No reviewer yet'}
            {s.due_date ? ` · needed ${formatDate(s.due_date)}` : ''}
            {phaseName ? ` · ${phaseName}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {overdue && <Pill tone="danger">Overdue</Pill>}
          <Pill>{formatRevision(s.current_revision)}</Pill>
          <Pill tone={STATUS_TONE[s.status]}>{SUBMITTAL_STATUS_LABEL[s.status]}</Pill>
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          {s.description && <p className="whitespace-pre-wrap text-sm text-text-secondary">{s.description}</p>}

          {canReview && !frozen && (
            <div className="grid gap-2 sm:grid-cols-7">
              <div className="sm:col-span-2"><Input aria-label="Reviewer name" placeholder="Reviewer" value={reviewer.name} maxLength={120} onChange={(e) => setReviewer((r) => ({ ...r, name: e.target.value }))} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2"><Input aria-label="Reviewer email" type="email" placeholder="Reviewer email" value={reviewer.email} onChange={(e) => setReviewer((r) => ({ ...r, email: e.target.value }))} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2"><Input aria-label="Needed by" type="date" value={reviewer.due} onChange={(e) => setReviewer((r) => ({ ...r, due: e.target.value }))} className="py-2 text-sm" /></div>
              <Button size="sm" variant="secondary" disabled={busyKey === 'save'} onClick={() => void saveReviewer()}>Save</Button>
            </div>
          )}

          <div>
            <h4 className="mb-2 text-sm font-semibold text-text-primary">Revisions</h4>
            <ol className="space-y-1.5">
              {sorted.map((r) => (
                <li key={r.id}>
                  <button type="button" aria-pressed={r.revision_number === viewRev} onClick={() => setViewRev(r.revision_number)} className={`focus-ring w-full rounded-xl border px-3 py-2 text-left text-sm ${r.revision_number === viewRev ? 'border-accent bg-accent/5' : 'border-border'}`}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text-primary">{formatRevision(r.revision_number)}</span>
                      <span className="text-xs text-text-secondary">{r.submitted_at ? `Submitted ${formatDateTime(r.submitted_at)}` : 'Not submitted'}</span>
                      {r.decision && <Pill tone={STATUS_TONE[r.decision]}>{SUBMITTAL_STATUS_LABEL[r.decision]}</Pill>}
                    </span>
                    {r.decision_note && <span className="mt-1 block whitespace-pre-wrap text-xs text-text-secondary">{r.decision_note}</span>}
                  </button>
                </li>
              ))}
            </ol>
          </div>

          {shown && (
            <AttachmentsPanel
              key={shown.id}
              ownerId={ownerId}
              projectId={projectId}
              parent={{ kind: 'submittal_revision', id: shown.id }}
              purposes={purposes}
              title={`${formatRevision(shown.revision_number)} files`}
              hint={shown.submitted_at ? 'This revision is submitted. The package is locked; add reviewer markup if you received any.' : 'Attach the submittal package (PDF, drawings, data sheets). It locks when you submit.'}
              canUpload={canReview && !frozen && (isCurrent || !!shown.submitted_at)}
              canDelete={(a) => canReview && !frozen && (a.purpose === 'review' || !shown.submitted_at)}
              onLoaded={(items) => { if (isCurrent) setFiles(items); }}
            />
          )}

          {canReview && actions.length > 0 && (
            <div className="space-y-2">
              {(decisions.length > 0 || actions.includes('void')) && (
                <Textarea aria-label="Note" rows={2} placeholder="Note (required for approve as noted, revise, reject and void)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="py-2 text-sm" />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {primary.map((a) => <Button key={a} size="sm" disabled={busyKey?.startsWith('act-') === true} onClick={() => act(a)}>{SUBMITTAL_ACTION_LABEL[a]}</Button>)}
                {decisions.map((a) => <Button key={a} size="sm" variant={a === 'approve' ? 'primary' : 'secondary'} disabled={busyKey?.startsWith('act-') === true} onClick={() => act(a)}>{SUBMITTAL_ACTION_LABEL[a]}</Button>)}
                {actions.includes('void') && <Button size="sm" variant="ghost" disabled={busyKey?.startsWith('act-') === true} onClick={() => act('void')}>Void</Button>}
                {s.status === 'draft' && s.current_revision === 0 && (
                  <button type="button" aria-label="Delete draft submittal" onClick={() => ask({ title: 'Delete this draft?', description: 'It was never submitted, so it can be deleted. Its files are removed too.', label: 'Delete draft', onConfirm: () => run('delete', () => deleteDraftSubmittal(ownerId, s.id), 'Draft deleted.') })} className="focus-ring ml-auto rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={16} aria-hidden="true" /></button>
                )}
              </div>
            </div>
          )}

          <ItemHistory ownerId={ownerId} itemType="submittal" itemId={s.id} refreshKey={`${s.status}-${s.current_revision}`} />
        </div>
      )}
      {dialog}
    </li>
  );
}
