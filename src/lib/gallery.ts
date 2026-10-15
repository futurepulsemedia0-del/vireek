import { formatFileSize } from '@/lib/documents';

// ============================================================
// TYPES & CONSTANTS
// ============================================================

export type PhotoKind = 'before' | 'after' | 'progress' | 'other';
export const PHOTO_KINDS: PhotoKind[] = ['before', 'after', 'progress', 'other'];
export const PHOTO_KIND_LABELS: Record<PhotoKind, string> = {
  before: 'Before',
  after: 'After',
  progress: 'Progress',
  other: 'Other',
};

/** Same shape the Expert Assist annotator already uses (x/y are 0..1 of the image). */
export interface PhotoAnnotation {
  x: number;
  y: number;
  type: 'circle' | 'arrow' | 'label';
  label?: string;
}

/** Row of the job_photos table. */
export interface JobPhotoRow {
  id: string;
  user_id: string;
  job_id: string | null;
  customer_id: string | null;
  storage_path: string;
  thumb_path: string | null;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  width: number | null;
  height: number | null;
  kind: PhotoKind;
  pair_id: string | null;
  caption: string | null;
  tags: string[];
  annotations: PhotoAnnotation[];
  taken_at: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Slim job record used for the picker, labels and legacy photos. */
export interface GalleryJob {
  id: string;
  customer_id: string | null;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  created_at: string;
  before_photos: string[] | null;
  after_photos: string[] | null;
}

/**
 * One displayable photo. `gallery` items are rows of job_photos (private bucket,
 * editable); `jobroom` items are legacy jobs.before/after_photos (public bucket,
 * read-only).
 */
export interface GalleryItem {
  id: string;
  source: 'gallery' | 'jobroom';
  path: string;
  thumbPath: string | null;
  fileName: string;
  sizeBytes: number | null;
  kind: PhotoKind;
  jobId: string | null;
  jobLabel: string;
  customerId: string | null;
  caption: string;
  tags: string[];
  annotations: PhotoAnnotation[];
  pairId: string | null;
  takenAt: string;
  uploadedBy: string | null;
  width: number | null;
  height: number | null;
}

export const PHOTOS_BUCKET = 'job-photos';
export const LEGACY_BUCKET = 'job-room-photos';
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_ANNOTATIONS = 50;
export const THUMB_SIZE = 480;
export const BULK_MAX_PHOTOS = 100;
export const BULK_MAX_BYTES = 250 * 1024 * 1024;
export const GALLERY_FETCH_LIMIT = 1000;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};
const ALLOWED_IMAGE_MIME = new Set(Object.values(IMAGE_EXT_TO_MIME));
export const PHOTO_ACCEPT_ATTR =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif';

// ============================================================
// FILES & PATHS
// ============================================================

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

export function resolveImageMime(file: Pick<File, 'name' | 'type'>): string | null {
  const ext = extOf(file.name);
  if (ext && !IMAGE_EXT_TO_MIME[ext]) return null;
  if (file.type && ALLOWED_IMAGE_MIME.has(file.type)) return file.type;
  return IMAGE_EXT_TO_MIME[ext] ?? null;
}

export function validatePhotoFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > MAX_PHOTO_BYTES) return `Photos can be up to ${formatFileSize(MAX_PHOTO_BYTES)}.`;
  if (!resolveImageMime(file)) return 'Unsupported file. Use JPG, PNG, WebP or HEIC photos.';
  return null;
}

/** Extension for the stored object, derived from the (validated) mime type, never from user input. */
export function storageExtension(mime: string): string {
  return mime === 'image/png'
    ? 'png'
    : mime === 'image/webp'
      ? 'webp'
      : mime === 'image/heic'
        ? 'heic'
        : mime === 'image/heif'
          ? 'heif'
          : 'jpg';
}

export function buildPhotoPaths(
  ownerId: string,
  photoId: string,
  mime: string,
): { path: string; thumbPath: string } {
  return {
    path: `${ownerId}/${photoId}.${storageExtension(mime)}`,
    thumbPath: `${ownerId}/${photoId}-thumb.jpg`,
  };
}

/** Best-effort capture time: the file's own timestamp when it looks sane, else "now". */
export function resolveTakenAt(lastModified: number | undefined, now: Date = new Date()): string {
  if (!lastModified || !Number.isFinite(lastModified)) return now.toISOString();
  const d = new Date(lastModified);
  const earliest = Date.UTC(2000, 0, 1);
  if (d.getTime() < earliest || d.getTime() > now.getTime() + 86_400_000) return now.toISOString();
  return d.toISOString();
}

// ============================================================
// TAGS
// ============================================================

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH).trim();
}

