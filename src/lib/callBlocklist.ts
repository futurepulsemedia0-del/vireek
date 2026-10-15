/**
 * Blocklist / DNC manager — data access.
 *
 * Decision logic, number normalization and CSV/text parsing live in
 * supabase/functions/_shared/compliance/callBlockEngine.ts (pure, shared with
 * the live call path) and are re-exported here. Everything in this file is
 * I/O, and EVERY query is scoped by the ACCOUNT OWNER's id (never the logged-in
 * user's id); RLS enforces the same boundary a second time.
 *
 * Two lists, two meanings:
 *   - call_blocklist   INBOUND  — callers we reject (spam / robocall / scam)
 *   - dnc_suppressions OUTBOUND — numbers we must never contact again
 */

import { supabase } from '@/lib/supabase';
import {
  MAX_RULES,
  normalizePhone,
  toE164,
  type BlockCategory,
  type BlockRule,
  type BlockRuleConfig,
  type BlockRuleKind,
  type DncReason,
  type ParsedRow,
  type RecentCall,
} from '../../supabase/functions/_shared/compliance/callBlockEngine';

export * from '../../supabase/functions/_shared/compliance/callBlockEngine';

// ============================================================
// LABELS
// ============================================================

export const BLOCK_CATEGORY_LABELS: Record<BlockCategory, string> = { spam: 'Spam', robocall: 'Robocall', scam: 'Scam', manual: 'Other' };
export const DNC_REASON_LABELS: Record<DncReason, string> = {
  customer_opt_out: 'Customer opt-out',
  manual: 'Added manually',
  national_registry: 'National registry',
};
export const RULE_KIND_LABELS: Record<BlockRuleKind, { label: string; description: string }> = {
  prefix: { label: 'Number prefix', description: 'Block every number starting with a prefix, e.g. +1900 premium lines or a country you never serve.' },
  anonymous: { label: 'Hidden caller ID', description: 'Block calls that arrive with caller ID withheld.' },
  neighbor_spoof: { label: 'Neighbor spoofing', description: 'Block numbers that copy your own area code and exchange — a common robocall trick.' },
  repeat_short_calls: { label: 'Repeat hang-ups', description: 'Block a number that keeps calling and hanging up within seconds.' },
};

// ============================================================
// TYPES
// ============================================================

export type ListKind = 'blocklist' | 'dnc';

export interface ListEntry {
  id: string;
  phone: string;
  category: string;
  note: string | null;
  createdAt: string;
  hitCount: number | null;
  lastBlockedAt: string | null;
}

export interface ListQuery {
  search: string;
  category: string;
  page: number;
  pageSize: number;
}

export interface ActiveOverride {
  id: string;
  phone: string;
  note: string | null;
  usesRemaining: number;
  expiresAt: string;
  createdAt: string;
}

export interface BlockEvent {
  id: string;
  phone: string | null;
  reason: 'blocklist' | 'rule';
  ruleName: string | null;
  category: string | null;
  createdAt: string;
}

export interface BlockStats {
  blocklistTotal: number;
  dncTotal: number;
  blocked7d: number;
  blocked30d: number;
  activeRules: number;
}

export interface SuspectedSpam {
  phone: string;
  count: number;
  lastAt: string;
  callId: string;
}

export interface ImportResult {
  added: number;
  skipped: number;
  failed: number;
}

export class DuplicateEntryError extends Error {
  constructor() {
    super('That number is already on this list.');
    this.name = 'DuplicateEntryError';
  }
}

const META = {
  blocklist: { table: 'call_blocklist', ownerCol: 'account_owner_id', categoryCol: 'category' },
  dnc: { table: 'dnc_suppressions', ownerCol: 'user_id', categoryCol: 'reason' },
} as const;

const IMPORT_CHUNK = 500;
const EXPORT_PAGE = 1000;
const EXPORT_MAX = 50000;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function toEntry(kind: ListKind, r: Row): ListEntry {
  return {
    id: str(r.id),
    phone: str(r.phone_number),
    category: str(r[META[kind].categoryCol]),
    note: strOrNull(r.note),
    createdAt: str(r.created_at),
    hitCount: kind === 'blocklist' ? numOrNull(r.hit_count) : null,
    lastBlockedAt: kind === 'blocklist' ? strOrNull(r.last_blocked_at) : null,
  };
}

