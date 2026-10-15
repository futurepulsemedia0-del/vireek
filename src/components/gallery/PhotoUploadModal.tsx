import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ImagePlus, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  PHOTO_ACCEPT_ATTR,
  PHOTO_KINDS,
  PHOTO_KIND_LABELS,
  jobLabelOf,
  parseTagInput,
  runPool,
  validatePhotoFile,
  type GalleryJob,
  type PhotoKind,
} from '@/lib/gallery';
import { formatFileSize } from '@/lib/documents';
import { uploadPhoto } from '@/lib/galleryApi';

const MAX_BATCH = 30;
const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';

type Status = 'queued' | 'uploading' | 'done' | 'error';
interface Entry {
  key: string;
  file: File;
  status: Status;
  error?: string;
}

interface Props {
  open: boolean;
  ownerId: string;
  userId: string;
  jobs: GalleryJob[];
  defaultJobId: string | null;
  onClose: () => void;
  onUploaded: (count: number) => void;
}

export function PhotoUploadModal({
  open,
  ownerId,
  userId,
  jobs,
  defaultJobId,
  onClose,
  onUploaded,
}: Props) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [jobId, setJobId] = useState<string>(defaultJobId ?? '');
  const [kind, setKind] = useState<PhotoKind>('progress');
  const [tagText, setTagText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, () => {
    if (!busy) onClose();
  });

  useEffect(() => {
    if (open) {
      setEntries([]);
      setJobId(defaultJobId ?? '');
      setKind('progress');
      setTagText('');
      setNotice(null);
      setBusy(false);
    }
  }, [open, defaultJobId]);

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const rejected: string[] = [];
    setEntries((prev) => {
      const room = MAX_BATCH - prev.length;
      const next: Entry[] = [];
      for (const file of incoming) {
        const problem = validatePhotoFile(file);
        if (problem) rejected.push(`${file.name}: ${problem}`);
        else if (next.length < room)
          next.push({
            key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
            file,
            status: 'queued',
          });
        else rejected.push(`${file.name}: only ${MAX_BATCH} photos per upload.`);
      }
      return [...prev, ...next];
    });
    setNotice(rejected.length ? `${rejected.length} file(s) skipped — ${rejected[0]}` : null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const pending = entries.filter((e) => e.status === 'queued' || e.status === 'error');

  const patch = (key: string, p: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...p } : e)));

  const start = async () => {
    if (busy || pending.length === 0) return;
    setBusy(true);
    setNotice(null);
    const tags = parseTagInput(tagText);
    const results = await runPool(pending, 3, async (entry) => {
      patch(entry.key, { status: 'uploading', error: undefined });
      try {
        await uploadPhoto({ ownerId, userId, file: entry.file, jobId: jobId || null, kind, tags });
        patch(entry.key, { status: 'done' });
      } catch (err) {
        patch(entry.key, {
          status: 'error',
          error: err instanceof Error && err.message ? err.message : 'Upload failed',
        });
        throw err;
      }
    });
    const ok = results.filter((r) => r.ok).length;
    setBusy(false);
    if (ok > 0) onUploaded(ok);
    if (ok === pending.length) {
      toast(`${ok} photo${ok === 1 ? '' : 's'} uploaded`, 'success');
      onClose();
    } else {
      toast(
        `${ok} uploaded, ${pending.length - ok} failed. Fix the errors and press Upload again.`,
        'error',
      );
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !busy && onClose()}
            className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="photo-upload-title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[105] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="photo-upload-title" className="text-base font-semibold text-text-primary">
                  Upload photos
                </h2>
                <p className="mt-0.5 text-xs text-text-secondary">
                  JPG, PNG, WebP or HEIC · up to 15 MB each · {MAX_BATCH} at a time
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                aria-label="Close"
                className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <input
                ref={inputRef}
                id="photo-files"
                type="file"
                multiple
                accept={PHOTO_ACCEPT_ATTR}
                className="sr-only"
                onChange={(e) => addFiles(e.target.files)}
              />
              <label
                htmlFor="photo-files"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center text-sm transition-colors ${
                  dragging
                    ? 'border-accent bg-accent/5 text-accent'
                    : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40 hover:text-accent'
                }`}
              >
                <ImagePlus size={22} />
                <span className="font-medium">Take or choose photos</span>
                <span className="text-xs">or drag them here</span>
              </label>

              {notice && (
                <p
                  role="alert"
                  className="rounded-xl bg-warning-500/10 px-3 py-2 text-xs font-medium text-warning-500"
                >
                  {notice}
                </p>
              )}

              {entries.length > 0 && (
                <ul
                  className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border bg-bg-primary p-2"
                  aria-label="Selected photos"
                >
                  {entries.map((e) => (
                    <li key={e.key} className="flex items-center gap-2 px-1.5 py-1 text-xs">
                      {e.status === 'done' ? (
                        <CheckCircle2 size={14} className="shrink-0 text-success-500" />
                      ) : e.status === 'error' ? (
                        <AlertCircle size={14} className="shrink-0 text-danger" />
                      ) : e.status === 'uploading' ? (
                        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-text-primary">
                        {e.file.name}
                      </span>
                      <span className="shrink-0 text-text-secondary">
                        {e.status === 'error' ? e.error : formatFileSize(e.file.size)}
                      </span>
                      {!busy && e.status !== 'done' && (
                        <button
                          type="button"
                          onClick={() => setEntries((prev) => prev.filter((x) => x.key !== e.key))}
                          aria-label={`Remove ${e.file.name}`}
                          className="focus-ring shrink-0 rounded p-0.5 text-text-secondary hover:text-danger"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="up-kind" className={labelClass}>
                    Photo type
                  </label>
                  <select
                    id="up-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as PhotoKind)}
                    className={inputClass}
                  >
                    {PHOTO_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {PHOTO_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="up-job" className={labelClass}>
                    Job
                  </label>
                  <select
                    id="up-job"
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Not linked to a job</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {jobLabelOf(j) || j.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="up-tags" className={labelClass}>
                  Tags (comma separated, applied to all)
                </label>
                <input
                  id="up-tags"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  placeholder="leak, kitchen, water heater"
                  className={inputClass}
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={busy || pending.length === 0}
                  className="focus-ring flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy
                    ? 'Uploading…'
                    : pending.length
                      ? `Upload ${pending.length} photo${pending.length === 1 ? '' : 's'}`
                      : 'Upload'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
