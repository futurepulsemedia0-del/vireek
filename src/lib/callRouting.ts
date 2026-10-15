/**
 * Call Routing — model, validation, live simulator and persistence.
 *
 * Everything above the "PERSISTENCE" banner is pure (no network, no React) so
 * it is unit-tested (callRouting.test.ts) and can be ported 1:1 into the
 * edge function that executes routing during a live call. The simulator and
 * the live engine MUST share this logic, otherwise "what the simulation says"
 * and "what callers experience" drift apart.
 *
 * Evaluation model: rules run top-to-bottom, the first enabled rule that
 * matches wins. Its target is dialed; if nobody answers it escalates to the
 * rule's overflow, then to the account fallback, and finally to voicemail —
 * a call can never fall through the floor.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type RuleKind = 'emergency' | 'holiday' | 'hours' | 'language' | 'department';
export type TargetKind = 'ai' | 'member' | 'department' | 'phone' | 'voicemail';
export type HoursState = 'open' | 'closed';
export type RingStrategy = 'simultaneous' | 'sequential';

export interface RoutingTarget {
  kind: TargetKind;
  memberId?: string;
  departmentId?: string;
  /** E.164, only for kind === 'phone'. */
  phone?: string;
  ringSeconds: number;
}

export interface RoutingRule {
  id: string;
  kind: RuleKind;
  name: string;
  enabled: boolean;
  /** kind === 'language' */
  languages: string[];
  /** kind === 'department' */
  departmentId: string | null;
  /** kind === 'hours' */
  hoursState: HoursState;
  target: RoutingTarget;
  /** Tried when `target` does not answer. null = go straight to the account fallback. */
  overflow: RoutingTarget | null;
}

export interface RoutingDepartment {
  id: string;
  name: string;
  memberIds: string[];
  ringStrategy: RingStrategy;
}

export interface CallRoutingConfig {
  schemaVersion: 1;
  timezone: string;
  departments: RoutingDepartment[];
  rules: RoutingRule[];
  fallback: RoutingTarget;
  voicemail: { greeting: string; transcribe: boolean };
}

export interface RoutingMember {
  id: string;
  name: string;
  phone: string | null;
  languages: string[];
}

export interface RoutingHoliday {
  id: string;
  date: string;
  label: string;
}

export type BusinessHours = Record<string, { open?: string; close?: string; closed?: boolean }>;

export interface RoutingContext {
  assistantName: string;
  businessHours: BusinessHours | null;
  holidays: RoutingHoliday[];
  members: RoutingMember[];
}

export interface WallClock {
  /** YYYY-MM-DD in the business time zone. */
  date: string;
  /** HH:mm (24h) in the business time zone. */
  time: string;
}

export interface SimulationInput {
  at: WallClock;
  language: string;
  departmentId: string | null;
  emergency: boolean;
  /** What happens when a human endpoint is dialed. */
  ringOutcome: 'answered' | 'no_answer';
}

export type TraceStatus = 'matched' | 'not_matched' | 'skipped' | 'disabled';

export interface TraceStep {
  ruleId: string;
  name: string;
  kind: RuleKind;
  status: TraceStatus;
  detail: string;
}

export interface DialAttempt {
  label: string;
  stage: 'rule' | 'overflow' | 'fallback' | 'voicemail';
  outcome: 'answered' | 'no_answer' | 'unreachable';
  note?: string;
}

export interface SimulationResult {
  trace: TraceStep[];
  matchedRuleId: string | null;
  attempts: DialAttempt[];
  finalLabel: string;
  finalKind: TargetKind;
  facts: { open: boolean; hoursConfigured: boolean; holiday: string | null };
}

export interface RoutingIssue {
  severity: 'error' | 'warning';
  message: string;
  ruleId?: string;
}

// ============================================================
// CONSTANTS
// ============================================================