/** "Leak, Kitchen\nbefore" → ['before','kitchen','leak'] (unique, sorted, capped). */
export function parseTagInput(input: string): string[] {
  const set = new Set<string>();
  for (const part of input.split(/[,\n;]+/)) {
    const tag = normalizeTag(part.trim().replace(/^#/, ''));
    if (tag) set.add(tag);
  }
  return [...set].sort().slice(0, MAX_TAGS);
}

export function mergeTags(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added.map(normalizeTag).filter(Boolean)])]
    .sort()
    .slice(0, MAX_TAGS);
}

export function collectTags(items: GalleryItem[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of items) for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ============================================================
// BUILDING ITEMS
// ============================================================

export function jobLabelOf(
  job:
    | Pick<GalleryJob, 'customer_name' | 'service_type' | 'scheduled_datetime' | 'created_at'>
    | undefined,
): string {
  if (!job) return '';
  const date = (job.scheduled_datetime ?? job.created_at ?? '').slice(0, 10);
  return [job.customer_name, job.service_type, date].filter(Boolean).join(' · ');
}

function safeAnnotations(value: unknown): PhotoAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (a): a is PhotoAnnotation =>
        a &&
        typeof a.x === 'number' &&
        typeof a.y === 'number' &&
        a.x >= 0 &&
        a.x <= 1 &&
        a.y >= 0 &&
        a.y <= 1,
    )
    .slice(0, MAX_ANNOTATIONS)
    .map((a) => ({
      x: a.x,
      y: a.y,
      type: a.type === 'arrow' || a.type === 'label' ? a.type : 'circle',
      label: a.label ? String(a.label).slice(0, 120) : undefined,
    }));
}

export function itemFromRow(row: JobPhotoRow, jobs: Map<string, GalleryJob>): GalleryItem {
  return {
    id: row.id,
    source: 'gallery',
    path: row.storage_path,
    thumbPath: row.thumb_path,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    jobId: row.job_id,
    jobLabel: jobLabelOf(row.job_id ? jobs.get(row.job_id) : undefined),
    customerId: row.customer_id,
    caption: row.caption ?? '',
    tags: row.tags ?? [],
    annotations: safeAnnotations(row.annotations),
    pairId: row.pair_id,
    takenAt: row.taken_at,
    uploadedBy: row.uploaded_by,
    width: row.width,
    height: row.height,
  };
}

/** Legacy before/after photos stored on jobs (read-only in the gallery). */
export function legacyItemsFromJobs(jobs: GalleryJob[]): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const job of jobs) {
    const label = jobLabelOf(job);
    const when = job.scheduled_datetime ?? job.created_at;
    (['before', 'after'] as const).forEach((kind) => {
      const paths = (kind === 'before' ? job.before_photos : job.after_photos) ?? [];
      paths.forEach((path, i) => {
        if (!path) return;
        items.push({
          id: `legacy:${job.id}:${kind}:${i}`,
          source: 'jobroom',
          path,
          thumbPath: null,
          fileName: path.split('/').pop() ?? `${kind}-${i + 1}.jpg`,
          sizeBytes: null,
          kind,
          jobId: job.id,
          jobLabel: label,
          customerId: job.customer_id,
          caption: '',
          tags: [],
          annotations: [],
          pairId: null,
          takenAt: when,
          uploadedBy: null,
          width: null,
          height: null,
        });
      });
    });
  }
  return items;
}

export function sortByNewest(items: GalleryItem[]): GalleryItem[] {
  return [...items].sort((a, b) =>
    a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : a.id.localeCompare(b.id),
  );
}

// ============================================================
// SEARCH / FILTER / GROUP
// ============================================================

export interface GalleryFilter {
  query: string;
  kind: PhotoKind | 'all';
  jobId: string | 'all';
  tag: string | 'all';
}

export function filterItems(items: GalleryItem[], f: GalleryFilter): GalleryItem[] {
  const terms = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (f.kind !== 'all' && it.kind !== f.kind) return false;
    if (f.jobId !== 'all' && it.jobId !== f.jobId) return false;
    if (f.tag !== 'all' && !it.tags.includes(f.tag)) return false;
    if (terms.length === 0) return true;
    const haystack = [
      it.caption,
      it.fileName,
      it.jobLabel,
      it.kind,
      it.tags.join(' '),
      it.annotations.map((a) => a.label ?? '').join(' '),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t)); // every word must match (AND)
  });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function groupByDay(items: GalleryItem[]): { key: string; items: GalleryItem[] }[] {
  const groups = new Map<string, GalleryItem[]>();
  for (const it of items) {
    const k = dayKey(it.takenAt);
    const list = groups.get(k);
    if (list) list.push(it);
    else groups.set(k, [it]);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, items: list }));
}

