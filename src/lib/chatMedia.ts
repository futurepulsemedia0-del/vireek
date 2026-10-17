import { fitWithin, MAX_ATTACHMENT_BYTES } from '@/lib/teamChat';

/**
 * Downscales a photo (longest edge 1600px, JPEG ~0.82) before upload so a technician on
 * one bar of signal is not pushing a 12 MB original. Falls back to the original file when
 * the browser cannot decode it (e.g. HEIC outside Safari) or the result would not be smaller.
 */
export async function prepareImage(
  file: File,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<{ blob: Blob; mime: string }> {
  const maxEdge = opts.maxEdge ?? 1600;
  const quality = opts.quality ?? 0.82;
  const original = { blob: file as Blob, mime: file.type || 'application/octet-stream' };

  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return original;
  if (file.type === 'image/gif') return original;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    if (!width || !height) {
      bitmap.close?.();
      return original;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return original;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size === 0) return original;
    if (blob.size >= file.size && file.size <= MAX_ATTACHMENT_BYTES) return original;
    return { blob, mime: 'image/jpeg' };
  } catch {
    return original;
  }
}