export const MAX_RULES = 30;
export const MAX_DEPARTMENTS = 15;
export const MIN_RING_SECONDS = 5;
export const MAX_RING_SECONDS = 60;
export const DEFAULT_RING_SECONDS = 20;
export const MAX_GREETING_LENGTH = 500;
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const RULE_KIND_META: Record<RuleKind, { label: string; description: string }> = {
  emergency: { label: 'Emergency', description: 'The caller describes an urgent or dangerous situation.' },
  holiday: { label: 'Holiday', description: 'Today is a closure date from your business profile.' },
  hours: { label: 'Business hours', description: 'The call arrives while you are open or closed.' },
  language: { label: 'Language', description: 'The caller speaks one of the selected languages.' },
  department: { label: 'Department', description: 'The caller asks for a specific department.' },
};

export const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  ai: 'AI receptionist',
  member: 'Team member',
  department: 'Department',
  phone: 'Phone number',
  voicemail: 'Voicemail',
};

export const COMMON_LANGUAGES = ['English', 'Spanish', 'French', 'Portuguese', 'German', 'Italian', 'Mandarin', 'Arabic', 'Hindi', 'Persian'];

// ============================================================
// SMALL HELPERS
// ============================================================

export function newId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const rand = c && typeof c.randomUUID === 'function' ? c.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Current wall-clock date/time in `timezone` (falls back to UTC if the zone is invalid). */
export function wallClockNow(timezone: string, now: Date = new Date()): WallClock {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function toMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isOpenAt(hours: BusinessHours | null, at: WallClock): { open: boolean; configured: boolean } {
  if (!hours || Object.keys(hours).length === 0) return { open: true, configured: false };
  const cfg = hours[DAY_KEYS[weekdayOf(at.date)]];
  if (!cfg || cfg.closed) return { open: false, configured: true };
  const open = toMinutes(cfg.open);
  const close = toMinutes(cfg.close);
  const now = toMinutes(at.time);
  if (open === null || close === null || now === null || open === close) return { open: false, configured: true };
  // close < open means the shift runs past midnight (e.g. 18:00 -> 02:00).
  const isOpen = close > open ? now >= open && now < close : now >= open || now < close;
  return { open: isOpen, configured: true };
}

const sameLanguage = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function defaultTarget(kind: TargetKind = 'ai'): RoutingTarget {
  return { kind, ringSeconds: DEFAULT_RING_SECONDS };
}

export function createRule(kind: RuleKind): RoutingRule {
  return {
    id: newId('rule'),
    kind,
    name: RULE_KIND_META[kind].label,
    enabled: true,
    languages: [],
    departmentId: null,
    hoursState: 'closed',
    target: defaultTarget(kind === 'emergency' ? 'ai' : 'voicemail'),
    overflow: null,
  };
}

/** Sensible starting flow: emergencies and holidays reach the AI receptionist, everything else too. */
export function createStarterConfig(timezone: string): CallRoutingConfig {
  return {
    schemaVersion: 1,
    timezone: isValidTimezone(timezone) ? timezone : 'UTC',
    departments: [],
    rules: [
      { ...createRule('emergency'), name: 'Emergency calls' },
      { ...createRule('holiday'), name: 'Holiday closure', target: defaultTarget('ai') },
      { ...createRule('hours'), name: 'After hours', hoursState: 'closed', target: defaultTarget('ai') },
    ],
    fallback: defaultTarget('ai'),
    voicemail: { greeting: 'Please leave your name, number and a short message and we will call you back.', transcribe: true },
  };
}

// ============================================================
// NORMALIZATION (never trust jsonb coming from the database)
// ============================================================

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown, fallback = '', max = 200): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
const asStringArray = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, max) : [];