const selectCols = (kind: ListKind) =>
  kind === 'blocklist' ? 'id, phone_number, category, note, hit_count, last_blocked_at, created_at' : 'id, phone_number, reason, note, created_at';

/** Escape LIKE wildcards so a user typing "%" or "_" searches literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ============================================================
// LISTS (blocklist + DNC)
// ============================================================

export async function fetchEntries(kind: ListKind, ownerId: string, q: ListQuery): Promise<{ entries: ListEntry[]; total: number }> {
  const m = META[kind];
  let query = supabase.from(m.table).select(selectCols(kind), { count: 'exact' }).eq(m.ownerCol, ownerId);
  if (q.category !== 'all') query = query.eq(m.categoryCol, q.category);
  const term = q.search.trim();
  if (term) {
    const digits = term.replace(/\D/g, '');
    query = digits.length >= 3 ? query.ilike('phone_number', `%${digits}%`) : query.ilike('note', `%${likeEscape(term)}%`);
  }
  const from = q.page * q.pageSize;
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, from + q.pageSize - 1);
  if (error) throw error;
  return { entries: ((data ?? []) as unknown as Row[]).map((r) => toEntry(kind, r)), total: count ?? 0 };
}

export async function fetchAllEntries(kind: ListKind, ownerId: string): Promise<ListEntry[]> {
  const m = META[kind];
  const out: ListEntry[] = [];
  for (let from = 0; from < EXPORT_MAX; from += EXPORT_PAGE) {
    const { data, error } = await supabase
      .from(m.table)
      .select(selectCols(kind))
      .eq(m.ownerCol, ownerId)
      .order('created_at', { ascending: false })
      .range(from, from + EXPORT_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Row[];
    out.push(...rows.map((r) => toEntry(kind, r)));
    if (rows.length < EXPORT_PAGE) break;
  }
  return out;
}

function insertPayload(kind: ListKind, ownerId: string, userId: string, phone: string, category: string, note: string | null, source: 'manual' | 'import' = 'manual') {
  return kind === 'blocklist'
    ? { account_owner_id: ownerId, phone_number: phone, category, note, source, created_by: userId }
    : { user_id: ownerId, phone_number: phone, reason: category, note, added_by: userId };
}

export async function addEntry(kind: ListKind, ownerId: string, userId: string, rawPhone: string, category: string, note: string): Promise<void> {
  const phone = toE164(rawPhone);
  if (!phone) throw new Error('Enter a valid phone number (10 digits or international format).');
  const { error } = await supabase.from(META[kind].table).insert(insertPayload(kind, ownerId, userId, phone, category, note.trim() || null));
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new DuplicateEntryError();
    throw error;
  }
}

/** Chunked, idempotent import: existing numbers are skipped, never overwritten. */
export async function importEntries(
  kind: ListKind,
  ownerId: string,
  userId: string,
  rows: ParsedRow[],
  category: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const m = META[kind];
  const result: ImportResult = { added: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK);
    const payload = chunk.map((r) => insertPayload(kind, ownerId, userId, r.phone, category, r.note, 'import'));
    const { data, error } = await supabase
      .from(m.table)
      .upsert(payload, { onConflict: `${m.ownerCol},phone_number`, ignoreDuplicates: true })
      .select('id');
    if (error) {
      result.failed += chunk.length;
    } else {
      const inserted = data?.length ?? 0;
      result.added += inserted;
      result.skipped += chunk.length - inserted;
    }
    onProgress?.(Math.min(i + IMPORT_CHUNK, rows.length), rows.length);
  }
  return result;
}

export async function removeEntries(kind: ListKind, ownerId: string, ids: string[]): Promise<void> {
  const m = META[kind];
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase.from(m.table).delete().eq(m.ownerCol, ownerId).in('id', ids.slice(i, i + 200));
    if (error) throw error;
  }
}

// ============================================================
// AUTO-BLOCK RULES
// ============================================================

