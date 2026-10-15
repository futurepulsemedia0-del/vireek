import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Images,
  Upload,
  Search,
  CheckSquare,
  X,
  Download,
  Tag,
  Link2,
  Trash2,
  TriangleAlert,
  RefreshCw,
  Check,
  Layers,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { BeforeAfterSlider } from '@/components/gallery/BeforeAfterSlider';
import { PhotoLightbox } from '@/components/gallery/PhotoLightbox';
import { PhotoUploadModal } from '@/components/gallery/PhotoUploadModal';
import { useGalleryScope } from '@/hooks/useGalleryScope';
import {
  GALLERY_FETCH_LIMIT,
  PHOTO_KINDS,
  PHOTO_KIND_LABELS,
  buildPairs,
  canEditPhoto,
  checkBulkLimits,
  collectTags,
  filterItems,
  groupByDay,
  itemFromRow,
  jobLabelOf,
  legacyItemsFromJobs,
  mergeTags,
  parseTagInput,
  resolvePairSelection,
  runPool,
  sortByNewest,
  type GalleryItem,
  type GalleryJob,
  type PhotoKind,
} from '@/lib/gallery';
import {
  SIGNED_URL_TTL,
  deletePhotos,
  downloadOne,
  downloadZip,
  fetchGalleryJobs,
  fetchPhotoRows,
  legacyPublicUrl,
  pairPhotos,
  signPaths,
  unpairPhoto,
  updatePhoto,
  type PhotoPatch,
} from '@/lib/galleryApi';
import type { JobPhotoRow } from '@/lib/gallery';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

const KIND_BADGE: Record<PhotoKind, string> = {
  before: 'bg-warning-500 text-white',
  after: 'bg-success-500 text-white',
  progress: 'bg-black/60 text-white',
  other: 'bg-black/60 text-white',
};

type Tab = 'photos' | 'pairs';

