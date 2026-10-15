import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Link2,
  Link2Off,
  MapPin,
  Trash2,
  X,
  Lock,
} from 'lucide-react';
import { AnnotatableImage } from '@/components/AnnotatableImage';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  MAX_ANNOTATIONS,
  PHOTO_KINDS,
  PHOTO_KIND_LABELS,
  canEditPhoto,
  jobLabelOf,
  pairCandidates,
  parseTagInput,
  partnerOf,
  type GalleryItem,
  type GalleryJob,
  type PhotoAnnotation,
  type PhotoKind,
  type PhotoPair,
} from '@/lib/gallery';
import { fullUrlFor, type PhotoPatch } from '@/lib/galleryApi';
import { formatFileSize } from '@/lib/documents';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';

interface Props {
  /** The list being browsed (prev/next walks this). */
  items: GalleryItem[];
  allItems: GalleryItem[];
  pairs: PhotoPair[];
  jobs: GalleryJob[];
  currentId: string | null;
  canManage: boolean;
  userId: string | null;
  thumbOf: (item: GalleryItem) => string | undefined;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSave: (item: GalleryItem, patch: PhotoPatch) => Promise<boolean>;
  onPair: (beforeId: string, afterId: string) => Promise<boolean>;
  onUnpair: (item: GalleryItem) => Promise<boolean>;
  onDelete: (item: GalleryItem) => void;
  onDownload: (item: GalleryItem) => void;
}

