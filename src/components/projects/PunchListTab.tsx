import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardCheck, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { createPunchItem, deletePunchItem, fetchPunchData, transitionPunchItem, updatePunchItem, type PunchData } from '@/lib/punchListApi';
import { fetchCanReview } from '@/lib/submittalsApi';
import { formatDate } from '@/lib/installProjects';
import { formatDateTime } from '@/lib/projectItemsCore';
import { countByPurpose, type ProjectAttachment } from '@/lib/projectAttachments';
import {
  EMPTY_PUNCH_FORM,
  PUNCH_ACTION_LABEL,
  PUNCH_PRIORITY_LABEL,
  PUNCH_STATUS_LABEL,
  checkPunchAction,
  comparePunch,
  formatPunchNumber,
  isLocked,
  isPunchOverdue,
  offeredPunchActions,
  summarizePunch,
  validatePunchForm,
  type PunchAction,
  type PunchActor,
  type PunchFormValues,
  type PunchItem,
  type PunchPriority,
  type PunchStatus,
} from '@/lib/punchList';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ItemHistory } from './ItemHistory';
import { Pill, ProgressBar, SectionHeader, Stat, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const STATUS_TONE: Record<PunchStatus, Tone> = { open: 'warning', in_progress: 'info', ready_for_review: 'info', verified: 'success', closed: 'success' };
const PRIORITY_TONE: Record<PunchPriority, Tone> = { low: 'neutral', normal: 'neutral', high: 'warning', critical: 'danger' };

type Filter = 'work' | 'review' | 'closed' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'work', label: 'To do' },
  { key: 'review', label: 'To verify' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

function matchesFilter(i: PunchItem, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'closed') return i.status === 'closed';
  if (f === 'review') return i.status === 'ready_for_review' || i.status === 'verified';
  return i.status === 'open' || i.status === 'in_progress';
}