function normalizeTarget(raw: unknown, fallbackKind: TargetKind): RoutingTarget {
  const kinds: TargetKind[] = ['ai', 'member', 'department', 'phone', 'voicemail'];
  const r = isRecord(raw) ? raw : {};
  const kind = kinds.includes(r.kind as TargetKind) ? (r.kind as TargetKind) : fallbackKind;
  const ring = typeof r.ringSeconds === 'number' && Number.isFinite(r.ringSeconds) ? Math.round(r.ringSeconds) : DEFAULT_RING_SECONDS;
  const target: RoutingTarget = { kind, ringSeconds: Math.min(MAX_RING_SECONDS, Math.max(MIN_RING_SECONDS, ring)) };
  if (kind === 'member') target.memberId = asString(r.memberId, '', 64);
  if (kind === 'department') target.departmentId = asString(r.departmentId, '', 64);
  if (kind === 'phone') target.phone = asString(r.phone, '', 20);
  return target;
}

export function normalizeConfig(raw: unknown, fallbackTimezone = 'UTC'): CallRoutingConfig | null {
  if (!isRecord(raw)) return null;
  const kinds: RuleKind[] = ['emergency', 'holiday', 'hours', 'language', 'department'];
  const tz = asString(raw.timezone, fallbackTimezone, 64);
  const departments: RoutingDepartment[] = (Array.isArray(raw.departments) ? raw.departments : [])
    .filter(isRecord)
    .slice(0, MAX_DEPARTMENTS)
    .map((d) => ({
      id: asString(d.id, newId('dept'), 64),
      name: asString(d.name, 'Department', 60),
      memberIds: asStringArray(d.memberIds),
      ringStrategy: d.ringStrategy === 'sequential' ? 'sequential' : 'simultaneous',
    }));
  const rules: RoutingRule[] = (Array.isArray(raw.rules) ? raw.rules : [])
    .filter(isRecord)
    .filter((r) => kinds.includes(r.kind as RuleKind))
    .slice(0, MAX_RULES)
    .map((r) => ({
      id: asString(r.id, newId('rule'), 64),
      kind: r.kind as RuleKind,
      name: asString(r.name, RULE_KIND_META[r.kind as RuleKind].label, 80),
      enabled: r.enabled !== false,
      languages: asStringArray(r.languages, 20),
      departmentId: typeof r.departmentId === 'string' ? r.departmentId : null,
      hoursState: r.hoursState === 'open' ? 'open' : 'closed',
      target: normalizeTarget(r.target, 'ai'),
      overflow: r.overflow ? normalizeTarget(r.overflow, 'voicemail') : null,
    }));
  const vm = isRecord(raw.voicemail) ? raw.voicemail : {};
  return {
    schemaVersion: 1,
    timezone: isValidTimezone(tz) ? tz : isValidTimezone(fallbackTimezone) ? fallbackTimezone : 'UTC',
    departments,
    rules,
    fallback: normalizeTarget(raw.fallback, 'ai'),
    voicemail: { greeting: asString(vm.greeting, '', MAX_GREETING_LENGTH), transcribe: vm.transcribe !== false },
  };
}

/** Removes a department and clears every reference to it so no rule silently points at a ghost. */
export function removeDepartment(config: CallRoutingConfig, departmentId: string): CallRoutingConfig {
  const clean = (t: RoutingTarget): RoutingTarget => (t.kind === 'department' && t.departmentId === departmentId ? { ...t, departmentId: '' } : t);
  return {
    ...config,
    departments: config.departments.filter((d) => d.id !== departmentId),
    rules: config.rules.map((r) => ({
      ...r,
      departmentId: r.departmentId === departmentId ? null : r.departmentId,
      target: clean(r.target),
      overflow: r.overflow ? clean(r.overflow) : null,
    })),
    fallback: clean(config.fallback),
  };
}

