import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PARENT,
  buildStoragePath,
  canPreviewInline,
  countByPurpose,
  formatBytes,
  resolveMime,
  sanitizeFileName,
  validateAttachmentFile,
} from '@/lib/projectAttachments';

describe('project attachments', () => {
  it('sanitizes file names and keeps the extension', () => {
    expect(sanitizeFileName('Spec Sheet (final).PDF')).toBe('Spec-Sheet-final.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\scan 1.jpg')).toBe('scan-1.jpg');
    expect(sanitizeFileName('خلاصه.pdf')).toBe('file.pdf');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('a'.repeat(200) + '.png').length).toBeLessThanOrEqual(64);
  });

  it('builds a tenant-scoped path with no traversal', () => {
    const path = buildStoragePath('owner-1', 'proj-1', '../x y.pdf', 'uuid-1');
    expect(path).toBe('owner-1/proj-1/uuid-1-x-y.pdf');
    expect(path.includes('..')).toBe(false);
  });

  it('resolves a missing MIME type from the extension', () => {
    expect(resolveMime({ name: 'IMG_1.HEIC', type: '' })).toBe('image/heic');
    expect(resolveMime({ name: 'budget.xlsx', type: 'application/octet-stream' })).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(resolveMime({ name: 'a.pdf', type: 'application/pdf; charset=binary' })).toBe('application/pdf');
    expect(resolveMime({ name: 'noext', type: '' })).toBe('');
  });

  it('validates size, type and count', () => {
    expect(validateAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: 1000 }, 0)).toEqual({ ok: true, mime: 'application/pdf' });
    expect(validateAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: 0 }, 0).ok).toBe(false);
    expect(validateAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES + 1 }, 0).ok).toBe(false);
    expect(validateAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES }, 0).ok).toBe(true);
    expect(validateAttachmentFile({ name: 'run.exe', type: 'application/x-msdownload', size: 10 }, 0).ok).toBe(false);
    expect(validateAttachmentFile({ name: 'x.svg', type: 'image/svg+xml', size: 10 }, 0).ok).toBe(false);
    expect(validateAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: 10 }, MAX_ATTACHMENTS_PER_PARENT).ok).toBe(false);
  });

  it('never allows scriptable types', () => {
    for (const bad of ['image/svg+xml', 'text/html', 'application/javascript', 'application/zip']) expect(ALLOWED_MIME_TYPES).not.toContain(bad);
  });

  it('formats sizes and previews', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(canPreviewInline('image/jpeg')).toBe(true);
    expect(canPreviewInline('image/heic')).toBe(false);
    expect(countByPurpose([{ purpose: 'after' }, { purpose: 'before' }, { purpose: 'after' }], 'after')).toBe(2);
  });
});
