import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TourRecord } from './productTours';

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as unknown,
  throwOnSelect: false,
  upserts: [] as unknown[],
  deletes: 0,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: async () => {
          if (db.throwOnSelect) throw new Error('offline');
          return { data: db.rows, error: db.error };
        },
      }),
      upsert: async (row: unknown) => {
        db.upserts.push(row);
        return { error: db.error };
      },
      delete: () => ({
        eq: () => ({
          like: async () => {
            db.deletes += 1;
            return { error: null };
          },
        }),
      }),
    }),
  },
}));

import { deleteTipRecords, loadTourRecords, recordToRow, rowToRecord, saveTourRecord } from './productToursApi';

const T1 = '2026-10-18T10:00:00.000Z';
const T2 = '2026-10-18T11:00:00.000Z';
const rec = (over: Partial<TourRecord> = {}): TourRecord => ({
  tourId: 'owner', version: 1, status: 'in_progress', stepIndex: 2,
  startedAt: T1, completedAt: null, skippedAt: null, replayCount: 0, updatedAt: T1, ...over,
});
const row = (r: TourRecord) => recordToRow(r);

beforeEach(() => {
  window.localStorage.clear();
  db.rows = [];
  db.error = null;
  db.throwOnSelect = false;
  db.upserts = [];
  db.deletes = 0;
});

describe('rowToRecord', () => {
  it('round-trips a valid row', () => {
    expect(rowToRecord(row(rec()))).toEqual(rec());
  });
  it('rejects malformed rows', () => {
    expect(rowToRecord(null)).toBeNull();
    expect(rowToRecord({ tour_id: '', status: 'completed' })).toBeNull();
    expect(rowToRecord({ tour_id: 'owner', status: 'bogus' })).toBeNull();
    expect(rowToRecord({ tour_id: 'x'.repeat(81), status: 'completed' })).toBeNull();
  });
  it('sanitizes numbers and dates', () => {
    const r = rowToRecord({ tour_id: 'owner', status: 'completed', step_index: -4, replay_count: 'x', updated_at: 'nope' });
    expect(r).toMatchObject({ stepIndex: 0, replayCount: 0, updatedAt: new Date(0).toISOString() });
  });
});

describe('loadTourRecords', () => {
  it('reads from the database and caches locally', async () => {
    db.rows = [row(rec({ status: 'completed', completedAt: T1 }))];
    const map = await loadTourRecords('u1');
    expect(map.owner.status).toBe('completed');
    db.throwOnSelect = true;
    expect((await loadTourRecords('u1')).owner.status).toBe('completed'); // served from the local cache
  });

  it('ignores malformed server rows', async () => {
    db.rows = [row(rec()), { tour_id: 'bad', status: 'nope' }];
    expect(Object.keys(await loadTourRecords('u1'))).toEqual(['owner']);
  });

  it('falls back to local when the server errors', async () => {
    await saveTourRecord('u1', rec({ stepIndex: 5 }));
    db.error = { message: 'boom' };
    db.rows = [];
    expect((await loadTourRecords('u1')).owner.stepIndex).toBe(5);
  });

  it('re-syncs local progress that is newer than the server', async () => {
    await saveTourRecord('u1', rec({ stepIndex: 6, updatedAt: T2 }));
    db.upserts = [];
    db.rows = [row(rec({ stepIndex: 1, updatedAt: T1 }))];
    const map = await loadTourRecords('u1');
    expect(map.owner.stepIndex).toBe(6);
    await Promise.resolve();
    expect(db.upserts).toHaveLength(1);
  });
});

describe('saveTourRecord', () => {
  it('persists locally even when the server write fails', async () => {
    db.error = { message: 'not migrated' };
    await saveTourRecord('u1', rec({ stepIndex: 3 }));
    db.throwOnSelect = true;
    expect((await loadTourRecords('u1')).owner.stepIndex).toBe(3);
  });
  it('upserts with the user id and conflict key', async () => {
    await saveTourRecord('u1', rec());
    expect(db.upserts[0]).toMatchObject({ user_id: 'u1', tour_id: 'owner', status: 'in_progress' });
  });
});

describe('deleteTipRecords', () => {
  it('removes tips but keeps tour progress', async () => {
    await saveTourRecord('u1', rec());
    await saveTourRecord('u1', rec({ tourId: 'tip:jobs.create', status: 'completed' }));
    await deleteTipRecords('u1');
    db.throwOnSelect = true;
    const map = await loadTourRecords('u1');
    expect(Object.keys(map)).toEqual(['owner']);
    expect(db.deletes).toBe(1);
  });
});
