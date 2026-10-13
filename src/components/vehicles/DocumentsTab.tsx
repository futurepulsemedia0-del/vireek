import { useRef, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { deleteDocument, getDocumentUrl, uploadDocument } from '@/lib/vehicleManagementApi';
import {
  DOCUMENT_TYPES, documentHealth, humanize, parseDocumentForm, validateDocumentFile,
  type DocumentFormValues, type DocumentHealth, type FieldErrors, type Vehicle, type VehicleDocument,
} from '@/lib/vehicleManagement';
import { Pill, Section, SelectField, formatBytes, formatDate, type Tone } from './shared';

interface Props {
  vehicle: Vehicle;
  documents: VehicleDocument[];
  ownerId: string;
  onChanged: () => void;
}

const HEALTH_ORDER: Record<DocumentHealth, number> = { expired: 0, expiring_soon: 1, valid: 2, no_expiry: 3 };
const HEALTH: Record<DocumentHealth, { tone: Tone; label: (days: number | null) => string }> = {
  expired: { tone: 'danger', label: (d) => `Expired ${Math.abs(d ?? 0)} days ago` },
  expiring_soon: { tone: 'warning', label: (d) => (d === 0 ? 'Expires today' : `Expires in ${d} days`) },
  valid: { tone: 'success', label: () => 'Valid' },
  no_expiry: { tone: 'neutral', label: () => 'No expiry' },
};

const emptyForm = (): DocumentFormValues => ({ doc_type: 'registration', title: '', issued_on: '', expires_on: '' });

export function DocumentsTab({ vehicle, documents, ownerId, onChanged }: Props) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showForm, setShowForm] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [form, setForm] = useState<DocumentFormValues>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VehicleDocument | null>(null);

  const now = new Date();
  const rows = documents
    .map((d) => ({ doc: d, ...documentHealth(d.expires_on, now) }))
    .sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity) || a.doc.title.localeCompare(b.doc.title));

  const close = () => { setShowForm(false); setFile(null); setFileError(''); setErrors({}); setForm(emptyForm()); if (fileRef.current) fileRef.current.value = ''; };
  const set = (k: keyof DocumentFormValues) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const pickFile = (f: File | null) => {
    setFile(f);
    setFileError(f ? validateDocumentFile(f) ?? '' : '');
    if (f && !form.title.trim()) setForm((prev) => ({ ...prev, title: f.name.replace(/\.[^.]+$/, '').slice(0, 120) }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setFileError('Choose a file to upload.'); return; }
    const fileProblem = validateDocumentFile(file);
    if (fileProblem) { setFileError(fileProblem); return; }
    const result = parseDocumentForm(form, new Date());
    if (!result.ok) { setErrors(result.errors); return; }
    setSaving(true);
    try {
      await uploadDocument(ownerId, vehicle.id, file, result.value);
      toast('Document uploaded.', 'success');
      close();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not upload the document.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const open = async (d: VehicleDocument) => {
    // Open the tab synchronously (inside the click) so popup blockers allow it, then point it at the signed URL.
    const tab = window.open('about:blank', '_blank');
    setOpening(d.id);
    try {
      const url = await getDocumentUrl(d.storage_path);
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (err) {
      tab?.close();
      toast(err instanceof Error ? err.message : 'Could not open the document.', 'error');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="space-y-4">
      {showForm && (
        <Section title="Upload a document">
          <form onSubmit={submit} noValidate className="space-y-4">
            <div>
              <label htmlFor="vehicle-doc-file" className="mb-1.5 block text-sm font-medium text-text-primary">File<span className="ms-0.5 text-danger">*</span></label>
              <input
                id="vehicle-doc-file"
                ref={fileRef}
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                aria-invalid={fileError ? true : undefined}
                aria-describedby="vehicle-doc-file-help"
                className="focus-ring block w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-secondary file:me-3 file:rounded-lg file:border-0 file:bg-bg-tertiary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text-primary"
              />
              <p id="vehicle-doc-file-help" role={fileError ? 'alert' : undefined} className={`mt-1.5 text-xs ${fileError ? 'text-danger' : 'text-text-secondary'}`}>
                {fileError || 'PDF, JPG, PNG, WebP or HEIC · up to 15 MB'}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField label="Type" value={form.doc_type} onChange={set('doc_type')} error={errors.doc_type}>
                {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
              </SelectField>
              <Input label="Title" required value={form.title} onChange={set('title')} error={errors.title} maxLength={120} placeholder="2026 insurance policy" />
              <Input label="Issued on" type="date" value={form.issued_on} onChange={set('issued_on')} error={errors.issued_on} />
              <Input label="Expires on" type="date" value={form.expires_on} onChange={set('expires_on')} error={errors.expires_on} helperText="Used for expiry reminders on the fleet overview" />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" size="sm" onClick={close} disabled={saving}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>{saving ? 'Uploading…' : 'Upload document'}</Button>
            </div>
          </form>
        </Section>
      )}

      <Section title="Documents" action={!showForm ? <Button size="sm" onClick={() => setShowForm(true)}><Plus size={16} /> Upload</Button> : undefined}>
        {rows.length === 0 ? (
          <EmptyState icon={FileText} title="No documents uploaded" description="Store the registration, insurance and permits here and get warned before they expire." action={showForm ? undefined : { label: 'Upload document', onClick: () => setShowForm(true) }} />
        ) : (
          <ul className="space-y-3">
            {rows.map(({ doc, health, daysRemaining }) => (
              <li key={doc.id} className="rounded-xl border border-border bg-bg-primary p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-text-primary">{doc.title}</p>
                    <p className="text-xs text-text-secondary">{humanize(doc.doc_type)} · {formatBytes(doc.size_bytes)}{doc.expires_on ? ` · expires ${formatDate(doc.expires_on)}` : ''}</p>
                  </div>
                  <Pill tone={HEALTH[health].tone}>{HEALTH[health].label(daysRemaining)}</Pill>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => open(doc)} disabled={opening === doc.id}>{opening === doc.id ? 'Opening…' : 'Open'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPendingDelete(doc)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this document?"
        description={`"${pendingDelete?.title ?? ''}" and its file will be permanently removed.`}
        confirmLabel="Delete document"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          try {
            await deleteDocument(target);
            toast('Document deleted.', 'success');
            onChanged();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not delete the document.', 'error');
          }
        }}
      />
    </div>
  );
}
