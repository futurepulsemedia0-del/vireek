import { useRef, useState } from 'react';
import { Download, FileText, Link2, Paperclip, Pencil, Plus, Trash2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { formatDate, formatMoney, type ProjectPhase } from '@/lib/installProjects';
import {
  CHANGE_ORDER_STATUS_LABEL,
  CHANGE_ORDER_TONE,
  RFI_ATTACHMENT_ACCEPT,
  RFI_DIRECTION_LABEL,
  RFI_PARTY_ROLE_LABEL,
  RFI_PRIORITY_LABEL,
  RFI_TEXT_MAX,
  canDeleteRfi,
  canTransitionRfi,
  emptyChangeOrderForm,
  formatFileSize,
  formatSignedMoney,
  isChangeOrderLinkable,
  isRfiContentEditable,
  isRfiLocked,
  parseSignedDollars,
  validateAnswer,
  validateChangeOrderForm,
  type ChangeOrder,
  type ProjectRfi,
  type RfiAttachment,
  type RfiAttachmentKind,
  type RfiFormValues,
} from '@/lib/projectRfis';
import {
  answerRfi,
  createChangeOrder,
  deleteRfi,
  deleteRfiAttachment,
  getRfiAttachmentUrl,
  linkRfiChangeOrder,
  setRfiStatus,
  updateRfi,
  uploadRfiAttachment,
} from '@/lib/projectRfisApi';
import { RfiForm } from './RfiForm';
import { Pill, compactInput, selectClass, useAction, useConfirm } from './projectUi';

interface Props {
  ownerId: string;
  rfi: ProjectRfi;
  attachments: RfiAttachment[];
  allAttachments: RfiAttachment[];
  changeOrders: ChangeOrder[];
  phases: ProjectPhase[];
  onChanged: () => Promise<void>;
}

function toForm(r: ProjectRfi): RfiFormValues {
  return {
    subject: r.subject,
    question: r.question,
    direction: r.direction,
    partyName: r.party_name,
    partyRole: r.party_role,
    priority: r.priority,
    dueDate: r.due_date ?? '',
    phaseId: r.phase_id ?? '',
    impactsCost: r.impacts_cost,
    impactsSchedule: r.impacts_schedule,
  };
}

export function RfiDetail({ ownerId, rfi, attachments, allAttachments, changeOrders, phases, onChanged }: Props) {
  const { toast } = useToast();
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(rfi.answer ?? '');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [linkId, setLinkId] = useState('');
  const [creatingCo, setCreatingCo] = useState(false);
  const [co, setCo] = useState(() => emptyChangeOrderForm(`Change order: ${rfi.subject}`.slice(0, 160)));
  const [coErrors, setCoErrors] = useState<ReturnType<typeof validateChangeOrderForm>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKind = useRef<RfiAttachmentKind>('question');

  const locked = isRfiLocked(rfi.status);
  const linked = changeOrders.find((c) => c.id === rfi.change_order_id) ?? null;
  const linkable = changeOrders.filter((c) => isChangeOrderLinkable(c.status));
  const phase = phases.find((p) => p.id === rfi.phase_id);
  const busy = busyKey !== null;

  const status = (to: ProjectRfi['status'], success: string) => run(`st-${to}`, () => setRfiStatus(ownerId, rfi.id, to), success);

  const recordAnswer = () => {
    const problem = validateAnswer(answer);
    setAnswerError(problem);
    if (!problem) void run('answer', () => answerRfi(ownerId, rfi.id, answer), 'Answer recorded.');
  };

  const pickFiles = (kind: RfiAttachmentKind) => {
    uploadKind.current = kind;
    fileRef.current?.click();
  };

  const upload = async (files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    if (fileRef.current) fileRef.current.value = '';
    if (list.length === 0) return;
    const kind = uploadKind.current;
    await run(
      `upload-${kind}`,
      async () => {
        let count = attachments.length;
        let added = 0;
        const errors: string[] = [];
        for (const f of list) {
          try {
            await uploadRfiAttachment(ownerId, rfi, f, kind, count);
            count++;
            added++;
          } catch (e) {
            errors.push(e instanceof Error ? e.message : `Could not upload ${f.name}.`);
          }
        }
        if (errors.length) {
          if (added > 0) await onChanged(); // keep what did upload visible
          throw new Error(errors.slice(0, 2).join(' '));
        }
      },
      list.length === 1 ? 'File attached.' : `${list.length} files attached.`,
    );
  };

  const download = async (a: RfiAttachment) => {
    const tab = window.open('about:blank', '_blank'); // opened first so popup blockers allow it
    try {
      const url = await getRfiAttachmentUrl(a.storage_path);
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (e) {
      tab?.close();
      toast(e instanceof Error ? e.message : 'Could not open that file.', 'error');
    }
  };

  const createAndLink = async () => {
    const errs = validateChangeOrderForm(co);
    setCoErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const ok = await run('co-create', async () => {
      const id = await createChangeOrder(ownerId, rfi.project_id, co, 'draft');
      await linkRfiChangeOrder(ownerId, rfi.id, id);
    }, 'Change order created and linked.');
    if (ok) { setCreatingCo(false); setCo(emptyChangeOrderForm()); }
  };

  if (editing) {
    return (
      <>
        <RfiForm
          mode="edit"
          initial={toForm(rfi)}
          phases={phases}
          submitting={busy}
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => { if (await run('edit', () => updateRfi(ownerId, rfi.id, v), 'RFI updated.')) setEditing(false); }}
        />
        {dialog}
      </>
    );
  }

  const files = (kind: RfiAttachmentKind, canUpload: boolean) => {
    const list = attachments.filter((a) => a.kind === kind);
    return (
      <div className="mt-3">
        {list.length > 0 && (
          <ul className="space-y-1.5">
            {list.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
                <FileText size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-text-primary">{a.file_name}</span>
                <span className="shrink-0 text-xs text-text-secondary">{formatFileSize(a.size_bytes)}</span>
                <button type="button" aria-label={`Download ${a.file_name}`} onClick={() => void download(a)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"><Download size={16} aria-hidden="true" /></button>
                {!locked && (
                  <button type="button" aria-label={`Remove ${a.file_name}`} disabled={busy} onClick={() => ask({ title: 'Remove this file?', description: `“${a.file_name}” will be removed from the RFI.`, label: 'Remove file', onConfirm: () => run(`rm-${a.id}`, () => deleteRfiAttachment(ownerId, a), 'File removed.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={16} aria-hidden="true" /></button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canUpload && (
          <Button type="button" variant="ghost" size="sm" className="mt-2" disabled={busy} onClick={() => pickFiles(kind)}>
            <Paperclip size={14} aria-hidden="true" /> {busyKey === `upload-${kind}` ? 'Uploading…' : 'Attach files'}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5 border-t border-border pt-4">
      <input ref={fileRef} type="file" multiple accept={RFI_ATTACHMENT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files)} />

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-text-secondary">{RFI_DIRECTION_LABEL[rfi.direction]}</dt><dd className="text-text-primary">{rfi.party_name} <span className="text-text-secondary">· {RFI_PARTY_ROLE_LABEL[rfi.party_role]}</span></dd></div>
        <div><dt className="text-xs text-text-secondary">Priority</dt><dd className="text-text-primary">{RFI_PRIORITY_LABEL[rfi.priority]}</dd></div>
        <div><dt className="text-xs text-text-secondary">Response due</dt><dd className="text-text-primary">{formatDate(rfi.due_date)}</dd></div>
        <div><dt className="text-xs text-text-secondary">Phase</dt><dd className="text-text-primary">{phase?.name ?? 'Whole project'}</dd></div>
        <div><dt className="text-xs text-text-secondary">Sent / opened</dt><dd className="text-text-primary">{formatDate(rfi.sent_at)}</dd></div>
        <div><dt className="text-xs text-text-secondary">Answered</dt><dd className="text-text-primary">{formatDate(rfi.answered_at)}</dd></div>
        <div><dt className="text-xs text-text-secondary">Closed</dt><dd className="text-text-primary">{formatDate(rfi.closed_at)}</dd></div>
        <div className="flex flex-wrap items-end gap-1.5">
          {rfi.impacts_cost && <Pill tone="warning">May change cost</Pill>}
          {rfi.impacts_schedule && <Pill tone="warning">May change schedule</Pill>}
        </div>
      </dl>

      <section aria-labelledby={`q-${rfi.id}`}>
        <h4 id={`q-${rfi.id}`} className="text-sm font-semibold text-text-primary">Question</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{rfi.question}</p>
        {files('question', isRfiContentEditable(rfi.status))}
      </section>

      {rfi.status !== 'draft' && (
        <section aria-labelledby={`a-${rfi.id}`}>
          <h4 id={`a-${rfi.id}`} className="text-sm font-semibold text-text-primary">Answer</h4>
          {rfi.status === 'open' ? (
            <div className="mt-2 space-y-2">
              <Textarea aria-label="Answer" rows={4} value={answer} onChange={(e) => { setAnswer(e.target.value); setAnswerError(null); }} className="py-2 text-sm" maxLength={RFI_TEXT_MAX} placeholder={rfi.direction === 'incoming' ? 'Write your response.' : 'Paste or summarize the response you received.'} error={answerError ?? undefined} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-text-secondary">Recording the answer moves this RFI to Answered.</p>
                <Button type="button" size="sm" disabled={busy} onClick={recordAnswer}>{busyKey === 'answer' ? 'Saving…' : 'Record answer'}</Button>
              </div>
            </div>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{rfi.answer || '—'}</p>
          )}
          {files('answer', rfi.status === 'open' || rfi.status === 'answered')}
        </section>
      )}

      <section aria-labelledby={`co-${rfi.id}`}>
        <h4 id={`co-${rfi.id}`} className="text-sm font-semibold text-text-primary">Change order</h4>
        {linked ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm">
            <span className="font-semibold text-text-primary">{linked.co_number}</span>
            <span className="min-w-0 flex-1 truncate text-text-primary">{linked.title}</span>
            <span className="tabular-nums text-text-secondary">{formatSignedMoney(linked.amount_cents)} · {linked.schedule_days >= 0 ? '+' : ''}{linked.schedule_days}d</span>
            <Pill tone={CHANGE_ORDER_TONE[linked.status]}>{CHANGE_ORDER_STATUS_LABEL[linked.status]}</Pill>
            {!locked && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => run('unlink', () => linkRfiChangeOrder(ownerId, rfi.id, null), 'Change order unlinked.')}><Unlink size={14} aria-hidden="true" /> Unlink</Button>}
          </div>
        ) : locked ? (
          <p className="mt-1 text-sm text-text-secondary">No change order linked.</p>
        ) : creatingCo ? (
          <div className="mt-2 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
            <Input label="Title" value={co.title} onChange={(e) => setCo({ ...co, title: e.target.value })} className={compactInput} maxLength={160} error={coErrors.title} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Price change ($, − for a credit)" inputMode="decimal" value={co.amount} onChange={(e) => setCo({ ...co, amount: e.target.value })} className={compactInput} placeholder="0.00" error={coErrors.amount} helperText={co.amount && parseSignedDollars(co.amount) !== null ? formatSignedMoney(parseSignedDollars(co.amount) ?? 0) : undefined} />
              <Input label="Schedule change (days)" inputMode="numeric" value={co.scheduleDays} onChange={(e) => setCo({ ...co, scheduleDays: e.target.value })} className={compactInput} error={coErrors.scheduleDays} />
            </div>
            <Textarea label="Description (optional)" rows={2} value={co.description} onChange={(e) => setCo({ ...co, description: e.target.value })} className="py-2 text-sm" maxLength={RFI_TEXT_MAX} error={coErrors.description} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setCreatingCo(false); setCoErrors({}); }}>Cancel</Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void createAndLink()}>{busyKey === 'co-create' ? 'Creating…' : 'Create & link'}</Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {linkable.length > 0 && (
              <>
                <select aria-label="Existing change order" className={`${selectClass} !w-auto min-w-[12rem]`} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                  <option value="">Link an existing change order…</option>
                  {linkable.map((c) => <option key={c.id} value={c.id}>{c.co_number} · {c.title} ({formatMoney(c.amount_cents)})</option>)}
                </select>
                <Button type="button" variant="secondary" size="sm" disabled={!linkId || busy} onClick={async () => { if (await run('link', () => linkRfiChangeOrder(ownerId, rfi.id, linkId), 'Change order linked.')) setLinkId(''); }}><Link2 size={14} aria-hidden="true" /> Link</Button>
              </>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setCreatingCo(true)}><Plus size={14} aria-hidden="true" /> New change order from this RFI</Button>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {rfi.status === 'draft' && <Button size="sm" disabled={busy} onClick={() => void status('open', rfi.direction === 'incoming' ? 'RFI opened.' : 'RFI marked as sent.')}>{rfi.direction === 'incoming' ? 'Open RFI' : 'Mark as sent'}</Button>}
        {rfi.status === 'answered' && <Button size="sm" disabled={busy} onClick={() => void status('closed', 'RFI closed.')}>Close RFI</Button>}
        {isRfiContentEditable(rfi.status) && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" /> Edit</Button>}
        {(rfi.status === 'answered' || rfi.status === 'closed') && canTransitionRfi(rfi.status, 'open') && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void status('open', 'RFI reopened.')}>Reopen</Button>}
        {canTransitionRfi(rfi.status, 'void') && rfi.status !== 'void' && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => ask({ title: 'Void this RFI?', description: 'It stays on the project as a voided record and stops counting toward overdue. Voided RFIs cannot be reopened.', label: 'Void RFI', onConfirm: () => status('void', 'RFI voided.') })}>Void</Button>
        )}
        {canDeleteRfi(rfi.status) && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => ask({ title: 'Delete this RFI?', description: `${rfi.rfi_number} and its files are deleted permanently.`, label: 'Delete RFI', onConfirm: () => run('delete', () => deleteRfi(ownerId, rfi, allAttachments), 'RFI deleted.') })}>
            <Trash2 size={14} aria-hidden="true" /> Delete
          </Button>
        )}
      </div>
      {dialog}
    </div>
  );
}
