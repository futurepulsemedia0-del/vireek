/**
 * Bulk mutation engine. The Supabase client is injected (structural type) so
 * the logic is unit-testable without a network. Strategy per chunk: one
 * `.in('id', chunk)` statement; if it errors (trigger / FK / quality gate),
 * the chunk is retried row-by-row so one bad row never fails the others.
 * `.select('id')` is used to learn which rows were *really* affected — RLS
 * silently filters rows, and those must not be reported as successes.
 */
export type BulkTable = 'jobs' | 'leads' | 'customers' | 'quotes' | 'invoices' | 'calls';

export interface BulkQuery extends PromiseLike<{ data?: { id: string }[] | null; error: { message: string } | null }> {
  in(column: string, values: string[]): BulkQuery;
  eq(column: string, value: string): BulkQuery;
  select(columns: string): BulkQuery;
}
export interface BulkClient {
  from(table: string): { update(patch: Record<string, unknown>): BulkQuery; delete(): BulkQuery };
}

export const CHUNK_SIZE = 100;
export const ROW_CONCURRENCY = 4;

export interface BulkFailure {
  id: string;
  reason: string;
}
export interface BulkResult {
  requested: number;
  succeeded: string[];
  failed: BulkFailure[];
  skipped: BulkFailure[];
}
export interface RowUpdate {
  id: string;
  patch: Record<string, unknown>;
}

export function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type Op = { kind: 'update'; patch: Record<string, unknown> } | { kind: 'delete' };

function build(client: BulkClient, table: string, op: Op) {
  const t = client.from(table);
  return op.kind === 'delete' ? t.delete() : t.update(op.patch);
}

async function runRow(client: BulkClient, table: string, id: string, op: Op): Promise<string | null> {
  try {
    const { data, error } = await build(client, table, op).eq('id', id).select('id');
    if (error) return error.message;
    if (!data || data.length === 0) return 'Not found or you do not have permission.';
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Unexpected error.';
  }
}

async function runIds(
  client: BulkClient,
  table: string,
  ids: string[],
  op: Op,
  perRow: boolean,
): Promise<{ ok: string[]; failed: BulkFailure[] }> {
  const ok: string[] = [];
  const failed: BulkFailure[] = [];
  const rowByRow = async (list: string[]) => {
    const res = await mapWithConcurrency(list, ROW_CONCURRENCY, (id) => runRow(client, table, id, op));
    list.forEach((id, i) => (res[i] ? failed.push({ id, reason: res[i] as string }) : ok.push(id)));
  };
  if (perRow) {
    await rowByRow(ids);
    return { ok, failed };
  }
  for (const part of chunk(ids)) {
    try {
      const { data, error } = await build(client, table, op).in('id', part).select('id');
      if (error) {
        await rowByRow(part);
        continue;
      }
      const hit = new Set((data ?? []).map((r) => r.id));
      for (const id of part) {
        if (hit.has(id)) ok.push(id);
        else failed.push({ id, reason: 'Not found or you do not have permission.' });
      }
    } catch {
      await rowByRow(part);
    }
  }
  return { ok, failed };
}

export interface BulkUpdateOptions {
  /** Force row-by-row (needed when DB triggers validate each row, e.g. job quality gates). */
  perRow?: boolean;
  /** Return a reason string to skip a row (business rules), or null to allow it. */
  guard?: (id: string) => Promise<string | null>;
}

export async function bulkUpdate(
  client: BulkClient,
  table: BulkTable,
  ids: string[],
  patch: Record<string, unknown>,
  opts: BulkUpdateOptions = {},
): Promise<BulkResult> {
  const unique = Array.from(new Set(ids));
  const skipped: BulkFailure[] = [];
  let allowed = unique;
  if (opts.guard) {
    const guard = opts.guard;
    const verdicts = await mapWithConcurrency(unique, ROW_CONCURRENCY, async (id) => {
      try {
        return await guard(id);
      } catch {
        return null; // a failing guard check must not silently block everything
      }
    });
    allowed = [];
    unique.forEach((id, i) => (verdicts[i] ? skipped.push({ id, reason: verdicts[i] as string }) : allowed.push(id)));
  }
  const { ok, failed } = await runIds(client, table, allowed, { kind: 'update', patch }, !!opts.perRow);
  return { requested: unique.length, succeeded: ok, failed, skipped };
}

export async function bulkDelete(client: BulkClient, table: BulkTable, ids: string[]): Promise<BulkResult> {
  const unique = Array.from(new Set(ids));
  const { ok, failed } = await runIds(client, table, unique, { kind: 'delete' }, false);
  return { requested: unique.length, succeeded: ok, failed, skipped: [] };
}

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
}

export function parseTags(input: string): string[] {
  return Array.from(new Set(input.split(',').map(normalizeTag).filter(Boolean)));
}

export async function bulkTags(
  client: BulkClient,
  table: BulkTable,
  rows: { id: string; tags?: string[] | null }[],
  mode: 'add' | 'remove',
  tags: string[],
): Promise<BulkResult & { updates: RowUpdate[] }> {
  const clean = Array.from(new Set(tags.map(normalizeTag).filter(Boolean)));
  const groups = new Map<string, { next: string[]; ids: string[] }>();
  const skipped: BulkFailure[] = [];
  for (const row of rows) {
    const current = row.tags ?? [];
    const next = mode === 'add' ? Array.from(new Set([...current, ...clean])) : current.filter((t) => !clean.includes(t));
    if (next.length === current.length && next.every((t, i) => t === current[i])) {
      skipped.push({ id: row.id, reason: 'No change.' });
      continue;
    }
    const key = next.join('\u0001');
    const g = groups.get(key) ?? { next, ids: [] };
    g.ids.push(row.id);
    groups.set(key, g);
  }
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];
  const updates: RowUpdate[] = [];
  for (const g of groups.values()) {
    const { ok, failed: f } = await runIds(client, table, g.ids, { kind: 'update', patch: { tags: g.next } }, false);
    succeeded.push(...ok);
    failed.push(...f);
    ok.forEach((id) => updates.push({ id, patch: { tags: g.next } }));
  }
  return { requested: rows.length, succeeded, failed, skipped, updates };
}

export function summarize(result: BulkResult, verb: string, noun: { singular: string; plural: string }): string {
  const n = result.succeeded.length;
  const label = (c: number) => (c === 1 ? noun.singular : noun.plural);
  let msg = n > 0 ? `${verb} ${n} ${label(n)}.` : `No ${noun.plural} were ${verb.toLowerCase()}.`;
  if (result.skipped.length) msg += ` ${result.skipped.length} skipped.`;
  if (result.failed.length) msg += ` ${result.failed.length} failed.`;
  const reason = result.failed[0]?.reason ?? result.skipped[0]?.reason;
  if (reason && (result.failed.length || result.skipped.length)) msg += ` (${reason})`;
  return msg;
}

export function applyRowPatches<T extends { id: string }>(rows: T[], updates: RowUpdate[]): T[] {
  if (updates.length === 0) return rows;
  const map = new Map(updates.map((u) => [u.id, u.patch]));
  return rows.map((r) => (map.has(r.id) ? { ...r, ...map.get(r.id) } : r));
}
