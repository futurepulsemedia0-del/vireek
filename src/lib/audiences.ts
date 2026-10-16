import { supabase } from '@/lib/supabase';
import type { CsvColumn } from '@/lib/csvExport';

// ============================================================
// Audiences — dynamic segment rule builder (marketing_segments)
// ============================================================
//
// A rule list is stored in `marketing_segments.filter` using EXACTLY the keys
// the server-side evaluator already understands
// (supabase/functions/_shared/marketing/segments.ts), so an audience saved
// here is resolved identically by `marketing-engine-tick` — what the user
// counts/exports on screen is what a campaign will actually send to. Do not
// add a rule field here without adding it to that evaluator first.

export type AudienceEntity = 'customer' | 'lead';

export type RuleField =
  | 'lifecycle_stage'
  | 'stage'
  | 'source'
  | 'tags'
  | 'min_score'
  | 'max_score'
  | 'inactive_days';

export interface AudienceRule {
  id: string;
  field: RuleField;
  /** multi-value fields (lifecycle_stage, stage, source, tags) */
  values: string[];
  /** numeric fields (min_score, max_score, inactive_days) */
  number: number | null;
}

export interface AudienceFilter {
  entity: AudienceEntity;
  lifecycle_stage?: string[];
  stage?: string[];
  tags?: string[];
  source?: string[];
  min_score?: number;
  max_score?: number;
  inactive_days?: number;
}

export interface FieldConfig {
  field: RuleField;
  label: string;
  kind: 'multi' | 'tags' | 'number';
  entities: AudienceEntity[];
  hint: string;
  options?: string[];
  min?: number;
  max?: number;
}

export const LIFECYCLE_STAGES = ['lead', 'active', 'vip', 'inactive'];
export const CUSTOMER_SOURCES = ['manual', 'call', 'lead', 'job', 'import'];
export const DEFAULT_LEAD_STAGES = ['new'];

export const FIELD_CONFIGS: FieldConfig[] = [
  { field: 'lifecycle_stage', label: 'Lifecycle stage', kind: 'multi', entities: ['customer'], hint: 'Is any of', options: LIFECYCLE_STAGES },
  { field: 'stage', label: 'Lead stage', kind: 'multi', entities: ['lead'], hint: 'Is any of', options: DEFAULT_LEAD_STAGES },
  { field: 'source', label: 'Source', kind: 'multi', entities: ['customer'], hint: 'Is any of', options: CUSTOMER_SOURCES },
  { field: 'tags', label: 'Tags', kind: 'tags', entities: ['customer'], hint: 'Has any of these tags' },
  { field: 'min_score', label: 'Minimum score', kind: 'number', entities: ['customer', 'lead'], hint: 'Score is at least', min: 0, max: 100 },
  { field: 'max_score', label: 'Maximum score', kind: 'number', entities: ['customer', 'lead'], hint: 'Score is at most', min: 0, max: 100 },
  { field: 'inactive_days', label: 'Inactive for', kind: 'number', entities: ['customer'], hint: 'Not contacted in (days)', min: 1, max: 3650 },
];

export function getFieldConfig(field: RuleField): FieldConfig {
  return FIELD_CONFIGS.find((f) => f.field === field) ?? FIELD_CONFIGS[0];
}

export function fieldsForEntity(entity: AudienceEntity): FieldConfig[] {
  return FIELD_CONFIGS.filter((f) => f.entities.includes(entity));
}

// ------------------------------------------------------------
// Rules <-> stored filter
// ------------------------------------------------------------

let ruleSeq = 0;
export function newRuleId(): string {
  ruleSeq += 1;
  return `rule_${Date.now().toString(36)}_${ruleSeq}`;
}

export function createRule(field: RuleField): AudienceRule {
  return { id: newRuleId(), field, values: [], number: null };
}