// ============================================================
// BEFORE / AFTER PAIRS
// ============================================================

export interface PhotoPair {
  pairId: string;
  before: GalleryItem;
  after: GalleryItem;
}

/** Only complete pairs (exactly one before + one after) count. */
export function buildPairs(items: GalleryItem[]): PhotoPair[] {
  const byPair = new Map<string, GalleryItem[]>();
  for (const it of items) {
    if (!it.pairId || it.source !== 'gallery') continue;
    const list = byPair.get(it.pairId);
    if (list) list.push(it);
    else byPair.set(it.pairId, [it]);
  }
  const pairs: PhotoPair[] = [];
  for (const [pairId, list] of byPair) {
    const before = list.find((i) => i.kind === 'before');
    const after = list.find((i) => i.kind === 'after');
    if (list.length === 2 && before && after) pairs.push({ pairId, before, after });
  }
  return pairs.sort((a, b) => (a.after.takenAt < b.after.takenAt ? 1 : -1));
}

export function partnerOf(item: GalleryItem, pairs: PhotoPair[]): GalleryItem | null {
  const pair = pairs.find((p) => p.before.id === item.id || p.after.id === item.id);
  if (!pair) return null;
  return pair.before.id === item.id ? pair.after : pair.before;
}

/** Unpaired photos of the opposite kind from the same job — valid pairing targets. */
export function pairCandidates(
  item: GalleryItem,
  items: GalleryItem[],
  pairs: PhotoPair[],
): GalleryItem[] {
  if (item.source !== 'gallery' || (item.kind !== 'before' && item.kind !== 'after')) return [];
  const want: PhotoKind = item.kind === 'before' ? 'after' : 'before';
  const paired = new Set(pairs.flatMap((p) => [p.before.id, p.after.id]));
  return sortByNewest(
    items.filter(
      (i) =>
        i.source === 'gallery' && i.kind === want && i.jobId === item.jobId && !paired.has(i.id),
    ),
  );
}

/** Validates a bulk selection for "Pair" → ordered ids, or an explanation. */
export function resolvePairSelection(
  selected: GalleryItem[],
): { before: string; after: string } | string {
  if (selected.length !== 2) return 'Select exactly two photos: one Before and one After.';
  const before = selected.find((s) => s.kind === 'before');
  const after = selected.find((s) => s.kind === 'after');
  if (!before || !after) return 'Select exactly two photos: one Before and one After.';
  if (selected.some((s) => s.source !== 'gallery'))
    return 'Photos from the old Job Room can’t be paired.';
  if (before.jobId !== after.jobId) return 'Before and After photos must belong to the same job.';
  return { before: before.id, after: after.id };
}

// ============================================================
// PERMISSIONS
// ============================================================

export function canEditPhoto(
  item: GalleryItem,
  ctx: { canManage: boolean; userId: string | null },
): boolean {
  if (item.source !== 'gallery') return false;
  return ctx.canManage || (ctx.userId !== null && item.uploadedBy === ctx.userId);
}

// ============================================================
// BULK DOWNLOAD
// ============================================================

export function checkBulkLimits(items: GalleryItem[]): string | null {
  if (items.length === 0) return 'Select at least one photo.';
  if (items.length > BULK_MAX_PHOTOS) return `Download up to ${BULK_MAX_PHOTOS} photos at a time.`;
  const bytes = items.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  if (bytes > BULK_MAX_BYTES)
    return `That selection is ${formatFileSize(bytes)}. Keep it under ${formatFileSize(BULK_MAX_BYTES)} per download.`;
  return null;
}

/** Unique, filesystem-safe names inside the archive: `01-before-kitchen-leak.jpg`. */
export function zipEntryNames(items: GalleryItem[]): string[] {
  const used = new Set<string>();
  const width = String(items.length).length;
  return items.map((it, i) => {
    const ext = extOf(it.fileName) || 'jpg';
    const stem = it.fileName.replace(/\.[^.]+$/, '');
    const clean = stem
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 50);
    let name = `${String(i + 1).padStart(Math.max(width, 2), '0')}-${it.kind}-${clean || 'photo'}.${ext.replace(/[^a-z0-9]/g, '') || 'jpg'}`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = name.replace(/(\.[^.]+)$/, `-${n++}$1`);
    used.add(name.toLowerCase());
    return name;
  });
}

// ============================================================
// CONCURRENCY
// ============================================================

/** Runs `fn` over `items` with at most `limit` in flight. Never rejects; returns per-item outcomes in order. */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(
    items.length,
  );
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
