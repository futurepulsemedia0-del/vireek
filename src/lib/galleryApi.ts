import { supabase } from '@/lib/supabase';
import { buildZipBlob } from '@/lib/zip';
import {
  GALLERY_FETCH_LIMIT,
  LEGACY_BUCKET,
  PHOTOS_BUCKET,
  THUMB_SIZE,
  buildPhotoPaths,
  checkBulkLimits,
  resolveImageMime,
  resolveTakenAt,
  runPool,
  validatePhotoFile,
  zipEntryNames,
  type GalleryItem,
  type GalleryJob,
  type JobPhotoRow,
  type PhotoAnnotation,
  type PhotoKind,
} from '@/lib/gallery';

export const SIGNED_URL_TTL = 3600;

// ============================================================
// READS
// ============================================================

/** Always scoped to the ACCOUNT OWNER id (RLS enforces it too). Newest first. */
export async function fetchPhotoRows(ownerId: string): Promise<JobPhotoRow[]> {
  const { data, error } = await supabase
    .from('job_photos')
    .select('*')
    .eq('user_id', ownerId)
    .order('taken_at', { ascending: false })
    .limit(GALLERY_FETCH_LIMIT);
  if (error) throw error;
  return (data as JobPhotoRow[]) ?? [];
}

export async function fetchGalleryJobs(ownerId: string): Promise<GalleryJob[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, customer_id, customer_name, service_type, address, scheduled_datetime, created_at, before_photos, after_photos',
    )
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data as GalleryJob[]) ?? [];
}

/** Batch-signs storage paths (private bucket). Missing/failed paths are simply absent from the map. */
export async function signPaths(
  paths: string[],
  ttl = SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await supabase.storage.from(PHOTOS_BUCKET).createSignedUrls(chunk, ttl);
    if (error || !data) continue;
    for (const row of data) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}