/** Strips characters that would break PostgREST array/or() syntax. */
export function sanitizeValue(raw: string): string {
  return raw.replace(/[,{}"()\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(sanitizeValue).filter(Boolean)));
}

function isRuleComplete(rule: AudienceRule): boolean {
  const cfg = getFieldConfig(rule.field);
  if (cfg.kind === 'number') return rule.number !== null && Number.isFinite(rule.number);
  return uniq(rule.values).length > 0;
}

export function rulesToFilter(entity: AudienceEntity, rules: AudienceRule[]): AudienceFilter {
  const filter: AudienceFilter = { entity };
  for (const rule of rules) {
    const cfg = getFieldConfig(rule.field);
    if (!cfg.entities.includes(entity) || !isRuleComplete(rule)) continue;
    if (cfg.kind === 'number') {
      const n = Math.min(cfg.max ?? Infinity, Math.max(cfg.min ?? -Infinity, Math.round(rule.number as number)));
      if (rule.field === 'min_score') filter.min_score = n;
      else if (rule.field === 'max_score') filter.max_score = n;
      else filter.inactive_days = n;
    } else {
      const values = uniq(rule.values);
      if (rule.field === 'lifecycle_stage') filter.lifecycle_stage = values;
      else if (rule.field === 'stage') filter.stage = values;
      else if (rule.field === 'source') filter.source = values;
      else filter.tags = values;
    }
  }
  return filter;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Reads any stored `marketing_segments.filter` (including legacy rows) into editable rules. */
export function filterToRules(raw: Record<string, unknown> | null | undefined): { entity: AudienceEntity; rules: AudienceRule[] } {
  const f = raw ?? {};
  const entity: AudienceEntity = f.entity === 'lead' ? 'lead' : 'customer';
  const rules: AudienceRule[] = [];
  const multi: [RuleField, unknown][] = [
    ['lifecycle_stage', f.lifecycle_stage],
    ['stage', f.stage],
    ['source', f.source],
    ['tags', f.tags],
  ];
  for (const [field, value] of multi) {
    const values = asStringArray(value);
    if (values.length && getFieldConfig(field).entities.includes(entity)) rules.push({ ...createRule(field), values });
  }
  const numeric: [RuleField, unknown][] = [
    ['min_score', f.min_score],
    ['max_score', f.max_score],
    ['inactive_days', f.inactive_days],
  ];
  for (const [field, value] of numeric) {
    const n = asNumber(value);
    if (n !== null && getFieldConfig(field).entities.includes(entity)) rules.push({ ...createRule(field), number: n });
  }
  return { entity, rules };
}

export function validateRules(entity: AudienceEntity, rules: AudienceRule[]): string | null {
  const seen = new Set<RuleField>();
  let min: number | null = null;
  let max: number | null = null;
  for (const rule of rules) {
    const cfg = getFieldConfig(rule.field);
    if (!cfg.entities.includes(entity)) return `"${cfg.label}" does not apply to ${entity === 'lead' ? 'leads' : 'customers'}.`;
    if (seen.has(rule.field)) return `"${cfg.label}" is used more than once — combine the values into one rule.`;
    seen.add(rule.field);
    if (!isRuleComplete(rule)) return `Finish the "${cfg.label}" rule or remove it.`;
    if (cfg.kind === 'number') {
      const n = rule.number as number;
      if (n < (cfg.min ?? -Infinity) || n > (cfg.max ?? Infinity)) return `"${cfg.label}" must be between ${cfg.min} and ${cfg.max}.`;
      if (rule.field === 'min_score') min = n;
      if (rule.field === 'max_score') max = n;
    }
  }
  if (min !== null && max !== null && min > max) return 'Minimum score cannot be higher than maximum score.';
  return null;
}

export function describeRule(rule: AudienceRule): string {
  const cfg = getFieldConfig(rule.field);
  if (cfg.kind === 'number') return `${cfg.label}: ${rule.number ?? '…'}${rule.field === 'inactive_days' ? ' days' : ''}`;
  return `${cfg.label}: ${rule.values.length ? rule.values.join(', ') : '…'}`;
}

export function describeFilter(raw: Record<string, unknown> | null | undefined): string {
  const { entity, rules } = filterToRules(raw);
  const who = entity === 'lead' ? 'Leads' : 'Customers';
  return rules.length ? `${who} · ${rules.map(describeRule).join(' · ')}` : `${who} · everyone`;
}

// ------------------------------------------------------------
// Scoring + date helpers (pure — unit tested)
// ------------------------------------------------------------

export function inactiveCutoffIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** Unscored contacts count as score 0, matching the server evaluator. */
export function applyScoreFilter<T extends { id: string }>(
  rows: T[],
  scoreById: Map<string, number>,
  minScore?: number,
  maxScore?: number,
): T[] {
  if (minScore === undefined && maxScore === undefined) return rows;
  return rows.filter((r) => {
    const score = scoreById.get(r.id) ?? 0;
    if (minScore !== undefined && score < minScore) return false;
    if (maxScore !== undefined && score > maxScore) return false;
    return true;
  });
}

// ------------------------------------------------------------
// Data access (always scoped to the ACCOUNT OWNER, never user.id —
// team members' rows are keyed by the owner's id)
// ------------------------------------------------------------

export interface AudienceMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  tags: string[];
  score: number | null;
  last_contacted_at: string | null;
  marketing_opt_in: boolean | null;
  created_at: string | null;
}

export interface AudienceResult {
  members: AudienceMember[];
  total: number;
  /** true when the safety cap stopped us before reading every row */
  truncated: boolean;
}

export const PREVIEW_SIZE = 10;
export const SCORE_SCAN_CAP = 5000;
export const EXPORT_CAP = 50000;
const PAGE = 1000;
const ID_CHUNK = 150;

type Row = Record<string, unknown>;

function toMember(entity: AudienceEntity, r: Row): AudienceMember {
  return {
    id: String(r.id),
    name: (r.name as string) ?? '',
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    stage: ((entity === 'lead' ? r.stage : r.lifecycle_stage) as string | null) ?? null,
    source: (r.source as string | null) ?? (entity === 'lead' ? 'lead' : null),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    score: null,
    last_contacted_at: (r.last_contacted_at as string | null) ?? null,
    marketing_opt_in: typeof r.marketing_opt_in === 'boolean' ? r.marketing_opt_in : null,
    created_at: (r.created_at as string | null) ?? null,
  };
}

const CUSTOMER_COLUMNS = 'id, name, email, phone, lifecycle_stage, tags, source, last_contacted_at, marketing_opt_in, created_at';
const LEAD_COLUMNS = 'id, name, email, phone, stage, created_at';

function buildQuery(ownerId: string, filter: AudienceFilter) {
  if (filter.entity === 'lead') {
    let q = supabase.from('leads').select(LEAD_COLUMNS, { count: 'exact' }).eq('user_id', ownerId);
    if (filter.stage?.length) q = q.in('stage', filter.stage);
    return q.order('created_at', { ascending: false });
  }
  let q = supabase.from('customers').select(CUSTOMER_COLUMNS, { count: 'exact' }).eq('user_id', ownerId);
  if (filter.lifecycle_stage?.length) q = q.in('lifecycle_stage', filter.lifecycle_stage);
  if (filter.source?.length) q = q.in('source', filter.source);
  if (filter.tags?.length) q = q.overlaps('tags', filter.tags);
  if (filter.inactive_days !== undefined) {
    const cutoff = inactiveCutoffIso(filter.inactive_days);
    q = q.or(`last_contacted_at.lt.${cutoff},last_contacted_at.is.null`);
  }
  return q.order('created_at', { ascending: false });
}

function hasScoreRule(f: AudienceFilter): boolean {
  return f.min_score !== undefined || f.max_score !== undefined;
}

async function fetchScores(ownerId: string, entity: AudienceEntity, ids: string[]): Promise<Map<string, number>> {
  const column = entity === 'lead' ? 'lead_id' : 'customer_id';
  const map = new Map<string, number>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase.from('lead_scores').select(`${column}, score`).eq('user_id', ownerId).in(column, chunk);
    if (error) throw new Error(error.message);
    for (const s of (data ?? []) as Row[]) map.set(s[column] as string, s.score as number);
  }
  return map;
}

async function readRows(ownerId: string, filter: AudienceFilter, cap: number): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const to = Math.min(from + PAGE, cap) - 1;
    const { data, error } = await buildQuery(ownerId, filter).range(from, to);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Live count + preview. Without a score rule this is one cheap, exact
 * COUNT query plus a small preview page; with a score rule the rows are read
 * (capped) and scored so the number matches what the campaign engine sends.
 */
export async function previewAudience(ownerId: string, filter: AudienceFilter): Promise<AudienceResult> {
  if (!hasScoreRule(filter)) {
    const { data, count, error } = await buildQuery(ownerId, filter).range(0, PREVIEW_SIZE - 1);
    if (error) throw new Error(error.message);
    const members = ((data ?? []) as unknown as Row[]).map((r) => toMember(filter.entity, r));
    return { members, total: count ?? members.length, truncated: false };
  }
  const { rows, truncated } = await readRows(ownerId, filter, SCORE_SCAN_CAP);
  const scores = await fetchScores(ownerId, filter.entity, rows.map((r) => String(r.id)));
  const kept = applyScoreFilter(rows.map((r) => ({ ...r, id: String(r.id) })), scores, filter.min_score, filter.max_score);
  const members = kept.slice(0, PREVIEW_SIZE).map((r) => ({ ...toMember(filter.entity, r), score: scores.get(r.id) ?? 0 }));
  return { members, total: kept.length, truncated };
}

/** Every matching member (capped) for CSV export. */
export async function fetchAllMembers(ownerId: string, filter: AudienceFilter): Promise<AudienceResult> {
  const { rows, truncated } = await readRows(ownerId, filter, EXPORT_CAP);
  const base = rows.map((r) => ({ ...r, id: String(r.id) }));
  const scores = await fetchScores(ownerId, filter.entity, base.map((r) => r.id));
  const kept = hasScoreRule(filter) ? applyScoreFilter(base, scores, filter.min_score, filter.max_score) : base;
  const members = kept.map((r) => ({ ...toMember(filter.entity, r), score: scores.get(r.id) ?? 0 }));
  return { members, total: members.length, truncated };
}

/** Distinct lead stages already in use, so the lead-stage picker offers real values. */
export async function fetchLeadStages(ownerId: string): Promise<string[]> {
  const { data } = await supabase.from('leads').select('stage').eq('user_id', ownerId).limit(1000);
  const found = ((data ?? []) as Row[]).map((r) => r.stage as string).filter(Boolean);
  return Array.from(new Set([...DEFAULT_LEAD_STAGES, ...found])).sort();
}

export function memberCsvColumns(entity: AudienceEntity): CsvColumn<AudienceMember>[] {
  const common: CsvColumn<AudienceMember>[] = [
    { header: 'Name', accessor: (m) => neutralizeFormula(m.name) },
    { header: 'Email', accessor: (m) => neutralizeFormula(m.email) },
    { header: 'Phone', accessor: (m) => neutralizeFormula(m.phone) },
    { header: entity === 'lead' ? 'Lead stage' : 'Lifecycle stage', accessor: (m) => m.stage },
    { header: 'Score', accessor: (m) => m.score },
    { header: 'Created', accessor: (m) => m.created_at },
  ];
  if (entity === 'lead') return common;
  return [
    ...common,
    { header: 'Source', accessor: (m) => m.source },
    { header: 'Tags', accessor: (m) => neutralizeFormula(m.tags.join('; ')) },
    { header: 'Last contacted', accessor: (m) => m.last_contacted_at },
    { header: 'Marketing opt-in', accessor: (m) => (m.marketing_opt_in === null ? '' : m.marketing_opt_in ? 'yes' : 'no') },
  ];
}

/** Prevents CSV/Excel formula injection from user-controlled text (=, +, -, @). */
export function neutralizeFormula(value: string | null | undefined): string {
  if (!value) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function audienceFilename(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'audience';
  return `audience-${slug}-${new Date().toISOString().slice(0, 10)}`;
}