function dayLabel(key: string): string {
  if (key === 'unknown') return 'Unknown date';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function GalleryPage() {
  const { toast } = useToast();
  const { accountOwnerId, userId, canManage, ready } = useGalleryScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<JobPhotoRow[]>([]);
  const [jobs, setJobs] = useState<GalleryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [fullUrls, setFullUrls] = useState<Map<string, string>>(new Map());

  const [tab, setTab] = useState<Tab>('photos');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PhotoKind | 'all'>('all');
  const [jobId, setJobId] = useState<string>(searchParams.get('job') ?? 'all');
  const [tag, setTag] = useState<string>('all');

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewId, setViewId] = useState<string | null>(searchParams.get('photo'));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<GalleryItem[]>([]);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagText, setBulkTagText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const resignedRef = useRef(false);

  // ---------- data ----------
  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoadError(false);
    try {
      const [photoRows, jobRows] = await Promise.all([
        fetchPhotoRows(accountOwnerId),
        fetchGalleryJobs(accountOwnerId),
      ]);
      setRows(photoRows);
      setJobs(jobRows);
      const signed = await signPaths(photoRows.map((r) => r.thumb_path ?? r.storage_path));
      setThumbs(signed);
      resignedRef.current = false;
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void load();
  }, [ready, load]);

  // Signed URLs expire (1h): refresh quietly before that, and once on any image error.
  useEffect(() => {
    if (rows.length === 0) return;
    const id = window.setInterval(
      () => {
        void signPaths(rows.map((r) => r.thumb_path ?? r.storage_path)).then(setThumbs);
      },
      (SIGNED_URL_TTL - 300) * 1000,
    );
    return () => window.clearInterval(id);
  }, [rows]);

  const onThumbError = useCallback(() => {
    if (resignedRef.current || rows.length === 0) return;
    resignedRef.current = true;
    void signPaths(rows.map((r) => r.thumb_path ?? r.storage_path)).then(setThumbs);
  }, [rows]);

  const jobMap = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const allItems = useMemo(
    () => sortByNewest([...rows.map((r) => itemFromRow(r, jobMap)), ...legacyItemsFromJobs(jobs)]),
    [rows, jobs, jobMap],
  );
  const pairs = useMemo(() => buildPairs(allItems), [allItems]);
  const tags = useMemo(() => collectTags(allItems), [allItems]);
  const visible = useMemo(
    () => filterItems(allItems, { query, kind, jobId, tag }),
    [allItems, query, kind, jobId, tag],
  );
  // Keep the open photo navigable even if an edit makes it drop out of the current filter.
  const viewerItems = useMemo(() => {
    if (!viewId || visible.some((v) => v.id === viewId)) return visible;
    const current = allItems.find((a) => a.id === viewId);
    return current ? [...visible, current] : visible;
  }, [visible, allItems, viewId]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const visiblePairs = useMemo(() => {
    const ids = new Set(visible.map((v) => v.id));
    return pairs.filter((p) => ids.has(p.before.id) || ids.has(p.after.id));
  }, [pairs, visible]);

  const thumbOf = useCallback(
    (it: GalleryItem) =>
      it.source === 'jobroom' ? legacyPublicUrl(it.path) : thumbs.get(it.thumbPath ?? it.path),
    [thumbs],
  );

  // Full-size images for the before/after sliders.
  useEffect(() => {
    if (tab !== 'pairs' || visiblePairs.length === 0) return;
    const paths = visiblePairs.flatMap((p) => [p.before.path, p.after.path]);
    let cancelled = false;
    void signPaths(paths).then((m) => {
      if (!cancelled) setFullUrls(m);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, visiblePairs]);

  // ---------- helpers ----------
  const syncParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const openViewer = (id: string | null) => {
    setViewId(id);
    syncParam('photo', id);
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setBulkTagOpen(false);
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedItems = useMemo(
    () => allItems.filter((i) => selected.has(i.id)),
    [allItems, selected],
  );
  const ctx = { canManage, userId };
  const editableSelected = selectedItems.filter((i) => canEditPhoto(i, ctx));
  const deletableSelected = canManage ? selectedItems.filter((i) => i.source === 'gallery') : [];

  const hasFilters = query.trim() !== '' || kind !== 'all' || jobId !== 'all' || tag !== 'all';
  const clearFilters = () => {
    setQuery('');
    setKind('all');
    setJobId('all');
    setTag('all');
  };

  // ---------- actions ----------
  const handleSave = async (item: GalleryItem, patch: PhotoPatch): Promise<boolean> => {
    try {
      await updatePhoto(item.id, patch);
      await load();
      toast('Photo updated', 'success');
      return true;
    } catch {
      toast('Could not save changes. You may not have permission to edit this photo.', 'error');
      return false;
    }
  };

  const doPair = async (beforeId: string, afterId: string): Promise<boolean> => {
    try {
      await pairPhotos(beforeId, afterId);
      await load();
      toast('Photos paired', 'success');
      return true;
    } catch (err) {
      toast(
        err instanceof Error && err.message ? err.message : 'Could not pair these photos.',
        'error',
      );
      return false;
    }
  };

  const doUnpair = async (item: GalleryItem): Promise<boolean> => {
    try {
      await unpairPhoto(item.id);
      await load();
      toast('Photos unpaired', 'success');
      return true;
    } catch {
      toast('Could not unpair these photos.', 'error');
      return false;
    }
  };

  const bulkPair = async () => {
    const result = resolvePairSelection(selectedItems);
    if (typeof result === 'string') {
      toast(result, 'error');
      return;
    }
    if (await doPair(result.before, result.after)) exitSelect();
  };

  const bulkTag = async () => {
    const added = parseTagInput(bulkTagText);
    if (added.length === 0 || editableSelected.length === 0) return;
    setBusy('tag');
    const results = await runPool(editableSelected, 4, (it) =>
      updatePhoto(it.id, { tags: mergeTags(it.tags, added) }),
    );
    const failed = results.filter((r) => !r.ok).length;
    await load();
    setBusy(null);
    toast(
      failed
        ? `Tagged ${results.length - failed}, ${failed} failed.`
        : `Tagged ${results.length} photo${results.length === 1 ? '' : 's'}`,
      failed ? 'error' : 'success',
    );
    setBulkTagOpen(false);
    setBulkTagText('');
  };

  const bulkDownload = async (items: GalleryItem[]) => {
    const problem = checkBulkLimits(items);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setBusy('zip:0');
    try {
      const res = await downloadZip(items, (done, total) =>
        setBusy(`zip:${Math.round((done / total) * 100)}`),
      );
      toast(
        res.failed
          ? `Downloaded ${res.added} photos (${res.failed} couldn’t be fetched).`
          : `Downloaded ${res.added} photos`,
        res.failed ? 'error' : 'success',
      );
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Download failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const singleDownload = async (item: GalleryItem) => {
    try {
      await downloadOne(item);
    } catch {
      toast('Could not download this photo.', 'error');
    }
  };

  const confirmDelete = async () => {
    const targets = deleting;
    try {
      await deletePhotos(targets);
      toast(`${targets.length} photo${targets.length === 1 ? '' : 's'} deleted`, 'success');
      if (viewId && targets.some((t) => t.id === viewId)) openViewer(null);
      exitSelect();
      await load();
    } catch {
      toast('Could not delete. You may not have permission.', 'error');
    } finally {
      setDeleting([]);
    }
  };

  // ---------- render ----------
  if (!ready) {
    return (
      <DashboardLayout activeLabel="Gallery">
        <div className="space-y-4" aria-busy="true">
          <div className="h-10 w-64 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-xl bg-bg-tertiary" />
            ))}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const zipPct = busy?.startsWith('zip:') ? Number(busy.slice(4)) : null;

  return (
    <DashboardLayout activeLabel="Gallery">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Images size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Gallery</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every job photo in one place — search, tag, pin, pair before/after and download.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {allItems.length > 0 && (
            <button
              type="button"
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              aria-pressed={selectMode}
              className={`focus-ring flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium ${
                selectMode
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary'
              }`}
            >
              <CheckSquare size={15} /> {selectMode ? 'Cancel' : 'Select'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            <Upload size={15} /> Upload photos
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading gallery">
          <div className="h-11 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-xl bg-bg-tertiary" />
            ))}
          </div>
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-border bg-bg-secondary px-6 py-12 text-center"
        >
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <TriangleAlert size={22} />
          </span>
          <h3 className="mt-3 text-base font-semibold text-text-primary">
            Couldn’t load the gallery
          </h3>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
          >
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={Images}
          title="No photos yet"
          description="Upload job photos from the field or the office. They’re private to your team, searchable, and ready to pair as before/after proof."
          action={{ label: 'Upload your first photos', onClick: () => setUploadOpen(true) }}
        />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Gallery views"
            className="mb-4 inline-flex rounded-xl bg-bg-tertiary p-1"
          >
            {(
              [
                ['photos', 'All photos', allItems.length],
                ['pairs', 'Before & After', pairs.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`focus-ring rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
                  tab === key
                    ? 'bg-bg-secondary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {label} <span className="ml-1 text-text-secondary">{count}</span>
              </button>
            ))}
          </div>

          <div className="mb-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_220px_160px]">
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search captions, tags, jobs, pin notes…"
                  aria-label="Search photos"
                  className={`${inputClass} pl-9`}
                />
              </div>
              <select
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                aria-label="Filter by job"
                className={inputClass}
              >
                <option value="all">All jobs</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {jobLabelOf(j) || j.id}
                  </option>
                ))}
              </select>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PhotoKind | 'all')}
                aria-label="Filter by type"
                className={inputClass}
              >
                <option value="all">All types</option>
                {PHOTO_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PHOTO_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            {tags.length > 0 && (
              <div
                className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
                role="group"
                aria-label="Filter by tag"
              >
                {tags.slice(0, 20).map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => setTag(tag === t.tag ? 'all' : t.tag)}
                    aria-pressed={tag === t.tag}
                    className={`focus-ring shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      tag === t.tag
                        ? 'bg-accent text-white'
                        : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    #{t.tag} <span className="opacity-60">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-text-secondary" aria-live="polite">
              Showing {visible.length} of {allItems.length} photos
              {rows.length >= GALLERY_FETCH_LIMIT ? ` · newest ${GALLERY_FETCH_LIMIT} loaded` : ''}
            </p>
          </div>

          {tab === 'photos' ? (
            visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-12 text-center">
                <p className="text-sm text-text-secondary">No photos match these filters.</p>
                {hasFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="focus-ring mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className={selectMode ? 'pb-24' : ''}>
                {groups.map((g) => (
                  <section key={g.key} className="mb-6" aria-label={dayLabel(g.key)}>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      {dayLabel(g.key)}
                    </h2>
                    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                      {g.items.map((it) => {
                        const url = thumbOf(it);
                        const isSel = selected.has(it.id);
                        return (
                          <li key={it.id}>
                            <button
                              type="button"
                              onClick={() => (selectMode ? toggleSelect(it.id) : openViewer(it.id))}
                              aria-label={`${PHOTO_KIND_LABELS[it.kind]} photo${it.caption ? `: ${it.caption}` : `, ${it.fileName}`}`}
                              aria-pressed={selectMode ? isSel : undefined}
                              className={`focus-ring group relative block aspect-square w-full overflow-hidden rounded-xl bg-bg-tertiary ${isSel ? 'ring-2 ring-accent' : ''}`}
                            >
                              {url ? (
                                <img
                                  src={url}
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                  onError={it.source === 'gallery' ? onThumbError : undefined}
                                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                                />
                              ) : (
                                <div className="h-full w-full animate-pulse bg-bg-tertiary" />
                              )}
                              <span
                                className={`absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${KIND_BADGE[it.kind]}`}
                              >
                                {PHOTO_KIND_LABELS[it.kind]}
                              </span>
                              {selectMode && (
                                <span
                                  className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 ${isSel ? 'border-accent bg-accent text-white' : 'border-white bg-black/30'}`}
                                >
                                  {isSel && <Check size={12} />}
                                </span>
                              )}
                              <span className="absolute bottom-1.5 left-1.5 flex gap-1">
                                {it.pairId && pairs.some((p) => p.pairId === it.pairId) && (
                                  <span
                                    className="rounded-full bg-black/60 p-1 text-white"
                                    title="Paired"
                                  >
                                    <Link2 size={10} />
                                  </span>
                                )}
                                {it.annotations.length > 0 && (
                                  <span className="rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                                    {it.annotations.length} pin
                                    {it.annotations.length === 1 ? '' : 's'}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )
          ) : visiblePairs.length === 0 ? (
            <EmptyState
              icon={Layers}
              title={
                pairs.length === 0 ? 'No before & after pairs yet' : 'No pairs match these filters'
              }
              description={
                pairs.length === 0
                  ? 'Mark photos as Before or After, then open one and choose “Pair with…”, or select one of each and press Pair.'
                  : 'Try clearing the search or filters.'
              }
              action={hasFilters ? { label: 'Clear filters', onClick: clearFilters } : undefined}
            />
          ) : (
            <ul className="grid gap-5 md:grid-cols-2">
              {visiblePairs.map((p) => {
                const label = p.after.jobLabel || p.after.caption || p.after.fileName;
                return (
                  <li
                    key={p.pairId}
                    className="rounded-2xl border border-border bg-bg-secondary p-3"
                  >
                    <BeforeAfterSlider
                      beforeUrl={fullUrls.get(p.before.path)}
                      afterUrl={fullUrls.get(p.after.path)}
                      label={label}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{label}</p>
                        <p className="text-[11px] text-text-secondary">
                          {new Date(p.after.takenAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => openViewer(p.before.id)}
                          className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                        >
                          Before
                        </button>
                        <button
                          type="button"
                          onClick={() => openViewer(p.after.id)}
                          className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                        >
                          After
                        </button>
                        <button
                          type="button"
                          onClick={() => void bulkDownload([p.before, p.after])}
                          disabled={busy !== null}
                          aria-label="Download both photos"
                          className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                        >
                          <Download size={14} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div
          className="fixed inset-x-0 bottom-0 z-[80] border-t border-border bg-bg-secondary/95 px-4 py-3 shadow-card-hover backdrop-blur"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
            <p className="mr-auto text-sm font-medium text-text-primary" aria-live="polite">
              {selected.size} selected
              {zipPct !== null && (
                <span className="ml-2 text-xs text-text-secondary">Preparing ZIP… {zipPct}%</span>
              )}
            </p>
            {visible.length > 0 && selected.size < visible.length && (
              <button
                type="button"
                onClick={() => setSelected(new Set(visible.slice(0, 100).map((v) => v.id)))}
                className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
              >
                Select shown (max 100)
              </button>
            )}
            <button
              type="button"
              disabled={selected.size === 0 || busy !== null}
              onClick={() => void bulkDownload(selectedItems)}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Download size={13} /> Download ZIP
            </button>
            <button
              type="button"
              disabled={editableSelected.length === 0 || busy !== null}
              onClick={() => setBulkTagOpen((v) => !v)}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3.5 py-2 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
            >
              <Tag size={13} /> Tag
            </button>
            <button
              type="button"
              disabled={selected.size !== 2 || busy !== null}
              onClick={() => void bulkPair()}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3.5 py-2 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
            >
              <Link2 size={13} /> Pair
            </button>
            {canManage && (
              <button
                type="button"
                disabled={deletableSelected.length === 0 || busy !== null}
                onClick={() => setDeleting(deletableSelected)}
                className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3.5 py-2 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                <Trash2 size={13} /> Delete
              </button>
            )}
            <button
              type="button"
              onClick={exitSelect}
              aria-label="Exit selection mode"
              className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>
          {bulkTagOpen && (
            <div className="mx-auto mt-3 flex max-w-5xl gap-2">
              <input
                value={bulkTagText}
                onChange={(e) => setBulkTagText(e.target.value)}
                placeholder={`Add tags to ${editableSelected.length} photo(s): leak, kitchen`}
                aria-label="Tags to add"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void bulkTag()}
                disabled={busy !== null || parseTagInput(bulkTagText).length === 0}
                className="focus-ring shrink-0 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy === 'tag' ? 'Tagging…' : 'Apply'}
              </button>
            </div>
          )}
        </div>
      )}

      {accountOwnerId && userId && (
        <PhotoUploadModal
          open={uploadOpen}
          ownerId={accountOwnerId}
          userId={userId}
          jobs={jobs}
          defaultJobId={jobId !== 'all' ? jobId : null}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => void load()}
        />
      )}

      <PhotoLightbox
        items={viewerItems}
        allItems={allItems}
        pairs={pairs}
        jobs={jobs}
        currentId={viewId}
        canManage={canManage}
        userId={userId}
        thumbOf={thumbOf}
        onClose={() => openViewer(null)}
        onNavigate={(id) => openViewer(id)}
        onSave={handleSave}
        onPair={doPair}
        onUnpair={doUnpair}
        onDelete={(it) => setDeleting([it])}
        onDownload={(it) => void singleDownload(it)}
      />

      <ConfirmDialog
        open={deleting.length > 0}
        title={`Delete ${deleting.length} photo${deleting.length === 1 ? '' : 's'}?`}
        description="The photo files are permanently removed, including any tags, pins and before/after pairing. This can't be undone."
        confirmLabel="Yes, delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting([])}
      />
    </DashboardLayout>
  );
}
