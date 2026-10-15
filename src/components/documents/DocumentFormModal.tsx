import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Upload, X, FileText } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  ALERT_DAY_OPTIONS,
  DOCUMENT_ACCEPT_ATTR,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  formatFileSize,
  validateDocumentFile,
  validateDocumentInput,
  type DocumentCategory,
  type DocumentInput,
  type DocumentRecord,
} from '@/lib/documents';
import { createDocument, updateDocument, uploadDocumentVersion } from '@/lib/documentsApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';

export interface CustomerOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  ownerId: string;
  /** Existing document → edit mode. */
  document?: DocumentRecord | null;
  customers: CustomerOption[];
  /** Pre-select and lock the customer (used from a customer's profile). */
  lockedCustomerId?: string | null;
  onClose: () => void;
  onSaved: (doc: DocumentRecord | null) => void;
}

function toForm(
  doc: DocumentRecord | null | undefined,
  lockedCustomerId: string | null | undefined,
): DocumentInput {
  return {
    title: doc?.title ?? '',
    category: doc?.category ?? 'license',
    reference_number: doc?.reference_number ?? '',
    issuer: doc?.issuer ?? '',
    issued_on: doc?.issued_on ?? '',
    expires_on: doc?.expires_on ?? '',
    alert_days: doc?.alert_days ?? 30,
    notes: doc?.notes ?? '',
    customer_id: doc?.customer_id ?? lockedCustomerId ?? null,
  };
}

export function DocumentFormModal({
  open,
  ownerId,
  document: doc,
  customers,
  lockedCustomerId,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const isEdit = Boolean(doc);
  const [form, setForm] = useState<DocumentInput>(() => toForm(doc, lockedCustomerId));
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, () => {
    if (!saving) onClose();
  });

  // Reset whenever the modal is (re)opened for a different document.
  useEffect(() => {
    if (open) {
      setForm(toForm(doc, lockedCustomerId));
      setFile(null);
      setError(null);
    }
  }, [open, doc, lockedCustomerId]);

  const set = <K extends keyof DocumentInput>(key: K, value: DocumentInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pickFile = (picked: File | null) => {
    if (!picked) return;
    const problem = validateDocumentFile(picked);
    if (problem) {
      setError(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setError(null);
    setFile(picked);
    if (!form.title.trim()) set('title', picked.name.replace(/\.[^.]+$/, '').slice(0, 200));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = validateDocumentInput(form);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (doc) {
        await updateDocument(doc.id, form);
        toast('Document updated', 'success');
        onSaved(null);
        return;
      }
      const created = await createDocument(ownerId, form);
      if (file) {
        try {
          await uploadDocumentVersion({ ownerId, documentId: created.id, file });
          toast('Document saved', 'success');
        } catch {
          toast('Document saved, but the file upload failed. Open it to try again.', 'error');
        }
      } else {
        toast('Document saved', 'success');
      }
      onSaved(created);
    } catch {
      setError(
        'Could not save this document. Check your connection and permissions, then try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const lockedCustomer = lockedCustomerId ? customers.find((c) => c.id === lockedCustomerId) : null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !saving && onClose()}
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-form-title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[105] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="document-form-title" className="text-base font-semibold text-text-primary">
                  {isEdit ? 'Edit document' : 'Add document'}
                </h2>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {isEdit
                    ? 'To replace the file itself, upload a new version from the document details.'
                    : 'Files are stored privately and only opened through short-lived secure links.'}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                aria-label="Close"
                className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3" noValidate>
              <div>
                <label htmlFor="doc-title" className={labelClass}>
                  Title *
                </label>
                <input
                  id="doc-title"
                  value={form.title}
                  maxLength={200}
                  onChange={(e) => set('title', e.target.value)}
                  placeholder="e.g. State contractor license"
                  className={inputClass}
                  required
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="doc-category" className={labelClass}>
                    Category
                  </label>
                  <select
                    id="doc-category"
                    value={form.category}
                    onChange={(e) => set('category', e.target.value as DocumentCategory)}
                    className={inputClass}
                  >
                    {DOCUMENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {DOCUMENT_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="doc-ref" className={labelClass}>
                    Number / reference
                  </label>
                  <input
                    id="doc-ref"
                    value={form.reference_number}
                    maxLength={120}
                    onChange={(e) => set('reference_number', e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="doc-issuer" className={labelClass}>
                  Issuer / carrier / counterparty
                </label>
                <input
                  id="doc-issuer"
                  value={form.issuer}
                  maxLength={200}
                  onChange={(e) => set('issuer', e.target.value)}
                  className={inputClass}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="doc-issued" className={labelClass}>
                    Issued
                  </label>
                  <input
                    id="doc-issued"
                    type="date"
                    value={form.issued_on}
                    onChange={(e) => set('issued_on', e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="doc-expires" className={labelClass}>
                    Expires
                  </label>
                  <input
                    id="doc-expires"
                    type="date"
                    value={form.expires_on}
                    min={form.issued_on || undefined}
                    onChange={(e) => set('expires_on', e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="doc-alert" className={labelClass}>
                    Alert before
                  </label>
                  <select
                    id="doc-alert"
                    value={form.alert_days}
                    disabled={!form.expires_on}
                    onChange={(e) => set('alert_days', Number(e.target.value))}
                    className={`${inputClass} disabled:opacity-50`}
                  >
                    {ALERT_DAY_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d} days
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="doc-customer" className={labelClass}>
                  Attach to a customer (optional)
                </label>
                {lockedCustomerId ? (
                  <p className="rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary">
                    {lockedCustomer?.name ?? 'This customer'}
                  </p>
                ) : (
                  <select
                    id="doc-customer"
                    value={form.customer_id ?? ''}
                    onChange={(e) => set('customer_id', e.target.value || null)}
                    className={inputClass}
                  >
                    <option value="">Not linked to a customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label htmlFor="doc-notes" className={labelClass}>
                  Notes
                </label>
                <textarea
                  id="doc-notes"
                  rows={2}
                  maxLength={4000}
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  className={inputClass}
                />
              </div>

              {!isEdit && (
                <div>
                  <span className={labelClass}>File (optional — you can attach it later)</span>
                  <input
                    ref={fileRef}
                    id="doc-file"
                    type="file"
                    accept={DOCUMENT_ACCEPT_ATTR}
                    className="sr-only"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  />
                  <label
                    htmlFor="doc-file"
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-bg-primary px-3.5 py-3 text-sm text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    {file ? (
                      <FileText size={16} className="shrink-0" />
                    ) : (
                      <Upload size={16} className="shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {file
                        ? `${file.name} · ${formatFileSize(file.size)}`
                        : 'Choose a PDF, image, Word or Excel file (max 25 MB)'}
                    </span>
                  </label>
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-xs font-medium text-danger"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="focus-ring flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save document'}
                </button>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