export function legacyPublicUrl(path: string): string {
  return supabase.storage.from(LEGACY_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Full-size URL for one item (signed for gallery photos, public for legacy). */
export async function fullUrlFor(item: GalleryItem): Promise<string> {
  if (item.source === 'jobroom') return legacyPublicUrl(item.path);
  const map = await signPaths([item.path]);
  const url = map.get(item.path);
  if (!url) throw new Error('Could not create a secure link for this photo.');
  return url;
}

// ============================================================
// IMAGE PROCESSING (browser)
// ============================================================

async function decodeImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
} | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file, {
        imageOrientation: 'from-image',
      } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    }
  } catch {
    /* fall through to <img> decoding */
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Reads dimensions and builds a small JPEG thumbnail. Returns nulls when the browser can't decode (e.g. HEIC on desktop Chrome). */
export async function processImage(
  file: File,
): Promise<{ width: number | null; height: number | null; thumb: Blob | null }> {
  const decoded = await decodeImage(file);
  if (!decoded) return { width: null, height: null, thumb: null };
  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: decoded.width, height: decoded.height, thumb: null };
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    return { width: decoded.width, height: decoded.height, thumb };
  } finally {
    decoded.release();
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ============================================================
// WRITES
// ============================================================

export interface UploadOptions {
  ownerId: string;
  userId: string;
  file: File;
  jobId: string | null;
  kind: PhotoKind;
  tags: string[];
  caption?: string;
}

/**
 * Uploads original + thumbnail, then writes the row. If the row can't be
 * written the stored objects are removed again (no orphans).
 */
export async function uploadPhoto(opts: UploadOptions): Promise<JobPhotoRow> {
  const invalid = validatePhotoFile(opts.file);
  if (invalid) throw new Error(invalid);
  const mime = resolveImageMime(opts.file) as string;
  const photoId = newId();
  const { path, thumbPath } = buildPhotoPaths(opts.ownerId, photoId, mime);

  const meta = await processImage(opts.file);

  const { error: upErr } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(path, opts.file, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (upErr) throw upErr;

  let savedThumb: string | null = null;
  if (meta.thumb) {
    const { error: thErr } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .upload(thumbPath, meta.thumb, {
        contentType: 'image/jpeg',
        upsert: false,
        cacheControl: '3600',
      });
    if (!thErr) savedThumb = thumbPath; // a missing thumbnail only costs bandwidth, never the upload
  }

  const { data, error } = await supabase
    .from('job_photos')
    .insert({
      id: photoId,
      user_id: opts.ownerId,
      job_id: opts.jobId,
      storage_path: path,
      thumb_path: savedThumb,
      file_name: opts.file.name.slice(0, 255),
      mime_type: mime,
      size_bytes: opts.file.size,
      width: meta.width,
      height: meta.height,
      kind: opts.kind,
      caption: opts.caption?.trim() || null,
      tags: opts.tags,
      taken_at: resolveTakenAt(opts.file.lastModified),
      uploaded_by: opts.userId,
    })
    .select('*')
    .single();

  if (error) {
    await supabase.storage.from(PHOTOS_BUCKET).remove([path, ...(savedThumb ? [savedThumb] : [])]);
    throw error;
  }
  return data as JobPhotoRow;
}

export interface PhotoPatch {
  caption?: string | null;
  tags?: string[];
  kind?: PhotoKind;
  job_id?: string | null;
  annotations?: PhotoAnnotation[];
}

export async function updatePhoto(id: string, patch: PhotoPatch): Promise<void> {
  const { error } = await supabase.from('job_photos').update(patch).eq('id', id);
  if (error) throw error;
}

/** Deletes rows first (permission-checked by RLS), then the stored files. */
export async function deletePhotos(items: GalleryItem[]): Promise<void> {
  const mine = items.filter((i) => i.source === 'gallery');
  if (mine.length === 0) return;
  const { error } = await supabase
    .from('job_photos')
    .delete()
    .in(
      'id',
      mine.map((i) => i.id),
    );
  if (error) throw error;
  const paths = mine.flatMap((i) => [i.path, ...(i.thumbPath ? [i.thumbPath] : [])]);
  await supabase.storage.from(PHOTOS_BUCKET).remove(paths); // best-effort: rows are already gone
}

export async function pairPhotos(beforeId: string, afterId: string): Promise<void> {
  const { error } = await supabase.rpc('pair_job_photos', { p_before: beforeId, p_after: afterId });
  if (error) throw error;
}

export async function unpairPhoto(photoId: string): Promise<void> {
  const { error } = await supabase.rpc('unpair_job_photo', { p_photo: photoId });
  if (error) throw error;
}

// ============================================================
// DOWNLOADS
// ============================================================

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadOne(item: GalleryItem): Promise<void> {
  const url = await fullUrlFor(item);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed.');
  saveBlob(await res.blob(), item.fileName);
}

export interface ZipResult {
  added: number;
  failed: number;
}

/** Fetches the selected photos (4 at a time) and saves them as one ZIP. */
export async function downloadZip(
  items: GalleryItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<ZipResult> {
  const limit = checkBulkLimits(items);
  if (limit) throw new Error(limit);

  const signed = await signPaths(items.filter((i) => i.source === 'gallery').map((i) => i.path));
  const names = zipEntryNames(items);
  let done = 0;

  const results = await runPool(items, 4, async (item, i) => {
    const url = item.source === 'jobroom' ? legacyPublicUrl(item.path) : signed.get(item.path);
    if (!url) throw new Error('no url');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    onProgress?.(++done, items.length);
    return { name: names[i], data, modified: new Date(item.takenAt) };
  });

  const entries = results.flatMap((r) => (r.ok ? [r.value] : []));
  if (entries.length === 0) throw new Error('None of the selected photos could be downloaded.');
  const stamp = new Date().toISOString().slice(0, 10);
  saveBlob(buildZipBlob(entries), `job-photos-${stamp}.zip`);
  return { added: entries.length, failed: items.length - entries.length };
}