export function PunchListTab({ ownerId, bundle, today }: TabProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { project, phases } = bundle;
  const userId = user?.id ?? null;
  const [data, setData] = useState<PunchData | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('work');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<PunchFormValues>(EMPTY_PUNCH_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, review] = await Promise.all([fetchPunchData(ownerId, project.id, userId), fetchCanReview()]);
      setData(d);
      setCanReview(review);
      setFailed(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the punch list.', 'error');
      setFailed(true);
    }
  }, [ownerId, project.id, userId, toast]);

  useEffect(() => { void load(); }, [load]);
  const { busyKey, run } = useAction(load);

  const summary = useMemo(() => summarizePunch(data?.items ?? [], today), [data, today]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((i) => matchesFilter(i, filter))
      .filter((i) => assigneeFilter === '' || (assigneeFilter === 'none' ? i.assignee_id === null : assigneeFilter === 'me' ? i.assignee_id === data?.myMemberId : i.assignee_id === assigneeFilter))
      .filter((i) => !q || `${formatPunchNumber(i.seq)} ${i.title} ${i.location}`.toLowerCase().includes(q))
      .sort(comparePunch);
  }, [data, filter, assigneeFilter, query]);

  const errors = validatePunchForm(form);
  const set = <K extends keyof PunchFormValues>(k: K, v: PunchFormValues[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    let newId: string | null = null;
    const ok = await run('create', async () => { newId = await createPunchItem(ownerId, project.id, form); }, 'Punch item added. Add a “Before” photo if you have one.');
    if (ok) {
      setForm((f) => ({ ...EMPTY_PUNCH_FORM, location: f.location, assigneeId: f.assigneeId }));
      setShowErrors(false);
      setFilter('work');
      if (newId) setExpanded(newId);
    }
  };

  if (failed && !data) return <EmptyStateError icon={ClipboardCheck} title="Could not load the punch list" onRetry={() => void load()} />;
  if (!data) return <div className="space-y-3" aria-busy="true" aria-label="Loading punch list"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>;

  const err = (k: keyof PunchFormValues) => (showErrors ? errors[k] : undefined);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Closed" value={`${summary.closedPercent}%`} hint={`${summary.closed} of ${summary.total} items`} tone={summary.total > 0 && summary.remaining === 0 ? 'success' : undefined} />
        <Stat label="Remaining" value={summary.remaining} hint={`${summary.open + summary.inProgress} to fix`} />
        <Stat label="To verify" value={summary.awaitingVerification + summary.verified} hint="Fixed or verified, not closed" />
        <Stat label="Overdue" value={summary.overdue} hint={summary.critical > 0 ? `${summary.critical} critical open` : 'Past the due date'} tone={summary.overdue > 0 || summary.critical > 0 ? 'danger' : undefined} />
      </div>
      {summary.total > 0 && <ProgressBar value={summary.closedPercent} label="Punch list closed" tone={summary.remaining === 0 ? 'success' : 'info'} />}

      <section>
        <SectionHeader
          title="Punch list"
          description="Log deficiencies with a location and photo, assign them, then verify and close each one."
          action={<Button size="sm" onClick={() => setAdding((a) => !a)}><Plus size={14} aria-hidden="true" /> {adding ? 'Close form' : 'Add item'}</Button>}
        />

        {adding && (
          <form onSubmit={submit} noValidate className={`${panelClass} mb-4 space-y-3`}>
            <div className="grid gap-3 sm:grid-cols-6">
              <div className="sm:col-span-4"><Input label="What needs fixing?" placeholder="Scuffed drywall at return grille" value={form.title} maxLength={160} onChange={(e) => set('title', e.target.value)} error={err('title')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2"><Input label="Location" placeholder="Kitchen, north wall" value={form.location} maxLength={160} onChange={(e) => set('location', e.target.value)} error={err('location')} className="py-2 text-sm" /></div>
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="pl-priority">Priority</label>
                <select id="pl-priority" className={selectClass} value={form.priority} onChange={(e) => set('priority', e.target.value as PunchPriority)}>
                  {(Object.keys(PUNCH_PRIORITY_LABEL) as PunchPriority[]).map((p) => <option key={p} value={p}>{PUNCH_PRIORITY_LABEL[p]}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="pl-assignee">Assignee</label>
                <select id="pl-assignee" className={selectClass} value={form.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
                  <option value="">Unassigned</option>
                  {data.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2"><Input label="Due" type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="py-2 text-sm" /></div>
              <div className="sm:col-span-6">
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="pl-phase">Phase</label>
                <select id="pl-phase" className={selectClass} value={form.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
                  <option value="">Any phase</option>
                  {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-6"><Textarea label="Details (optional)" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} error={err('description')} className="py-2 text-sm" /></div>
            </div>
            <div className="flex justify-end"><Button type="submit" size="sm" disabled={busyKey === 'create'}>Add punch item</Button></div>
          </form>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter punch items" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
            ))}
          </div>
          <select aria-label="Filter by assignee" className={`${selectClass} !w-auto !py-1.5`} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="">Everyone</option>
            {data.myMemberId && <option value="me">Assigned to me</option>}
            <option value="none">Unassigned</option>
            {data.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div className="min-w-[12rem] flex-1 sm:max-w-xs"><Input aria-label="Search punch items" icon={Search} placeholder="Search number, title, location…" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" /></div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title={data.items.length === 0 ? 'No punch items yet' : 'Nothing matches this view'} description={data.items.length === 0 ? 'Walk the site, add each deficiency with a location and photo, and assign it.' : 'Try another filter or clear the search.'} />
        ) : (
          <ul className="space-y-2">
            {visible.map((i) => (
              <PunchRow
                key={i.id}
                item={i}
                open={expanded === i.id}
                onToggle={() => setExpanded((cur) => (cur === i.id ? null : i.id))}
                data={data}
                ownerId={ownerId}
                projectId={project.id}
                userId={userId}
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
  item: PunchItem;
  open: boolean;
  onToggle: () => void;
  data: PunchData;
  ownerId: string;
  projectId: string;
  userId: string | null;
  today: string;
  canReview: boolean;
  reload: () => Promise<void>;
}

function PunchRow({ item, open, onToggle, data, ownerId, projectId, userId, today, canReview, reload }: RowProps) {
  const { toast } = useToast();
  const { ask, dialog } = useConfirm();
  const { busyKey, run } = useAction(reload);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<ProjectAttachment[]>([]);

  useEffect(() => { setNote(''); }, [item.status]);

  const actor: PunchActor = {
    isReviewer: canReview,
    isAssignee: data.myMemberId !== null && item.assignee_id === data.myMemberId,
    isAccountOwner: userId !== null && userId === ownerId,
    userId,
  };
  const afterPhotoCount = countByPurpose(files, 'after');
  const assignee = data.assignees.find((a) => a.id === item.assignee_id);
  const overdue = isPunchOverdue(item, today);
  const locked = isLocked(item.status);

  // Hide buttons the person can never use here; explain the rest when clicked.
  const offered = offeredPunchActions(item.status).filter((a) => {
    const probe = checkPunchAction({ action: a, item, actor, afterPhotoCount: 99, note: 'probe' });
    return probe.ok || (probe.code !== 'not_authorized' && probe.code !== 'invalid_transition');
  });
  const needsNote = offered.some((a) => a === 'reject' || a === 'reopen');

  const act = (action: PunchAction) => {
    const check = checkPunchAction({ action, item, actor, afterPhotoCount, note });
    if (!check.ok) { toast(check.message, 'error'); return; }
    const go = () => run(`act-${action}`, () => transitionPunchItem(item.id, action, note), `${PUNCH_ACTION_LABEL[action]} — done.`);
    if (action === 'verify_close' || action === 'close') {
      ask({ title: 'Close this item?', description: 'A closed item can no longer be edited. You can still reopen it with a note.', label: 'Close item', onConfirm: go });
    } else void go();
  };

  const patch = (values: Parameters<typeof updatePunchItem>[2]) => run('patch', () => updatePunchItem(ownerId, item.id, values));

  return (
    <li className={`${panelClass} !p-0`}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="focus-ring flex w-full items-start gap-3 rounded-2xl p-4 text-left">
        {open ? <ChevronDown size={16} className="mt-1 shrink-0 text-text-secondary" aria-hidden="true" /> : <ChevronRight size={16} className="mt-1 shrink-0 text-text-secondary" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">{formatPunchNumber(item.seq)} · {item.title}</span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary">
            {item.location}
            {assignee ? ` · ${assignee.name}` : ' · Unassigned'}
            {item.due_date ? ` · due ${formatDate(item.due_date)}` : ''}
            {item.reopen_count > 0 ? ` · reopened ${item.reopen_count}×` : ''}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {overdue && <Pill tone="danger">Overdue</Pill>}
          {(item.priority === 'high' || item.priority === 'critical') && <Pill tone={PRIORITY_TONE[item.priority]}>{PUNCH_PRIORITY_LABEL[item.priority]}</Pill>}
          <Pill tone={STATUS_TONE[item.status]}>{PUNCH_STATUS_LABEL[item.status]}</Pill>
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          {item.description && <p className="whitespace-pre-wrap text-sm text-text-secondary">{item.description}</p>}
          {item.fix_note && <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary"><span className="font-semibold text-text-primary">Fix note: </span>{item.fix_note}</p>}
          {item.fixed_at && <p className="text-xs text-text-secondary">Marked fixed {formatDateTime(item.fixed_at)}{item.verified_at ? ` · verified ${formatDateTime(item.verified_at)}` : ''}{item.closed_at ? ` · closed ${formatDateTime(item.closed_at)}` : ''}</p>}

          {canReview && item.status !== 'closed' && (
            <div className="grid gap-2 sm:grid-cols-3">
              <select aria-label="Assignee" className={selectClass} value={item.assignee_id ?? ''} disabled={busyKey === 'patch'} onChange={(e) => void patch({ assignee_id: e.target.value || null })}>
                <option value="">Unassigned</option>
                {data.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select aria-label="Priority" className={selectClass} value={item.priority} disabled={busyKey === 'patch'} onChange={(e) => void patch({ priority: e.target.value as PunchPriority })}>
                {(Object.keys(PUNCH_PRIORITY_LABEL) as PunchPriority[]).map((p) => <option key={p} value={p}>{PUNCH_PRIORITY_LABEL[p]} priority</option>)}
              </select>
              <Input aria-label="Due date" type="date" value={item.due_date ?? ''} disabled={busyKey === 'patch'} onChange={(e) => void patch({ due_date: e.target.value || null })} className="py-2 text-sm" />
            </div>
          )}

          <AttachmentsPanel
            ownerId={ownerId}
            projectId={projectId}
            parent={{ kind: 'punch_item', id: item.id }}
            purposes={['before', 'after', 'general']}
            title="Photos & files"
            hint={locked ? 'Evidence is locked while the item is being verified. Send it back to add more.' : 'Add a “Before” photo of the problem and an “After” photo of the fix — the After photo is required to mark it fixed.'}
            canUpload={item.status !== 'closed'}
            canDelete={(a) => !locked && (canReview || a.uploaded_by === userId)}
            onLoaded={setFiles}
          />

          {offered.length > 0 && (
            <div className="space-y-2">
              <Textarea aria-label="Note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={needsNote ? 'Note (required to send back or reopen)' : 'Note (optional)'} className="py-2 text-sm" />
              <div className="flex flex-wrap items-center gap-2">
                {offered.map((a) => (
                  <Button key={a} size="sm" variant={a === 'reject' || a === 'reopen' ? 'secondary' : 'primary'} disabled={busyKey?.startsWith('act-') === true} onClick={() => act(a)}>{PUNCH_ACTION_LABEL[a]}</Button>
                ))}
                {canReview && item.status !== 'closed' && (
                  <button type="button" aria-label="Delete punch item" onClick={() => ask({ title: 'Delete this item?', description: `${formatPunchNumber(item.seq)} and its photos will be deleted permanently.`, label: 'Delete item', onConfirm: () => run('delete', () => deletePunchItem(ownerId, item.id), 'Item deleted.') })} className="focus-ring ml-auto rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={16} aria-hidden="true" /></button>
                )}
              </div>
            </div>
          )}

          <ItemHistory ownerId={ownerId} itemType="punch" itemId={item.id} refreshKey={`${item.status}-${item.reopen_count}`} />
        </div>
      )}
      {dialog}
    </li>
  );
}
