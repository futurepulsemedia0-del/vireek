import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, ExternalLink, FileText, Pencil, Trash2, Upload, X, History } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  DOCUMENT_ACCEPT_ATTR,
  DOCUMENT_CATEGORY_LABELS,
  EXPIRY_STATE_LABELS,
  EXPIRY_STATE_STYLES,
  describeExpiry,
  formatFileSize,
  getExpiryState,
  validateDocumentFile,
  type DocumentRecord,
  type DocumentVersion,
} from '@/lib/documents';
import {
  fetchVersions,
  openVersion,
  setDocumentExpiry,
  uploadDocumentVersion,
} from '@/lib/documentsApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60';

interface Props {
  document: DocumentRecord | null;
  ownerId: string;
  canManage: boolean;
  onClose: () => void;
  onEdit: (doc: DocumentRecord) => void;
  onDelete: (doc: DocumentRecord) => void;
  /** Called after a version upload / expiry change so the list can refresh. */
  onChanged: () => void;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function DocumentDetailPanel({
  document: doc,
  ownerId,
  canManage,
  onClose,
  onEdit,
  onDelete,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const open = Boolean(doc);
  const panelRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const docId = doc?.id ?? null;

  const loadVersions = useCallback(async () => {
    if (!docId) return;
    setLoading(true);
    setLoadError(false);
    try {
      setVersions(await fetchVersions(docId));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [docId]);

  // Reset + load whenever a different document is opened.
  useEffect(() => {
    setVersions([]);
    setFile(null);
    setNote('');
    setNewExpiry('');
    setUploadError(null);
    if (fileRef.current) fileRef.current.value = '';
    void loadVersions();
  }, [loadVersions]);

  const handleOpen = async (v: DocumentVersion, mode: 'view' | 'download') => {
    const key = `${v.id}:${mode}`;
    setBusyKey(key);
    try {
      await openVersion(v, mode);
    } catch {
      toast(
        'Could not open this file. Your session may have expired — refresh and try again.',
        'error',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handlePick = (picked: File | null) => {
    if (!picked) return;
    const problem = validateDocumentFile(picked);
    if (problem) {
      setUploadError(problem);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploadError(null);
    setFile(picked);
  };

  const handleUpload = async () => {
    if (!doc || !file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadDocumentVersion({ ownerId, documentId: doc.id, file, note });
      if (newExpiry && newExpiry !== doc.expires_on) {
        try {
          await setDocumentExpiry(doc.id, newExpiry);
        } catch {
          toast('New version saved, but the expiry date could not be updated.', 'error');
        }
      }
      toast('New version uploaded', 'success');
      setFile(null);
      setNote('');
      setNewExpiry('');
      if (fileRef.current) fileRef.current.value = '';
      await loadVersions();
      onChanged();
    } catch (err) {
      setUploadError(
        err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.',
      );
    } finally {
      setUploading(false);
    }
  };

  const state = doc ? getExpiryState(doc.expires_on, doc.alert_days) : 'none';

  return (
    <AnimatePresence>
      {doc && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm"
          />
          <motion.aside
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-detail-title"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-0 right-0 z-[95] flex w-full max-w-md flex-col border-l border-border bg-bg-secondary shadow-card-hover"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                    {DOCUMENT_CATEGORY_LABELS[doc.category]}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${EXPIRY_STATE_STYLES[state]}`}
                  >
                    {EXPIRY_STATE_LABELS[state]}
                  </span>
                </div>
                <h2
                  id="document-detail-title"
                  className="mt-2 break-words text-lg font-semibold text-text-primary"
                >
                  {doc.title}
                </h2>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {describeExpiry(doc.expires_on)}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close details"
                className="focus-ring shrink-0 rounded-lg p-1 text-text-secondary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-5">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div>
                  <dt className="text-text-secondary">Reference</dt>
                  <dd className="mt-0.5 break-words font-medium text-text-primary">
                    {doc.reference_number || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Issuer</dt>
                  <dd className="mt-0.5 break-words font-medium text-text-primary">
                    {doc.issuer || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Issued</dt>
                  <dd className="mt-0.5 font-medium text-text-primary">
                    {formatDate(doc.issued_on)}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Expires</dt>
                  <dd className="mt-0.5 font-medium text-text-primary">
                    {formatDate(doc.expires_on)}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-text-secondary">Customer</dt>
                  <dd className="mt-0.5 font-medium text-text-primary">
                    {doc.customer?.name || 'Not linked'}
                  </dd>
                </div>
                {doc.notes && (
                  <div className="col-span-2">
                    <dt className="text-text-secondary">Notes</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words text-text-primary">
                      {doc.notes}
                    </dd>
                  </div>
                )}
              </dl>

              {canManage && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(doc)}
                    className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                  >
                    <Pencil size={13} /> Edit details
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(doc)}
                    className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              )}

              <section aria-labelledby="versions-heading">
                <h3
                  id="versions-heading"
                  className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary"
                >
                  <History size={14} /> Version history
                </h3>

                {loading ? (
                  <div className="space-y-2" aria-busy="true">
                    {[0, 1].map((i) => (
                      <div key={i} className="h-14 animate-pulse rounded-xl bg-bg-tertiary" />
                    ))}
                  </div>
                ) : loadError ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-border bg-bg-primary p-4 text-center"
                  >
                    <p className="text-xs text-text-secondary">Could not load versions.</p>
                    <button
                      type="button"
                      onClick={() => void loadVersions()}
                      className="focus-ring mt-2 rounded-lg px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                    >
                      Try again
                    </button>
                  </div>
                ) : versions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-5 text-center">
                    <FileText size={20} className="mx-auto text-text-secondary" />
                    <p className="mt-2 text-xs text-text-secondary">
                      No file attached yet.{canManage ? ' Upload one below.' : ''}
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v, i) => (
                      <li key={v.id} className="rounded-xl border border-border bg-bg-primary p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                              v{v.version_number}
                              {i === 0 && (
                                <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                  Current
                                </span>
                              )}
                            </p>
                            <p
                              className="mt-0.5 truncate text-xs text-text-primary"
                              title={v.file_name}
                            >
                              {v.file_name}
                            </p>
                            <p className="mt-0.5 text-[11px] text-text-secondary">
                              {formatFileSize(v.size_bytes)} · {formatDateTime(v.created_at)}
                            </p>
                            {v.note && (
                              <p className="mt-1 break-words text-[11px] text-text-secondary">
                                “{v.note}”
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() => void handleOpen(v, 'view')}
                              aria-label={`Open version ${v.version_number}`}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                            >
                              <ExternalLink size={14} />
                            </button>
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() => void handleOpen(v, 'download')}
                              aria-label={`Download version ${v.version_number}`}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                            >
                              <Download size={14} />
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {canManage && (
                <section
                  aria-labelledby="upload-heading"
                  className="rounded-xl border border-border bg-bg-primary p-4"
                >
                  <h3 id="upload-heading" className="mb-3 text-sm font-semibold text-text-primary">
                    {versions.length === 0 ? 'Attach a file' : 'Upload a new version'}
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <input
                        ref={fileRef}
                        id="version-file"
                        type="file"
                        accept={DOCUMENT_ACCEPT_ATTR}
                        className="sr-only"
                        onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
                      />
                      <label
                        htmlFor="version-file"
                        className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                      >
                        <Upload size={16} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {file
                            ? `${file.name} · ${formatFileSize(file.size)}`
                            : 'Choose a file (max 25 MB)'}
                        </span>
                      </label>
                    </div>
                    <input
                      value={note}
                      maxLength={1000}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="What changed? (optional)"
                      aria-label="Version note"
                      className={inputClass}
                    />
                    <div>
                      <label
                        htmlFor="version-expiry"
                        className="mb-1 block text-xs text-text-secondary"
                      >
                        New expiry date (optional — for renewals)
                      </label>
                      <input
                        id="version-expiry"
                        type="date"
                        value={newExpiry}
                        onChange={(e) => setNewExpiry(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    {uploadError && (
                      <p
                        role="alert"
                        className="rounded-xl bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
                      >
                        {uploadError}
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={!file || uploading}
                      onClick={() => void handleUpload()}
                      className="focus-ring w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {uploading ? 'Uploading…' : 'Upload'}
                    </button>
                    <p className="text-[11px] leading-relaxed text-text-secondary">
                      Earlier versions are kept permanently as a record and can’t be edited.
                    </p>
                  </div>
                </section>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
