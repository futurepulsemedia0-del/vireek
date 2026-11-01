/**
 * Optimistic concurrency for shared records. The DB keeps `row_version`
 * (bigint, bumped by trigger on every UPDATE — see the trust-layer migration).
 * A write only lands if the row still has the version the user started from;
 * otherwise nothing is written and the caller gets the current row so the UI
 * can show a three-way diff (base / mine / theirs) instead of overwriting.
 */

export type Row = Record<string, unknown>;

/** Bookkeeping columns that never count as a user edit. */
export const IGNORED_FIELDS = ['id', 'row_version', 'updated_at', 'created_at', 'updated_by'] as const;

export interface VersionedQuery extends PromiseLike<{ data?: Row[] | null; error: unknown }> {
  eq(column: string, value: unknown): VersionedQuery;
  select(columns?: string): VersionedQuery;
}
export interface VersionedClient {
  from(table: string): {
    update(patch: Row): VersionedQuery;
    select(columns?: string): VersionedQuery;
  };
}

export type VersionedUpdateResult =
  | { status: 'ok'; row: Row }
  | { status: 'conflict'; current: Row }
  | { status: 'gone' }
  | { status: 'error'; error: unknown };

export async function updateWithVersion(
  client: VersionedClient,
  table: string,
  id: string,
  expectedVersion: number,
  patch: Row,
): Promise<VersionedUpdateResult> {
  const clean: Row = { ...patch };
  for (const k of IGNORED_FIELDS) delete clean[k]; // version/id are server-owned
  try {
    const { data, error } = await client.from(table).update(clean).eq('id', id).eq('row_version', expectedVersion).select('*');
    if (error) return { status: 'error', error };
    if (data && data.length === 1) return { status: 'ok', row: data[0] };
    // 0 rows: either someone changed it, it was deleted, or RLS hides it.
    const probe = await client.from(table).select('*').eq('id', id);
    if (probe.error) return { status: 'error', error: probe.error };
    const current = probe.data?.[0];
    return current ? { status: 'conflict', current } : { status: 'gone' };
  } catch (error) {
    return { status: 'error', error };
  }
}

/* ───────────────────────────── three-way diff / merge ───────────────────────────── */

export type FieldState = 'same' | 'mine' | 'theirs' | 'both-same' | 'conflict';

export interface FieldDiff {
  field: string;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  state: FieldState;
}

export function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => stableEqual(v, b[i]));
  const ak = Object.keys(a as Row).sort();
  const bk = Object.keys(b as Row).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && stableEqual((a as Row)[k], (b as Row)[k]));
}

const ignored = new Set<string>(IGNORED_FIELDS);

/** `base` = row when the user opened it; `mine` = their edited values; `theirs` = current server row. */
export function diffThreeWay(base: Row, mine: Row, theirs: Row): FieldDiff[] {
  const fields = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  const out: FieldDiff[] = [];
  for (const field of [...fields].sort()) {
    if (ignored.has(field)) continue;
    const b = base[field];
    const m = field in mine ? mine[field] : b; // fields the user never touched keep base
    const t = theirs[field];
    const iChanged = !stableEqual(m, b);
    const theyChanged = !stableEqual(t, b);
    let state: FieldState;
    if (!iChanged && !theyChanged) state = 'same';
    else if (iChanged && !theyChanged) state = 'mine';
    else if (!iChanged && theyChanged) state = 'theirs';
    else state = stableEqual(m, t) ? 'both-same' : 'conflict';
    out.push({ field, base: b, mine: m, theirs: t, state });
  }
  return out;
}

export type Choice = 'mine' | 'theirs';

export interface MergePlan {
  diffs: FieldDiff[];
  /** Fields needing a human decision. */
  conflicts: FieldDiff[];
  /** Fields only the user changed — safe to send. */
  autoMine: string[];
}

export function planMerge(base: Row, mine: Row, theirs: Row): MergePlan {
  const diffs = diffThreeWay(base, mine, theirs);
  return {
    diffs,
    conflicts: diffs.filter((d) => d.state === 'conflict'),
    autoMine: diffs.filter((d) => d.state === 'mine').map((d) => d.field),
  };
}

/**
 * Patch to retry against `theirs.row_version`. Only fields whose final value
 * differs from the server's current value are included. Returns null while any
 * conflict is unresolved (never guesses).
 */
export function buildResolvedPatch(plan: MergePlan, choices: Record<string, Choice>): Row | null {
  const patch: Row = {};
  for (const d of plan.diffs) {
    let value: unknown;
    if (d.state === 'conflict') {
      const c = choices[d.field];
      if (!c) return null;
      value = c === 'mine' ? d.mine : d.theirs;
    } else if (d.state === 'mine') value = d.mine;
    else continue;
    if (!stableEqual(value, d.theirs)) patch[d.field] = value;
  }
  return patch;
}

/** "Keep mine" for every conflict / "Take theirs" for every conflict. */
export const allChoices = (plan: MergePlan, c: Choice): Record<string, Choice> => Object.fromEntries(plan.conflicts.map((d) => [d.field, c]));
