import { describe, expect, it } from 'vitest';
import {
  BULK_MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  buildPairs,
  buildPhotoPaths,
  canEditPhoto,
  checkBulkLimits,
  collectTags,
  filterItems,
  groupByDay,
  itemFromRow,
  legacyItemsFromJobs,
  mergeTags,
  pairCandidates,
  parseTagInput,
  partnerOf,
  resolveImageMime,
  resolvePairSelection,
  resolveTakenAt,
  runPool,
  sortByNewest,
  validatePhotoFile,
  zipEntryNames,
  type GalleryItem,
  type GalleryJob,
  type JobPhotoRow,
} from './gallery';

function item(o: Partial<GalleryItem>): GalleryItem {
  return {
    id: 'p1',
    source: 'gallery',
    path: 'owner/p1.jpg',
    thumbPath: null,
    fileName: 'IMG_0001.jpg',
    sizeBytes: 1000,
    kind: 'progress',
    jobId: 'job-1',
    jobLabel: 'Jane Smith · Water heater · 2026-06-10',
    customerId: null,
    caption: '',
    tags: [],
    annotations: [],
    pairId: null,
    takenAt: '2026-06-10T10:00:00.000Z',
    uploadedBy: 'u1',
    width: null,
    height: null,
    ...o,
  };
}

describe('file validation', () => {
  it('accepts supported photos and falls back to the extension for empty types (iOS HEIC)', () => {
    expect(validatePhotoFile({ name: 'a.jpg', type: 'image/jpeg', size: 10 })).toBeNull();
    expect(resolveImageMime({ name: 'IMG_1.HEIC', type: '' })).toBe('image/heic');
  });
  it('rejects empty, oversized, non-image and renamed files', () => {
    expect(validatePhotoFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 })).toMatch(/empty/i);
    expect(
      validatePhotoFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_PHOTO_BYTES + 1 }),
    ).toMatch(/15/);
    expect(validatePhotoFile({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toMatch(
      /unsupported/i,
    );
    expect(validatePhotoFile({ name: 'a.exe', type: 'image/jpeg', size: 10 })).toMatch(
      /unsupported/i,
    );
  });
  it('builds owner-scoped paths from the mime type, never from the user file name', () => {
    expect(buildPhotoPaths('owner-1', 'ph-1', 'image/png')).toEqual({
      path: 'owner-1/ph-1.png',
      thumbPath: 'owner-1/ph-1-thumb.jpg',
    });
    expect(buildPhotoPaths('o', 'p', 'image/heic').path).toBe('o/p.heic');
  });
  it('uses the file timestamp only when it is plausible', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(resolveTakenAt(Date.parse('2026-06-10T08:00:00Z'), now)).toBe(
      '2026-06-10T08:00:00.000Z',
    );
    expect(resolveTakenAt(0, now)).toBe(now.toISOString());
    expect(resolveTakenAt(Date.parse('2031-01-01T00:00:00Z'), now)).toBe(now.toISOString());
    expect(resolveTakenAt(undefined, now)).toBe(now.toISOString());
  });
});

