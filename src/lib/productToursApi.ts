import { supabase } from '@/lib/supabase';
import { mergeRecords, tipRecordId, TIP_PREFIX, type RecordMap, type TourRecord, type TourStatus } from '@/lib/productTours';

const TABLE = 'product_tour_progress';
const COLUMNS = 'tour_id,version,status,step_index,started_at,completed_at,skipped_at,replay_count,updated_at';
const STATUSES = new Set<TourStatus>(['in_progress', 'completed', 'skipped']);
const storageKey = (userId: string) => `vireek:product-tours:${userId}`;

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' && !Number.isNaN(Date.parse(v)) ? v : null;
const whole = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : fallback;

/** Validates a database/localStorage row. Anything malformed is dropped, never trusted. */
export function rowToRecord(raw: unknown): TourRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tour_id !== 'string' || r.tour_id.length === 0 || r.tour_id.length > 80) return null;
  if (typeof r.status !== 'string' || !STATUSES.has(r.status as TourStatus)) return null;
  return {
    tourId: r.tour_id,
    version: whole(r.version, 1),
    status: r.status as TourStatus,
    stepIndex: whole(r.step_index, 0),
    startedAt: isoOrNull(r.started_at),
    completedAt: isoOrNull(r.completed_at),
    skippedAt: isoOrNull(r.skipped_at),
    replayCount: whole(r.replay_count, 0),
    updatedAt: isoOrNull(r.updated_at) ?? new Date(0).toISOString(),
  };
}

export function recordToRow(rec: TourRecord) {
  return {
    tour_id: rec.tourId,
    version: rec.version,
    status: rec.status,
    step_index: rec.stepIndex,
    started_at: rec.startedAt,
    completed_at: rec.completedAt,
    skipped_at: rec.skippedAt,
    replay_count: rec.replayCount,
    updated_at: rec.updatedAt,
  };
}

function toMap(rows: unknown[]): RecordMap {
  const map: RecordMap = {};
  for (const row of rows) {
    const rec = rowToRecord(row);
    if (rec) map[rec.tourId] = rec;
  }
  return map;
}

function readLocal(userId: string): RecordMap {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? toMap(parsed) : {};
  } catch {
    return {};
  }
}

function writeLocal(userId: string, map: RecordMap) {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(Object.values(map).map(recordToRow)));
  } catch {
    /* private mode / quota — the database copy is the source of truth */
  }
}

async function pushRecord(userId: string, rec: TourRecord): Promise<void> {
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ user_id: userId, ...recordToRow(rec) }, { onConflict: 'user_id,tour_id' });
    if (error) throw error;
  } catch {
    /* offline or not migrated yet — the local copy is re-synced on the next load */
  }
}

/** Database first, merged with the local copy (newest wins). Never throws. */
export async function loadTourRecords(userId: string): Promise<RecordMap> {
  const local = readLocal(userId);
  try {
    const { data, error } = await supabase.from(TABLE).select(COLUMNS).eq('user_id', userId);
    if (error || !Array.isArray(data)) throw error ?? new Error('unexpected response');
    const { merged, localNewer } = mergeRecords(toMap(data), local);
    writeLocal(userId, merged);
    localNewer.forEach((rec) => void pushRecord(userId, rec));
    return merged;
  } catch {
    return local;
  }
}

/** Always saves locally first; the server write is best-effort so the UI never blocks. */
export async function saveTourRecord(userId: string, rec: TourRecord): Promise<void> {
  writeLocal(userId, { ...readLocal(userId), [rec.tourId]: rec });
  await pushRecord(userId, rec);
}

/** "Show tips again" — removes dismissed-tip rows only; tour progress is untouched. */
export async function deleteTipRecords(userId: string): Promise<void> {
  const next = Object.fromEntries(Object.entries(readLocal(userId)).filter(([id]) => !id.startsWith(TIP_PREFIX)));
  writeLocal(userId, next);
  try {
    await supabase.from(TABLE).delete().eq('user_id', userId).like('tour_id', `${TIP_PREFIX}%`);
  } catch {
    /* best-effort */
  }
}

export { tipRecordId };