function toRule(r: Row): BlockRule {
  return {
    id: str(r.id),
    name: str(r.name),
    kind: r.kind as BlockRuleKind,
    enabled: r.enabled !== false,
    config: (typeof r.config === 'object' && r.config !== null ? r.config : {}) as BlockRuleConfig,
  };
}

export async function fetchRules(ownerId: string): Promise<BlockRule[]> {
  const { data, error } = await supabase.from('call_block_rules').select('id, name, kind, enabled, config').eq('account_owner_id', ownerId).order('created_at');
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(toRule);
}

export async function saveRule(ownerId: string, userId: string, rule: Omit<BlockRule, 'id'> & { id?: string }): Promise<void> {
  const body = { name: rule.name.trim(), kind: rule.kind, enabled: rule.enabled, config: rule.config };
  if (rule.id) {
    const { error } = await supabase.from('call_block_rules').update(body).eq('account_owner_id', ownerId).eq('id', rule.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('call_block_rules').insert({ ...body, account_owner_id: ownerId, created_by: userId });
    if (error) throw error;
  }
}

export async function setRuleEnabled(ownerId: string, id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('call_block_rules').update({ enabled }).eq('account_owner_id', ownerId).eq('id', id);
  if (error) throw error;
}

export async function deleteRule(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('call_block_rules').delete().eq('account_owner_id', ownerId).eq('id', id);
  if (error) throw error;
}

export { MAX_RULES };

// ============================================================
// PER-CALL OVERRIDES
// ============================================================

export async function fetchOverrides(ownerId: string): Promise<ActiveOverride[]> {
  const { data, error } = await supabase
    .from('call_block_overrides')
    .select('id, phone_number, note, uses_remaining, expires_at, created_at')
    .eq('account_owner_id', ownerId)
    .gt('expires_at', new Date().toISOString())
    .gt('uses_remaining', 0)
    .order('expires_at');
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: str(r.id),
    phone: str(r.phone_number),
    note: strOrNull(r.note),
    usesRemaining: Number(r.uses_remaining ?? 0),
    expiresAt: str(r.expires_at),
    createdAt: str(r.created_at),
  }));
}

export async function createOverride(
  ownerId: string,
  userId: string,
  p: { phone: string; hours: number; uses: number; note: string; callId?: string | null },
): Promise<void> {
  const phone = toE164(p.phone);
  if (!phone) throw new Error('Enter a valid phone number.');
  const hours = Math.min(168, Math.max(1, Math.round(p.hours)));
  const uses = Math.min(10, Math.max(1, Math.round(p.uses)));
  const { error } = await supabase.from('call_block_overrides').insert({
    account_owner_id: ownerId,
    phone_number: phone,
    call_id: p.callId ?? null,
    note: p.note.trim().slice(0, 200) || null,
    uses_remaining: uses,
    expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
    created_by: userId,
  });
  if (error) throw error;
}

export async function revokeOverride(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('call_block_overrides').delete().eq('account_owner_id', ownerId).eq('id', id);
  if (error) throw error;
}

// ============================================================
// OVERVIEW DATA
// ============================================================

const countOf = async (q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> => {
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
};

export async function fetchStats(ownerId: string): Promise<BlockStats> {
  const day = 86_400_000;
  const since = (d: number) => new Date(Date.now() - d * day).toISOString();
  const head = { count: 'exact' as const, head: true };
  const [blocklistTotal, dncTotal, blocked7d, blocked30d, activeRules] = await Promise.all([
    countOf(supabase.from('call_blocklist').select('id', head).eq('account_owner_id', ownerId)),
    countOf(supabase.from('dnc_suppressions').select('id', head).eq('user_id', ownerId)),
    countOf(supabase.from('call_block_events').select('id', head).eq('account_owner_id', ownerId).gte('created_at', since(7))),
    countOf(supabase.from('call_block_events').select('id', head).eq('account_owner_id', ownerId).gte('created_at', since(30))),
    countOf(supabase.from('call_block_rules').select('id', head).eq('account_owner_id', ownerId).eq('enabled', true)),
  ]);
  return { blocklistTotal, dncTotal, blocked7d, blocked30d, activeRules };
}

export async function fetchRecentEvents(ownerId: string, limit = 15): Promise<BlockEvent[]> {
  const { data, error } = await supabase
    .from('call_block_events')
    .select('id, phone_number, reason, category, created_at, call_block_rules(name)')
    .eq('account_owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as (Row & { call_block_rules?: { name?: string } | null })[]).map((r) => ({
    id: str(r.id),
    phone: strOrNull(r.phone_number),
    reason: r.reason === 'rule' ? 'rule' : 'blocklist',
    ruleName: r.call_block_rules?.name ?? null,
    category: strOrNull(r.category),
    createdAt: str(r.created_at),
  }));
}