describe('tags', () => {
  it('parses, normalises, de-duplicates and sorts', () => {
    expect(parseTagInput('Leak, #Kitchen\nleak ;  Water   Heater ,')).toEqual([
      'kitchen',
      'leak',
      'water heater',
    ]);
    expect(parseTagInput('   ')).toEqual([]);
  });
  it('caps tag count and length', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`).join(',');
    expect(parseTagInput(many)).toHaveLength(20);
    expect(parseTagInput('x'.repeat(100))[0]).toHaveLength(40);
  });
  it('merges and counts', () => {
    expect(mergeTags(['a', 'b'], ['B', 'c'])).toEqual(['a', 'b', 'c']);
    const counts = collectTags([
      item({ tags: ['leak'] }),
      item({ id: 'p2', tags: ['leak', 'pipe'] }),
    ]);
    expect(counts).toEqual([
      { tag: 'leak', count: 2 },
      { tag: 'pipe', count: 1 },
    ]);
  });
});

describe('items', () => {
  const job: GalleryJob = {
    id: 'job-1',
    customer_id: 'c1',
    customer_name: 'Jane Smith',
    service_type: 'Water heater',
    address: null,
    scheduled_datetime: '2026-06-10T09:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
    before_photos: ['u/b1.jpg', ''],
    after_photos: ['u/a1.jpg'],
  };

  it('maps rows and sanitises annotations from the database', () => {
    const row = {
      id: 'r1',
      user_id: 'o',
      job_id: 'job-1',
      customer_id: 'c1',
      storage_path: 'o/r1.jpg',
      thumb_path: null,
      file_name: 'x.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 5,
      width: null,
      height: null,
      kind: 'before',
      pair_id: null,
      caption: null,
      tags: ['a'],
      annotations: [
        { x: 0.5, y: 0.5, type: 'label', label: 'Leak' },
        { x: 3, y: 0.1, type: 'circle' },
        'junk',
      ],
      taken_at: '2026-06-10T10:00:00Z',
      uploaded_by: 'u1',
      created_at: '',
      updated_at: '',
    } as unknown as JobPhotoRow;
    const it = itemFromRow(row, new Map([[job.id, job]]));
    expect(it.annotations).toEqual([{ x: 0.5, y: 0.5, type: 'label', label: 'Leak' }]);
    expect(it.jobLabel).toBe('Jane Smith · Water heater · 2026-06-10');
    expect(it.caption).toBe('');
  });

  it('exposes legacy job-room photos read-only', () => {
    const legacy = legacyItemsFromJobs([job]);
    expect(legacy.map((l) => l.id)).toEqual(['legacy:job-1:before:0', 'legacy:job-1:after:0']);
    expect(legacy.every((l) => l.source === 'jobroom')).toBe(true);
    expect(canEditPhoto(legacy[0], { canManage: true, userId: 'u1' })).toBe(false);
  });

  it('sorts newest first and groups by day', () => {
    const list = [
      item({ id: 'a', takenAt: '2026-06-10T10:00:00Z' }),
      item({ id: 'b', takenAt: '2026-06-12T10:00:00Z' }),
      item({ id: 'c', takenAt: '2026-06-12T08:00:00Z' }),
    ];
    const sorted = sortByNewest(list);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(groupByDay(sorted).map((g) => g.items.length)).toEqual([2, 1]);
  });
});

describe('search & filter', () => {
  const list = [
    item({
      id: 'a',
      caption: 'Leaking valve under sink',
      tags: ['leak', 'kitchen'],
      kind: 'before',
    }),
    item({
      id: 'b',
      caption: 'Valve replaced',
      tags: ['kitchen'],
      kind: 'after',
      jobId: 'job-2',
      jobLabel: 'Bob Lee · HVAC',
    }),
    item({
      id: 'c',
      fileName: 'furnace.jpg',
      annotations: [{ x: 0.1, y: 0.1, type: 'label', label: 'Cracked heat exchanger' }],
    }),
  ];
  const base = { query: '', kind: 'all', jobId: 'all', tag: 'all' } as const;

  it('requires every search word to match across caption, tags, job, file and pin labels', () => {
    expect(filterItems(list, { ...base, query: 'valve leaking' }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(list, { ...base, query: 'bob hvac' }).map((i) => i.id)).toEqual(['b']);
    expect(filterItems(list, { ...base, query: 'heat exchanger' }).map((i) => i.id)).toEqual(['c']);
    expect(filterItems(list, { ...base, query: 'nothing here' })).toEqual([]);
  });
  it('combines kind, job and tag filters', () => {
    expect(filterItems(list, { ...base, kind: 'after' }).map((i) => i.id)).toEqual(['b']);
    expect(filterItems(list, { ...base, jobId: 'job-1' }).map((i) => i.id)).toEqual(['a', 'c']);
    expect(filterItems(list, { ...base, tag: 'kitchen' }).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('before / after pairing', () => {
  const b = item({ id: 'b1', kind: 'before', pairId: 'pair-1' });
  const a = item({ id: 'a1', kind: 'after', pairId: 'pair-1' });
  const lonely = item({ id: 'x', kind: 'after', pairId: 'pair-2' }); // partner missing → not a pair
  const freeBefore = item({ id: 'b2', kind: 'before' });
  const freeAfter = item({ id: 'a2', kind: 'after' });
  const otherJobAfter = item({ id: 'a3', kind: 'after', jobId: 'job-9' });
  const all = [b, a, lonely, freeBefore, freeAfter, otherJobAfter];
  const pairs = buildPairs(all);

  it('only counts complete pairs and finds partners', () => {
    expect(pairs.map((p) => p.pairId)).toEqual(['pair-1']);
    expect(partnerOf(b, pairs)?.id).toBe('a1');
    expect(partnerOf(freeBefore, pairs)).toBeNull();
  });
  it('suggests unpaired opposite-kind photos from the SAME job', () => {
    expect(pairCandidates(freeBefore, all, pairs).map((i) => i.id)).toEqual(['a2', 'x']); // a1 is taken, a3 is another job
    expect(pairCandidates(item({ kind: 'progress' }), all, pairs)).toEqual([]);
  });
  it('validates a two-photo bulk selection', () => {
    expect(resolvePairSelection([freeBefore, freeAfter])).toEqual({ before: 'b2', after: 'a2' });
    expect(resolvePairSelection([freeBefore])).toMatch(/exactly two/i);
    expect(resolvePairSelection([freeBefore, item({ id: 'z', kind: 'before' })])).toMatch(
      /exactly two/i,
    );
    expect(resolvePairSelection([freeBefore, otherJobAfter])).toMatch(/same job/i);
  });
});

describe('permissions', () => {
  it('lets managers edit anything and uploaders edit only their own', () => {
    const mine = item({ uploadedBy: 'u1' });
    expect(canEditPhoto(mine, { canManage: false, userId: 'u1' })).toBe(true);
    expect(canEditPhoto(mine, { canManage: false, userId: 'u2' })).toBe(false);
    expect(canEditPhoto(mine, { canManage: true, userId: 'u2' })).toBe(true);
    expect(canEditPhoto(mine, { canManage: false, userId: null })).toBe(false);
  });
});

describe('bulk download', () => {
  it('enforces count and size limits', () => {
    expect(checkBulkLimits([])).toMatch(/at least one/i);
    expect(
      checkBulkLimits(
        Array.from({ length: BULK_MAX_PHOTOS + 1 }, (_, i) => item({ id: String(i) })),
      ),
    ).toMatch(/100/);
    expect(checkBulkLimits([item({ sizeBytes: 300 * 1024 * 1024 })])).toMatch(/under/i);
    expect(checkBulkLimits([item({})])).toBeNull();
  });
  it('creates unique, safe, ordered archive names', () => {
    const names = zipEntryNames([
      item({ id: '1', kind: 'before', fileName: 'Kitchen Leak.JPG' }),
      item({ id: '2', kind: 'after', fileName: 'گالری.png' }),
      item({ id: '3', kind: 'after', fileName: 'گالری.png' }),
    ]);
    expect(names[0]).toBe('01-before-Kitchen-Leak.jpg');
    expect(names[1]).toBe('02-after-photo.png');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
  });
});

describe('runPool', () => {
  it('respects the concurrency limit, keeps order and isolates failures', async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 4) throw new Error('boom');
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.map((r) => (r.ok ? r.value : 'err'))).toEqual([10, 20, 30, 'err', 50, 60]);
  });
  it('handles an empty list', async () => {
    expect(await runPool([], 3, async () => 1)).toEqual([]);
  });
});