export function configsEqual(a: CallRoutingConfig | null, b: CallRoutingConfig | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================
// TARGET RESOLUTION
// ============================================================

interface Resolved {
  label: string;
  reachable: boolean;
  note?: string;
}

function resolveTarget(target: RoutingTarget, config: CallRoutingConfig, ctx: RoutingContext): Resolved {
  switch (target.kind) {
    case 'ai':
      return { label: `${ctx.assistantName} (AI receptionist)`, reachable: true };
    case 'voicemail':
      return { label: 'Voicemail', reachable: true };
    case 'phone': {
      const ok = !!target.phone && E164_PATTERN.test(target.phone);
      return { label: target.phone || 'Phone number', reachable: ok, note: ok ? undefined : 'Invalid number' };
    }
    case 'member': {
      const m = ctx.members.find((x) => x.id === target.memberId);
      if (!m) return { label: 'Removed team member', reachable: false, note: 'Team member no longer exists' };
      if (!m.phone) return { label: m.name, reachable: false, note: 'No phone number on file' };
      return { label: `${m.name} · ${m.phone}`, reachable: true };
    }
    case 'department': {
      const d = config.departments.find((x) => x.id === target.departmentId);
      if (!d) return { label: 'Removed department', reachable: false, note: 'Department no longer exists' };
      const people = d.memberIds.map((id) => ctx.members.find((m) => m.id === id)).filter((m): m is RoutingMember => !!m && !!m.phone);
      if (people.length === 0) return { label: d.name, reachable: false, note: 'Nobody in this department has a phone number' };
      return { label: `${d.name} · ${people.length} reachable (${d.ringStrategy})`, reachable: true };
    }
  }
}

/** Human-readable destination, e.g. "Maria · +15125550101" — shared by the flow canvas and the simulator. */
export function describeTarget(target: RoutingTarget, config: CallRoutingConfig, ctx: RoutingContext): string {
  return resolveTarget(target, config, ctx).label;
}

export function describeCondition(rule: RoutingRule, config: CallRoutingConfig): string {
  switch (rule.kind) {
    case 'emergency':
      return 'Caller reports an emergency';
    case 'holiday':
      return 'Today is a holiday';
    case 'hours':
      return rule.hoursState === 'closed' ? 'Outside business hours' : 'During business hours';
    case 'language':
      return rule.languages.length ? `Caller speaks ${rule.languages.join(', ')}` : 'No language selected';
    case 'department':
      return `Caller asks for ${config.departments.find((d) => d.id === rule.departmentId)?.name ?? 'a department'}`;
  }
}

const needsRinging = (t: RoutingTarget) => t.kind === 'member' || t.kind === 'department' || t.kind === 'phone';
const sameTarget = (a: RoutingTarget, b: RoutingTarget) =>
  a.kind === b.kind && a.memberId === b.memberId && a.departmentId === b.departmentId && a.phone === b.phone;

// ============================================================
// SIMULATOR
// ============================================================

function evaluateRule(
  rule: RoutingRule,
  input: SimulationInput,
  facts: { open: boolean; holiday: RoutingHoliday | null },
): { matched: boolean; detail: string } {
  switch (rule.kind) {
    case 'emergency':
      return input.emergency
        ? { matched: true, detail: 'Caller reported an emergency' }
        : { matched: false, detail: 'No emergency reported' };
    case 'holiday':
      return facts.holiday
        ? { matched: true, detail: `Holiday: ${facts.holiday.label}` }
        : { matched: false, detail: `${input.at.date} is not a holiday` };
    case 'hours': {
      const currentlyOpen = facts.open && !facts.holiday;
      const matched = rule.hoursState === 'open' ? currentlyOpen : !currentlyOpen;
      const state = facts.holiday ? 'closed (holiday)' : currentlyOpen ? 'open' : 'closed';
      return { matched, detail: `Business is ${state}; rule applies when ${rule.hoursState}` };
    }
    case 'language': {
      if (!input.language.trim()) return { matched: false, detail: 'Caller language not detected' };
      const matched = rule.languages.some((l) => sameLanguage(l, input.language));
      return { matched, detail: matched ? `Caller speaks ${input.language}` : `${input.language} is not in this rule` };
    }
    case 'department': {
      const matched = !!rule.departmentId && rule.departmentId === input.departmentId;
      return { matched, detail: matched ? 'Caller asked for this department' : 'Different department requested' };
    }
  }
}

export function simulateCall(config: CallRoutingConfig, ctx: RoutingContext, input: SimulationInput): SimulationResult {
  const hoursState = isOpenAt(ctx.businessHours, input.at);
  const holiday = ctx.holidays.find((h) => h.date === input.at.date) ?? null;
  const facts = { open: hoursState.open, holiday };

  const trace: TraceStep[] = [];
  let matched: RoutingRule | null = null;
  for (const rule of config.rules) {
    if (matched) {
      trace.push({ ruleId: rule.id, name: rule.name, kind: rule.kind, status: 'skipped', detail: 'An earlier rule already handled this call' });
    } else if (!rule.enabled) {
      trace.push({ ruleId: rule.id, name: rule.name, kind: rule.kind, status: 'disabled', detail: 'Rule is turned off' });
    } else {
      const r = evaluateRule(rule, input, facts);
      trace.push({ ruleId: rule.id, name: rule.name, kind: rule.kind, status: r.matched ? 'matched' : 'not_matched', detail: r.detail });
      if (r.matched) matched = rule;
    }
  }

  const stages: { target: RoutingTarget; stage: DialAttempt['stage'] }[] = [];
  if (matched) {
    stages.push({ target: matched.target, stage: 'rule' });
    if (matched.overflow) stages.push({ target: matched.overflow, stage: 'overflow' });
  }
  const last = stages[stages.length - 1];
  if (!last || !sameTarget(last.target, config.fallback)) stages.push({ target: config.fallback, stage: 'fallback' });
  const tail = stages[stages.length - 1];
  if (tail.target.kind !== 'voicemail' && tail.target.kind !== 'ai') stages.push({ target: defaultTarget('voicemail'), stage: 'voicemail' });

  const attempts: DialAttempt[] = [];
  let finalLabel = 'Voicemail';
  let finalKind: TargetKind = 'voicemail';
  for (const { target, stage } of stages) {
    const res = resolveTarget(target, config, ctx);
    let outcome: DialAttempt['outcome'];
    if (!res.reachable) outcome = 'unreachable';
    else if (!needsRinging(target)) outcome = 'answered';
    else outcome = input.ringOutcome === 'answered' ? 'answered' : 'no_answer';
    attempts.push({ label: res.label, stage, outcome, note: outcome === 'no_answer' ? `No answer after ${target.ringSeconds}s` : res.note });
    if (outcome === 'answered') {
      finalLabel = res.label;
      finalKind = target.kind;
      break;
    }
  }

  return {
    trace,
    matchedRuleId: matched?.id ?? null,
    attempts,
    finalLabel,
    finalKind,
    facts: { open: hoursState.open, hoursConfigured: hoursState.configured, holiday: holiday?.label ?? null },
  };
}

// ============================================================
// VALIDATION
// ============================================================

function validateTarget(label: string, t: RoutingTarget, config: CallRoutingConfig, ctx: RoutingContext, ruleId?: string): RoutingIssue[] {
  const issues: RoutingIssue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', message: `${label}: ${message}`, ruleId });
  const warn = (message: string) => issues.push({ severity: 'warning', message: `${label}: ${message}`, ruleId });
  if (needsRinging(t) && (t.ringSeconds < MIN_RING_SECONDS || t.ringSeconds > MAX_RING_SECONDS)) {
    err(`ring time must be ${MIN_RING_SECONDS}–${MAX_RING_SECONDS} seconds.`);
  }
  if (t.kind === 'phone' && !(t.phone && E164_PATTERN.test(t.phone))) err('enter the number in international format, e.g. +15125550123.');
  if (t.kind === 'member') {
    const m = ctx.members.find((x) => x.id === t.memberId);
    if (!m) err('choose a team member.');
    else if (!m.phone) warn(`${m.name} has no phone number, so calls will skip this step.`);
  }
  if (t.kind === 'department') {
    const d = config.departments.find((x) => x.id === t.departmentId);
    if (!d) err('choose a department.');
    else if (!d.memberIds.some((id) => ctx.members.find((m) => m.id === id)?.phone)) warn(`${d.name} has nobody with a phone number, so calls will skip this step.`);
  }
  return issues;
}

export function validateConfig(config: CallRoutingConfig, ctx: RoutingContext): RoutingIssue[] {
  const issues: RoutingIssue[] = [];
  if (!isValidTimezone(config.timezone)) issues.push({ severity: 'error', message: 'Time zone is not valid.' });
  if (config.rules.length > MAX_RULES) issues.push({ severity: 'error', message: `A flow can have at most ${MAX_RULES} rules.` });
  if (config.voicemail.greeting.length > MAX_GREETING_LENGTH) issues.push({ severity: 'error', message: `Voicemail greeting is limited to ${MAX_GREETING_LENGTH} characters.` });

  config.departments.forEach((d) => {
    if (!d.name.trim()) issues.push({ severity: 'error', message: 'Every department needs a name.' });
  });
  const names = config.departments.map((d) => d.name.trim().toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) issues.push({ severity: 'error', message: 'Department names must be unique.' });

  config.rules.forEach((rule, i) => {
    const label = rule.name.trim() || `Rule ${i + 1}`;
    if (!rule.name.trim()) issues.push({ severity: 'error', message: `Rule ${i + 1} needs a name.`, ruleId: rule.id });
    if (!rule.enabled) return;
    if (rule.kind === 'language' && rule.languages.length === 0) issues.push({ severity: 'error', message: `${label}: pick at least one language.`, ruleId: rule.id });
    if (rule.kind === 'department' && !config.departments.some((d) => d.id === rule.departmentId)) {
      issues.push({ severity: 'error', message: `${label}: choose a department.`, ruleId: rule.id });
    }
    if (rule.kind === 'holiday' && ctx.holidays.length === 0) {
      issues.push({ severity: 'warning', message: `${label}: no holidays are set in your business profile, so this rule never triggers.`, ruleId: rule.id });
    }
    issues.push(...validateTarget(label, rule.target, config, ctx, rule.id));
    if (rule.overflow) issues.push(...validateTarget(`${label} (overflow)`, rule.overflow, config, ctx, rule.id));
  });

  issues.push(...validateTarget('Fallback', config.fallback, config, ctx));

  const enabled = config.rules.filter((r) => r.enabled);
  const emergencyIdx = enabled.findIndex((r) => r.kind === 'emergency');
  if (emergencyIdx === -1) issues.push({ severity: 'warning', message: 'No emergency rule: urgent calls follow your normal flow.' });
  else if (emergencyIdx > 0) issues.push({ severity: 'warning', message: 'Move the emergency rule to the top so nothing can intercept it.', ruleId: enabled[emergencyIdx].id });
  if (!ctx.businessHours || Object.keys(ctx.businessHours).length === 0) {
    issues.push({ severity: 'warning', message: 'Business hours are not set, so you are treated as always open.' });
  }
  if (config.fallback.kind === 'voicemail' && enabled.length === 0) {
    issues.push({ severity: 'warning', message: 'Every call goes straight to voicemail.' });
  }
  return issues;
}

// ============================================================
// PERSISTENCE  (all queries scoped by accountOwnerId; RLS enforces it again)
// ============================================================

export class RoutingConflictError extends Error {
  constructor() {
    super('This flow was changed elsewhere. Reload to get the latest version.');
    this.name = 'RoutingConflictError';
  }
}

export interface RoutingRecord {
  draft: CallRoutingConfig;
  published: CallRoutingConfig | null;
  publishedVersion: number;
  publishedAt: string | null;
  updatedAt: string;
}

function toRecord(row: Record<string, unknown>, tz: string): RoutingRecord | null {
  const draft = normalizeConfig(row.draft, tz);
  if (!draft) return null;
  return {
    draft,
    published: row.published ? normalizeConfig(row.published, tz) : null,
    publishedVersion: typeof row.published_version === 'number' ? row.published_version : 0,
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    updatedAt: String(row.updated_at),
  };
}

export async function fetchRoutingRecord(accountOwnerId: string): Promise<RoutingRecord | null> {
  const { data, error } = await supabase.from('call_routing_configs').select('*').eq('account_owner_id', accountOwnerId).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as Record<string, unknown>, browserTimezone()) : null;
}