export function PhotoLightbox(props: Props) {
  const {
    items,
    allItems,
    pairs,
    jobs,
    currentId,
    canManage,
    userId,
    thumbOf,
    onClose,
    onNavigate,
    onSave,
    onPair,
    onUnpair,
    onDelete,
    onDownload,
  } = props;
  const index = items.findIndex((i) => i.id === currentId);
  const item = index >= 0 ? items[index] : null;
  const open = Boolean(item);
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const editable = item ? canEditPhoto(item, { canManage, userId }) : false;

  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState(false);
  const [caption, setCaption] = useState('');
  const [tagText, setTagText] = useState('');
  const [kind, setKind] = useState<PhotoKind>('progress');
  const [jobId, setJobId] = useState('');
  const [pins, setPins] = useState<PhotoAnnotation[]>([]);
  const [pinMode, setPinMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pairChoice, setPairChoice] = useState('');
  const [pairBusy, setPairBusy] = useState(false);

  const itemId = item?.id ?? null;

  // Load the full-size image + reset the draft whenever the photo changes.
  const loadUrl = useCallback(async (target: GalleryItem) => {
    setUrl(null);
    setUrlError(false);
    try {
      setUrl(await fullUrlFor(target));
    } catch {
      setUrlError(true);
    }
  }, []);

  useEffect(() => {
    if (!item) return;
    setCaption(item.caption);
    setTagText(item.tags.join(', '));
    setKind(item.kind);
    setJobId(item.jobId ?? '');
    setPins(item.annotations);
    setPinMode(false);
    setPairChoice('');
    void loadUrl(item);
    // Reset only when the photo identity changes, not on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, loadUrl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'))
        return;
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(items[index - 1].id);
      if (e.key === 'ArrowRight' && index < items.length - 1) onNavigate(items[index + 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, items, onNavigate]);

  const partner = item ? partnerOf(item, pairs) : null;
  const candidates = useMemo(
    () => (item ? pairCandidates(item, allItems, pairs) : []),
    [item, allItems, pairs],
  );

  if (!item) return null;

  const draftTags = parseTagInput(tagText);
  const dirty =
    caption.trim() !== item.caption ||
    kind !== item.kind ||
    jobId !== (item.jobId ?? '') ||
    draftTags.join('|') !== item.tags.join('|') ||
    JSON.stringify(pins) !== JSON.stringify(item.annotations);

  const save = async () => {
    setSaving(true);
    const ok = await onSave(item, {
      caption: caption.trim() || null,
      tags: draftTags,
      kind,
      job_id: jobId || null,
      annotations: pins,
    });
    setSaving(false);
    if (ok) setPinMode(false);
  };

  const doPair = async () => {
    const other = candidates.find((c) => c.id === pairChoice);
    if (!other) return;
    setPairBusy(true);
    await onPair(
      item.kind === 'before' ? item.id : other.id,
      item.kind === 'before' ? other.id : item.id,
    );
    setPairBusy(false);
    setPairChoice('');
  };

  const addPin = (p: PhotoAnnotation) => {
    if (pins.length >= MAX_ANNOTATIONS) return;
    setPins((prev) => [...prev, p]);
  };

  const canPair = editable && (item.kind === 'before' || item.kind === 'after') && !dirty;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm lg:flex-row"
    >
      {/* Image area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          className="focus-ring absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 lg:hidden"
        >
          <X size={18} />
        </button>
        {index > 0 && (
          <button
            type="button"
            onClick={() => onNavigate(items[index - 1].id)}
            aria-label="Previous photo"
            className="focus-ring absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <ChevronLeft size={22} />
          </button>
        )}
        {index < items.length - 1 && (
          <button
            type="button"
            onClick={() => onNavigate(items[index + 1].id)}
            aria-label="Next photo"
            className="focus-ring absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <ChevronRight size={22} />
          </button>
        )}

        <div className="w-full max-w-3xl">
          {urlError ? (
            <div role="alert" className="rounded-xl bg-bg-secondary p-8 text-center">
              <p className="text-sm text-text-secondary">Couldn’t load this photo.</p>
              <button
                type="button"
                onClick={() => void loadUrl(item)}
                className="focus-ring mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
              >
                Try again
              </button>
            </div>
          ) : !url ? (
            <div
              className="aspect-[4/3] w-full animate-pulse rounded-xl bg-white/10"
              aria-busy="true"
              aria-label="Loading photo"
            />
          ) : (
            <AnnotatableImage
              imageUrl={url}
              existingAnnotations={pins}
              editable={editable && pinMode}
              onAddPoint={addPin}
            />
          )}
        </div>
        <p
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white"
          aria-live="polite"
        >
          {index + 1} / {items.length}
        </p>
      </div>

      {/* Details */}
      <aside className="max-h-[48vh] w-full shrink-0 overflow-y-auto border-t border-border bg-bg-secondary p-5 lg:max-h-none lg:w-96 lg:border-l lg:border-t-0">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary" title={item.fileName}>
              {item.fileName}
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {new Date(item.takenAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              {item.sizeBytes ? ` · ${formatFileSize(item.sizeBytes)}` : ''}
            </p>
            {item.jobLabel && <p className="mt-0.5 text-xs text-text-secondary">{item.jobLabel}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close viewer"
            className="focus-ring hidden shrink-0 rounded-lg p-1 text-text-secondary hover:text-text-primary lg:block"
          >
            <X size={18} />
          </button>
        </div>

        {item.source === 'jobroom' && (
          <p className="mb-4 flex items-start gap-2 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
            <Lock size={13} className="mt-0.5 shrink-0" /> This photo comes from the customer
            Service Room. It can be viewed and downloaded here, but not edited.
          </p>
        )}
        {item.source === 'gallery' && !editable && (
          <p className="mb-4 flex items-start gap-2 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
            <Lock size={13} className="mt-0.5 shrink-0" /> View only — you can edit photos you
            uploaded yourself.
          </p>
        )}

        {editable ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="lb-kind" className={labelClass}>
                  Type
                </label>
                <select
                  id="lb-kind"
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
                <label htmlFor="lb-job" className={labelClass}>
                  Job
                </label>
                <select
                  id="lb-job"
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">No job</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {jobLabelOf(j) || j.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="lb-caption" className={labelClass}>
                Caption
              </label>
              <textarea
                id="lb-caption"
                rows={2}
                maxLength={1000}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="lb-tags" className={labelClass}>
                Tags
              </label>
              <input
                id="lb-tags"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="leak, kitchen"
                className={inputClass}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className={labelClass}>Pins ({pins.length})</span>
                <button
                  type="button"
                  onClick={() => setPinMode((v) => !v)}
                  aria-pressed={pinMode}
                  className={`focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium ${pinMode ? 'bg-accent text-white' : 'text-accent hover:bg-accent/10'}`}
                >
                  <MapPin size={12} /> {pinMode ? 'Done pinning' : 'Add pins'}
                </button>
              </div>
              {pins.length > 0 && (
                <ul className="space-y-1">
                  {pins.map((p, i) => (
                    <li
                      key={`${p.x}-${p.y}-${i}`}
                      className="flex items-center justify-between gap-2 rounded-lg bg-bg-primary px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate text-text-primary">
                        {p.label || `Pin ${i + 1}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPins((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove pin ${i + 1}`}
                        className="focus-ring shrink-0 rounded p-0.5 text-text-secondary hover:text-danger"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="focus-ring w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <span className="inline-block rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
              {PHOTO_KIND_LABELS[item.kind]}
            </span>
            {item.caption && (
              <p className="whitespace-pre-wrap break-words text-text-primary">{item.caption}</p>
            )}
            {item.tags.length > 0 && (
              <p className="flex flex-wrap gap-1.5">
                {item.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
                  >
                    #{t}
                  </span>
                ))}
              </p>
            )}
            {item.annotations.length > 0 && (
              <p className="text-xs text-text-secondary">
                {item.annotations.length} pin(s) on this photo.
              </p>
            )}
          </div>
        )}

        {/* Before / after pairing */}
        {(item.kind === 'before' || item.kind === 'after') && item.source === 'gallery' && (
          <section className="mt-5 border-t border-border pt-4" aria-labelledby="pair-heading">
            <h3 id="pair-heading" className="mb-2 text-xs font-semibold text-text-primary">
              Before / After
            </h3>
            {partner ? (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-2">
                {thumbOf(partner) ? (
                  <img
                    src={thumbOf(partner)}
                    alt={`${PHOTO_KIND_LABELS[partner.kind]} partner`}
                    className="h-14 w-14 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-14 w-14 shrink-0 rounded-lg bg-bg-tertiary" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text-primary">
                    Paired with the {PHOTO_KIND_LABELS[partner.kind].toLowerCase()} photo
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate(partner.id)}
                    className="focus-ring rounded text-xs text-accent hover:underline"
                  >
                    View it
                  </button>
                </div>
                {editable && (
                  <button
                    type="button"
                    onClick={() => void onUnpair(item)}
                    aria-label="Unpair"
                    className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger"
                  >
                    <Link2Off size={15} />
                  </button>
                )}
              </div>
            ) : canPair ? (
              candidates.length > 0 ? (
                <div className="flex gap-2">
                  <select
                    value={pairChoice}
                    onChange={(e) => setPairChoice(e.target.value)}
                    aria-label="Photo to pair with"
                    className={`${inputClass} flex-1`}
                  >
                    <option value="">
                      Pair with an {item.kind === 'before' ? 'after' : 'before'} photo…
                    </option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fileName} · {new Date(c.takenAt).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void doPair()}
                    disabled={!pairChoice || pairBusy}
                    className="focus-ring flex shrink-0 items-center gap-1 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <Link2 size={13} /> Pair
                  </button>
                </div>
              ) : (
                <p className="text-xs text-text-secondary">
                  No unpaired {item.kind === 'before' ? 'after' : 'before'} photos on this job yet.
                  {!item.jobId ? ' Link this photo to a job first.' : ''}
                </p>
              )
            ) : (
              <p className="text-xs text-text-secondary">
                {editable ? 'Save your changes to pair this photo.' : 'Not paired.'}
              </p>
            )}
          </section>
        )}

        <div className="mt-5 flex gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => onDownload(item)}
            className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
          >
            <Download size={14} /> Download
          </button>
          {canManage && item.source === 'gallery' && (
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10"
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
