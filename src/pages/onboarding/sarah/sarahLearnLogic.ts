// Pure helpers for "Sarah Learns Your Business" (no React, no network).
// Field definitions come from the SAME module the edge functions validate with,
// so the review screen and the server can never disagree about sensitivity.

import { FIELD_BY_KEY, FIELD_DEFS, REQUIRED_KEYS, type FieldGroup, type FieldKind } from '../../../../supabase/functions/_shared/sarah-learn/schema.ts';

export type FieldStatus = 'pending' | 'approved' | 'edited' | 'rejected';
export type Confidence = 'high' | 'medium' | 'low';
export type RunStatus = 'sourcing' | 'drafted' | 'interviewing' | 'review' | 'readiness' | 'ready' | 'live' | 'failed';

export interface LearnField {
  id: string;
  key: string;
  value: unknown;
  prev_value: unknown;
  confidence: Confidence;
  assumed: boolean;
  sensitive: boolean;
  origin: 'source' | 'interview' | 'owner_edit';
  source_id: string | null;
  citation: string | null;
  status: FieldStatus;
  edit_count: number;
}

export interface LearnSource {
  id: string;
  kind: 'website_page' | 'pasted_text';
  url: string | null;
  label: string;
  status: 'fetched' | 'blocked_robots' | 'failed' | 'skipped';
  error_code: string | null;
}

export interface LearnRun {
  id: string;
  status: RunStatus;
  locale: 'en' | 'es';
  website_url: string | null;
  started_at: string;
  first_draft_at: string | null;
  readiness_passed: boolean;
  readiness_score: number | null;
  test_call_confirmed_at: string | null;
  live_at: string | null;
}

export const GROUP_ORDER: readonly FieldGroup[] = ['basics', 'services', 'hours_area', 'pricing', 'trust', 'voice', 'faq'];

export function kindOf(key: string): FieldKind {
  return FIELD_BY_KEY.get(key)?.kind ?? 'text';
}

export function groupFields(fields: readonly LearnField[]): { group: FieldGroup; fields: LearnField[] }[] {
  const order = new Map(FIELD_DEFS.map((d, i) => [d.key, i]));
  return GROUP_ORDER.map((group) => ({
    group,
    fields: fields
      .filter((f) => FIELD_BY_KEY.get(f.key)?.group === group)
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)),
  })).filter((g) => g.fields.length > 0);
}

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Human-readable (and editable) text for a field value. */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (kindOf(key) === 'faq') {
      return (value as { question?: string; answer?: string }[]).map((x) => `Q: ${x.question ?? ''}\nA: ${x.answer ?? ''}`).join('\n\n');
    }
    return value.map(String).join('\n');
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (kindOf(key) === 'emergency') return `${String(o.mode ?? 'unknown')}${o.note ? `: ${String(o.note)}` : ''}`;
    return DAY_ORDER.filter((d) => o[d] && typeof o[d] === 'object')
      .map((d) => `${d} ${(o[d] as { open: string }).open}-${(o[d] as { close: string }).close}`)
      .join('\n');
  }
  return String(value);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Converts the owner's edited text back into a stored value, or null when invalid. */
export function parseEditInput(key: string, text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  switch (kindOf(key)) {
    case 'list':
      return Array.from(new Set(t.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean))).slice(0, 30);
    case 'price':
      return t.slice(0, 400);
    case 'hours': {
      const out: Record<string, { open: string; close: string }> = {};
      for (const line of t.split(/\r?\n/)) {
        const m = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/i.exec(line.trim());
        if (!m || !TIME_RE.test(m[2]) || !TIME_RE.test(m[3]) || m[2] >= m[3]) return null;
        out[m[1].toLowerCase()] = { open: m[2], close: m[3] };
      }
      return Object.keys(out).length ? out : null;
    }
    case 'faq': {
      const items: { question: string; answer: string }[] = [];
      for (const block of t.split(/\n\s*\n/)) {
        const m = /^Q:\s*([\s\S]+?)\nA:\s*([\s\S]+)$/i.exec(block.trim());
        if (m) items.push({ question: m[1].trim().slice(0, 200), answer: m[2].trim().slice(0, 400) });
      }
      return items.length ? items.slice(0, 25) : null;
    }
    case 'emergency': {
      const m = /^(yes_premium|yes_same_rate|business_hours_only|unknown)\s*(?::\s*([\s\S]*))?$/i.exec(t);
      return m ? { mode: m[1].toLowerCase(), note: (m[2] ?? '').trim().slice(0, 400) } : null;
    }
    default:
      return t.slice(0, 400);
  }
}

export type Blocker = 'required_missing' | 'sensitive_pending' | 'readiness' | 'test_call';

/** Mirrors the server gate in sarah_learn_go_live (the server is still the authority). */
export function goLiveBlockers(run: Pick<LearnRun, 'readiness_passed' | 'test_call_confirmed_at'>, fields: readonly LearnField[]): Blocker[] {
  const out: Blocker[] = [];
  const done = (f?: LearnField) => !!f && (f.status === 'approved' || f.status === 'edited');
  if (!REQUIRED_KEYS.every((k) => done(fields.find((f) => f.key === k)))) out.push('required_missing');
  if (fields.some((f) => f.sensitive && f.status === 'pending')) out.push('sensitive_pending');
  if (!run.readiness_passed) out.push('readiness');
  if (!run.test_call_confirmed_at) out.push('test_call');
  return out;
}

export function reviewCounts(fields: readonly LearnField[]) {
  const pendingSensitive = fields.filter((f) => f.sensitive && f.status === 'pending');
  const pendingSafe = fields.filter((f) => !f.sensitive && f.status === 'pending' && !f.assumed && f.confidence !== 'low');
  const assumed = fields.filter((f) => f.assumed && f.status === 'pending');
  const edits = fields.reduce((n, f) => n + f.edit_count, 0);
  return { pendingSensitive, pendingSafe, assumed, edits, total: fields.length };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Simple diff for a re-run: what changed relative to the previous run's value. */
export function diffStatus(f: LearnField): 'new' | 'changed' | 'same' {
  if (f.prev_value === null || f.prev_value === undefined) return 'same';
  return JSON.stringify(f.prev_value) === JSON.stringify(f.value) ? 'same' : 'changed';
}

export function safeHostname(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isHttpUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Host + path for display; never throws. */
export function displayUrl(url: string | null): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return '';
  }
}