export async function fetchRoutingContext(accountOwnerId: string): Promise<RoutingContext> {
  const [profileRes, membersRes] = await Promise.all([
    supabase.from('business_profile').select('business_hours, holidays, assistant_name').eq('user_id', accountOwnerId).maybeSingle(),
    supabase.from('team_members').select('id, member_name, member_email, member_phone, languages').eq('account_owner_id', accountOwnerId).order('member_name'),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (membersRes.error) throw membersRes.error;

  const profile = (profileRes.data ?? null) as { business_hours?: BusinessHours | null; holidays?: { id?: string; date?: string; label?: string }[] | null; assistant_name?: string | null } | null;
  const holidays: RoutingHoliday[] = (profile?.holidays ?? [])
    .filter((h) => typeof h?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
    .map((h) => ({ id: h.id ?? h.date!, date: h.date!, label: h.label?.trim() || 'Holiday' }));
  const members: RoutingMember[] = ((membersRes.data ?? []) as { id: string; member_name: string | null; member_email: string; member_phone: string | null; languages: string[] | null }[]).map((m) => ({
    id: m.id,
    name: m.member_name?.trim() || m.member_email,
    phone: m.member_phone?.trim() || null,
    languages: m.languages ?? [],
  }));
  return { assistantName: profile?.assistant_name?.trim() || 'Sarah', businessHours: profile?.business_hours ?? null, holidays, members };
}

/** Insert (expectedUpdatedAt === null) or update with optimistic locking. Throws RoutingConflictError if someone else saved first. */
export async function saveRoutingDraft(accountOwnerId: string, userId: string, draft: CallRoutingConfig, expectedUpdatedAt: string | null): Promise<RoutingRecord> {
  if (expectedUpdatedAt === null) {
    const { data, error } = await supabase
      .from('call_routing_configs')
      .insert({ account_owner_id: accountOwnerId, draft, updated_by: userId })
      .select('*')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') throw new RoutingConflictError();
      throw error;
    }
    return toRecord(data as Record<string, unknown>, draft.timezone) as RoutingRecord;
  }
  const { data, error } = await supabase
    .from('call_routing_configs')
    .update({ draft, updated_by: userId })
    .eq('account_owner_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select('*');
  if (error) throw error;
  if (!data || data.length === 0) throw new RoutingConflictError();
  return toRecord(data[0] as Record<string, unknown>, draft.timezone) as RoutingRecord;
}

export async function publishRouting(accountOwnerId: string, userId: string, config: CallRoutingConfig, currentVersion: number, expectedUpdatedAt: string): Promise<RoutingRecord> {
  const { data, error } = await supabase
    .from('call_routing_configs')
    .update({
      draft: config,
      published: config,
      published_version: currentVersion + 1,
      published_at: new Date().toISOString(),
      published_by: userId,
      updated_by: userId,
    })
    .eq('account_owner_id', accountOwnerId)
    .eq('published_version', currentVersion)
    .eq('updated_at', expectedUpdatedAt)
    .select('*');
  if (error) throw error;
  if (!data || data.length === 0) throw new RoutingConflictError();
  return toRecord(data[0] as Record<string, unknown>, config.timezone) as RoutingRecord;
}
