import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Eye, FileText, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { FormShell, Pill, Segmented, SelectField, employeeName, type HrCtx, type Tone } from '@/components/hr/HrUi';
import { useToast } from '@/contexts/ToastContext';
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  NOTE_LIMIT,
  TITLE_LIMIT,
  documentState,
  formatDay,
  isValidIsoDate,
  validateDocument,
  validateDocumentFile,
  type DocType,
  type DocumentState,
  type HrDocument,
} from '@/lib/hrOnboarding';
import {
  createDocumentRequest,
  deleteDocument,
  describeHrError,
  getDocumentUrl,
  removeDocumentFile,
  setDocumentStatus,
  updateDocumentDetails,
  uploadDocumentFile,
} from '@/lib/hrOnboardingApi';

const STATE_LABEL: Record<DocumentState, string> = { requested: 'Needed', received: 'Received', verified: 'Verified', expired: 'Expired', expiring: 'Expiring soon' };
const STATE_TONE: Record<DocumentState, Tone> = { requested: 'warning', received: 'accent', verified: 'success', expired: 'danger', expiring: 'warning' };

type Filter = 'all' | 'needed' | 'on_file' | 'attention';

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentsPanel({ ctx }: { ctx: HrCtx }) {
  const { data, today, ownerId, patch, reload } = ctx;
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [employee, setEmployee] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrDocument | null>(null);
  const uploadTarget = useRef<HrDocument | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () =>
      data.documents
        .filter((d) => (employee ? d.employee_id === employee : true))
        .filter((d) => {
          const s = documentState(d, today);
          if (filter === 'needed') return s === 'requested';
          if (filter === 'on_file') return s !== 'requested';
          if (filter === 'attention') return s === 'expired' || s === 'expiring';
          return true;
        }),
    [data.documents, employee, filter, today],
  );

  const replaceDoc = (saved: HrDocument) => patch((d) => ({ ...d, documents: d.documents.map((x) => (x.id === saved.id ? saved : x)) }));

  /** Run one document action with a busy lock and a uniform error toast. `refresh` re-reads tasks the DB may have completed. */
  const run = async (doc: HrDocument, action: () => Promise<void>, refresh = false) => {
    if (busyId) return;
    setBusyId(doc.id);
    try {
      await action();
      if (refresh && doc.task_id) await reload();
    } catch (e) {
      toast(describeHrError(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pickFile = (doc: HrDocument) => {
    uploadTarget.current = doc;
    fileInput.current?.click();
  };

  const onFileChosen = (file: File | undefined) => {
    const doc = uploadTarget.current;
    uploadTarget.current = null;
    if (fileInput.current) fileInput.current.value = '';
    if (!file || !doc) return;
    const problem = validateDocumentFile({ name: file.name, size: file.size, type: file.type });
    if (problem) {
      toast(problem, 'error');
      return;
    }
    void run(
      doc,
      async () => {
        replaceDoc(await uploadDocumentFile(ownerId, doc, file, ''));
        toast('File uploaded', 'success');
      },
      true,
    );
  };

  const view = async (doc: HrDocument) => {
    if (!doc.storage_path) return;
    const win = window.open('about:blank', '_blank'); // opened synchronously so popup blockers allow it
    if (!win) {
      toast('Allow pop-ups to view documents.', 'error');
      return;
    }
    win.opener = null;
    try {
      win.location.href = await getDocumentUrl(doc.storage_path);
    } catch (e) {
      win.close();
      toast(describeHrError(e), 'error');
    }
  };

  const confirmDelete = async () => {
    const doc = deleteTarget;
    setDeleteTarget(null);
    if (!doc) return;
    await run(doc, async () => {
      await deleteDocument(ownerId, doc);
      patch((d) => ({ ...d, documents: d.documents.filter((x) => x.id !== doc.id) }));
      toast('Document deleted', 'success');
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            label="Filter documents"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'needed', label: 'Needed' },
              { value: 'on_file', label: 'On file' },
              { value: 'attention', label: 'Expiring' },
            ]}
          />
          <div className="w-52">
            <SelectField label="Employee" value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">All employees</option>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <Button size="sm" onClick={() => setRequesting(true)} disabled={data.employees.length === 0}>
          <Plus size={16} aria-hidden="true" /> Request document
        </Button>
      </div>

      <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept="application/pdf,image/png,image/jpeg,image/webp,image/heic" onChange={(e) => onFileChosen(e.target.files?.[0])} />

      {requesting && (
        <RequestForm
          ctx={ctx}
          defaultEmployee={employee}
          onCancel={() => setRequesting(false)}
          onCreated={(doc) => {
            patch((d) => ({ ...d, documents: [doc, ...d.documents] }));
            setRequesting(false);
            toast('Document requested', 'success');
          }}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={data.documents.length === 0 ? 'No documents yet' : 'No documents match'}
          description={
            data.documents.length === 0
              ? 'Documents requested by an onboarding checklist appear here. You can also request any document, like a licence or certification, at any time.'
              : 'Try another filter or employee.'
          }
          action={data.documents.length === 0 && data.employees.length > 0 ? { label: 'Request document', onClick: () => setRequesting(true) } : undefined}
        />
      ) : (
        <ul className="space-y-2.5" aria-label="Employee documents">
          {rows.map((d) => {
            const state = documentState(d, today);
            const busy = busyId === d.id;
            return (
              <li key={d.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="break-words font-semibold text-text-primary">{d.title}</p>
                      <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>
                    </div>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {employeeName(data, d.employee_id)} · {DOC_TYPE_LABELS[d.doc_type]}
                      {d.expires_on ? ` · expires ${formatDay(d.expires_on)}` : ''}
                    </p>
                    {d.file_name && (
                      <p className="mt-0.5 break-all text-xs text-text-secondary">
                        {d.file_name} {formatSize(d.size_bytes) && `· ${formatSize(d.size_bytes)}`}
                      </p>
                    )}
                    {!d.storage_path && d.status !== 'requested' && <p className="mt-0.5 text-xs text-text-secondary">Paper / external copy — no file attached.</p>}
                    {d.notes && <p className="mt-1 break-words text-xs italic text-text-secondary">{d.notes}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => pickFile(d)}>
                      <Upload size={15} aria-hidden="true" /> {d.storage_path ? 'Replace' : 'Upload'}
                    </Button>
                    {d.storage_path && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void view(d)}>
                        <Eye size={15} aria-hidden="true" /> View
                      </Button>
                    )}
                    {d.status === 'requested' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(d, async () => replaceDoc(await setDocumentStatus(d.id, ownerId, 'received')), true)}
                      >
                        Mark received
                      </Button>
                    )}
                    {d.status === 'received' && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(d, async () => replaceDoc(await setDocumentStatus(d.id, ownerId, 'verified')))}>
                        <ShieldCheck size={15} aria-hidden="true" /> Verify
                      </Button>
                    )}
                    {d.status === 'verified' && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(d, async () => replaceDoc(await setDocumentStatus(d.id, ownerId, 'received')))}>
                        Unverify
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditId(editId === d.id ? null : d.id)}>
                      Details
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${d.title}`} onClick={() => setDeleteTarget(d)}>
                      <Trash2 size={15} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {editId === d.id && (
                  <DetailsForm
                    doc={d}
                    onCancel={() => setEditId(null)}
                    onRemoveFile={
                      d.storage_path
                        ? () =>
                            void run(d, async () => {
                              replaceDoc(await removeDocumentFile(ownerId, d));
                              setEditId(null);
                              toast('File removed — document is needed again', 'success');
                            })
                        : undefined
                    }
                    onSave={async (v) => {
                      try {
                        replaceDoc(await updateDocumentDetails(d.id, ownerId, v));
                        setEditId(null);
                        return true;
                      } catch (e) {
                        toast(describeHrError(e), 'error');
                        return false;
                      }
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this document?"
        description={deleteTarget ? `"${deleteTarget.title}"${deleteTarget.storage_path ? ' and its stored file' : ''} will be permanently deleted. This can't be undone.` : ''}
        confirmLabel="Delete document"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function RequestForm({ ctx, defaultEmployee, onCreated, onCancel }: { ctx: HrCtx; defaultEmployee: string; onCreated: (d: HrDocument) => void; onCancel: () => void }) {
  const { data, ownerId } = ctx;
  const { toast } = useToast();
  const [draft, setDraft] = useState({ employee_id: defaultEmployee || data.employees[0]?.id || '', doc_type: 'license' as DocType, title: DOC_TYPE_LABELS.license, expires_on: '', notes: '' });
  const [titleTouched, setTitleTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateDocument(draft);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      onCreated(await createDocumentRequest(ownerId, draft));
    } catch (err) {
      toast(describeHrError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell title="Request a document">
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Employee" value={draft.employee_id} error={attempted ? errors.employee_id : undefined} onChange={(e) => setDraft((d) => ({ ...d, employee_id: e.target.value }))}>
            {data.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Type"
            value={draft.doc_type}
            onChange={(e) => {
              const t = e.target.value as DocType;
              setDraft((d) => ({ ...d, doc_type: t, title: titleTouched ? d.title : DOC_TYPE_LABELS[t] }));
            }}
          >
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
          <Input
            label="Title"
            required
            maxLength={TITLE_LIMIT}
            value={draft.title}
            error={attempted ? errors.title : undefined}
            onChange={(e) => {
              setTitleTouched(true);
              setDraft((d) => ({ ...d, title: e.target.value }));
            }}
          />
          <Input label="Expires on (optional)" type="date" value={draft.expires_on} error={attempted ? errors.expires_on : undefined} onChange={(e) => setDraft((d) => ({ ...d, expires_on: e.target.value }))} />
        </div>
        <Textarea label="Notes (optional)" rows={2} value={draft.notes} maxLength={NOTE_LIMIT} error={attempted ? errors.notes : undefined} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Request document'}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}

function DetailsForm({
  doc,
  onSave,
  onCancel,
  onRemoveFile,
}: {
  doc: HrDocument;
  onSave: (v: { expires_on: string; notes: string }) => Promise<boolean>;
  onCancel: () => void;
  onRemoveFile?: () => void;
}) {
  const [expires, setExpires] = useState(doc.expires_on ?? '');
  const [notes, setNotes] = useState(doc.notes ?? '');
  const [saving, setSaving] = useState(false);
  const expiresError = expires !== '' && !isValidIsoDate(expires) ? 'Enter a valid date.' : undefined;
  const notesError = notes.length > NOTE_LIMIT ? `Notes must be ${NOTE_LIMIT} characters or fewer.` : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || expiresError || notesError) return;
    setSaving(true);
    try {
      await onSave({ expires_on: expires, notes });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-[180px_1fr]">
      <Input label="Expires on" type="date" value={expires} error={expiresError} onChange={(e) => setExpires(e.target.value)} />
      <Textarea label="Notes" rows={2} value={notes} error={notesError} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        {onRemoveFile ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemoveFile} disabled={saving}>
            Remove file
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