/** Numbers the AI already flagged as spam on real calls (last 90 days) that are not blocked yet. */
export async function fetchSuspectedSpam(ownerId: string): Promise<SuspectedSpam[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('calls')
    .select('id, caller_phone, call_datetime')
    .eq('user_id', ownerId)
    .eq('status', 'spam')
    .not('caller_phone', 'is', null)
    .gte('call_datetime', since)
    .order('call_datetime', { ascending: false })
    .limit(500);
  if (error) throw error;

  const grouped = new Map<string, SuspectedSpam>();
  for (const c of (data ?? []) as { id: string; caller_phone: string | null; call_datetime: string }[]) {
    const phone = c.caller_phone ? toE164(c.caller_phone) : null;
    if (!phone) continue;
    const g = grouped.get(phone);
    if (g) g.count++;
    else grouped.set(phone, { phone, count: 1, lastAt: c.call_datetime, callId: c.id });
  }
  const candidates = Array.from(grouped.values()).sort((a, b) => b.count - a.count).slice(0, 40);
  if (candidates.length === 0) return [];

  const { data: blocked, error: blockedErr } = await supabase
    .from('call_blocklist')
    .select('phone_number')
    .eq('account_owner_id', ownerId)
    .in('phone_number', candidates.map((c) => c.phone));
  if (blockedErr) throw blockedErr;
  const already = new Set(((blocked ?? []) as { phone_number: string }[]).map((b) => b.phone_number));
  return candidates.filter((c) => !already.has(c.phone)).slice(0, 20);
}

export async function fetchOwnedNumbers(ownerId: string): Promise<string[]> {
  const { data, error } = await supabase.from('phone_numbers').select('phone_number').eq('account_id', ownerId);
  if (error) throw error;
  return ((data ?? []) as { phone_number: string }[]).map((n) => n.phone_number);
}

/** Everything the engine needs to judge ONE number, loaded from real account data. */
export async function fetchTesterContext(ownerId: string, rawPhone: string | null) {
  const key = rawPhone ? normalizePhone(rawPhone) : null;
  const [rules, entry, overrides, calls] = await Promise.all([
    fetchRules(ownerId),
    key
      ? supabase.from('call_blocklist').select('category').eq('account_owner_id', ownerId).eq('phone_number', key).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    fetchOverrides(ownerId),
    key
      ? supabase
          .from('calls')
          .select('caller_phone, duration_seconds, call_datetime')
          .eq('user_id', ownerId)
          .eq('caller_phone', key)
          .gte('call_datetime', new Date(Date.now() - 7 * 86_400_000).toISOString())
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (entry.error) throw entry.error;
  if (calls.error) throw calls.error;
  const blocklist = new Map<string, BlockCategory>();
  if (key && entry.data) blocklist.set(key, (entry.data as { category: BlockCategory }).category);
  const recentCalls: RecentCall[] = ((calls.data ?? []) as { caller_phone: string | null; duration_seconds: number | null; call_datetime: string }[]).map((c) => ({
    phone: c.caller_phone,
    durationSeconds: c.duration_seconds,
    at: c.call_datetime,
  }));
  return {
    ctx: {
      blocklist,
      rules,
      overrides: overrides.map((o) => ({ id: o.id, phone: o.phone, expiresAt: o.expiresAt, usesRemaining: o.usesRemaining })),
    },
    recentCalls,
  };
}
