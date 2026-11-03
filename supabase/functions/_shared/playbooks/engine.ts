// supabase/functions/_shared/playbooks/engine.ts
//
// Playbook Library — pure engine (no I/O). Everything here is deterministic and unit-tested
// (src/lib/playbookLibrary.test.ts). The database is still the authority: every rule below
// is enforced AGAIN inside playbook_validate_definition()/playbook_confirm() so a hand-rolled
// client or a shared playbook from another tenant can never skip a guardrail.

import { PLAYBOOKS } from './catalog.ts';
import type {
  ActivationStatus, AnyPlaybookItem, Conflict, CurrentState, DiffRow, GuardrailViolation, ItemKind,
  Playbook, PlaybookKey, Surface, TradeKey, TriggerKind,
} from './types.ts';
import { SCRIPT_SCENARIOS } from './types.ts';

// ---------------------------------------------------------------------------
// Limits (keep in sync with the SQL validator)
// ---------------------------------------------------------------------------

export const PB_LIMITS = {
  maxItems: 20,
  title: 120,
  why: 300,
  scriptOpening: 300,
  scriptBodyMin: 20,
  scriptBody: 2500,
  surgeMessage: 500,
  surgePriority: 500,
  smsBody: 1600,
  emailBody: 10000,
  subject: 200,
  templateName: 120,
  advisory: 1200,
  closureLabel: 60,
  closureMessage: 300,
  escalationNote: 200,
  maxSlotsScalePct: { min: -60, max: 50 },
  emergencyReserveAdd: { min: 0, max: 5 },
  overbook: { min: 0, max: 3 },
  maxBookingsPerDay: { min: 1, max: 200 },
  afterHoursFeeCentsMax: 50_000,
  maxWindowDays: 60,
} as const;

const ID_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** Phrases that would weaken disclosures or emergency handling. Mirrored in SQL. */
const COMPLIANCE_PATTERNS: RegExp[] = [
  /\bignore\b[^.]{0,20}\b(previous|prior|above|earlier|system)\b[^.]{0,20}\b(instructions?|rules?|prompt)\b/i,
  /\b(do not|don't|never|avoid|skip|without)\b[^.]{0,30}\b(disclos\w*|mention|say|tell)\b[^.]{0,60}\b(ai|a\.i\.|recorded|recording|automated|virtual assistant|assistant)\b/i,
  /\b(disable|turn off|switch off|bypass|suppress)\b[^.]{0,30}\b(emergency|recording|disclosure|opt-?out|stop keyword)\b/i,
  /\bskip\b[^.]{0,15}\b(the )?(disclosure|recording notice|opt-?out)\b/i,
  /\b(pretend|claim|say|tell)\b[^.]{0,40}\b(you are|you're|to be)\b[^.]{0,20}\b(human|real person|not an ai)\b/i,
];
const PRICE_PATTERN = /[$€£]\s?\d|\b\d[\d,.]*\s?(dollars|usd|bucks)\b/i;
const VARIABLE_PATTERN = /\{\{|\}\}/;

function textIssues(id: string, label: string, value: string, max: number, min = 0, allowVars = false): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];
  if (typeof value !== 'string') return [{ itemId: id, code: 'bad_shape', message: `${label} must be text.` }];
  const len = value.trim().length;
  if (len < min || value.length > max) out.push({ itemId: id, code: 'text_too_long', message: `${label} must be between ${min} and ${max} characters.` });
  if (!allowVars && VARIABLE_PATTERN.test(value)) out.push({ itemId: id, code: 'bad_shape', message: `${label} cannot contain {{ }} variables.` });
  if (COMPLIANCE_PATTERNS.some((r) => r.test(value))) out.push({ itemId: id, code: 'compliance_override', message: `${label} must not weaken AI disclosure, recording notices, opt-out language or emergency handling.` });
  if (PRICE_PATTERN.test(value)) out.push({ itemId: id, code: 'price_in_text', message: `${label} contains a price. Playbooks never publish prices in text; use the approval-gated fee item.` });
  return out;
}

// ---------------------------------------------------------------------------
// Risk / approval
// ---------------------------------------------------------------------------

/** Items that change what a customer pays, or spend, need an explicit owner approval. */
export function requiresApproval(item: AnyPlaybookItem): boolean {
  if (item.kind === 'after_hours_fee') return true;
  if (item.kind === 'advisory' && item.params.area === 'ads' && item.params.action && item.params.action !== 'none') return true;
  return false;
}

/** Advisory items are recorded for the owner but never executed. */
export function isAdvisory(item: AnyPlaybookItem): boolean {
  return item.kind === 'advisory';
}

// ---------------------------------------------------------------------------
// Surfaces (conflict detection)
// ---------------------------------------------------------------------------

/** Every exclusive surface an item will write to. Two live items can never share one. */
export function surfacesOf(item: AnyPlaybookItem): Surface[] {
  switch (item.kind) {
    case 'call_script': return [`call_script:${item.params.scenario}`];
    case 'surge': return ['surge'];
    case 'escalation_rule': return [`escalation:${item.params.trigger}:${item.params.action}`];
    case 'capacity': {
      const s: Surface[] = [];
      if (item.params.maxSlotsScalePct !== undefined || item.params.overbookJobsPerTech !== undefined) s.push('capacity:booking');
      if (item.params.emergencyReserveAdd !== undefined) s.push('capacity:reserve');
      if (item.params.waitlistEnabled !== undefined) s.push('capacity:waitlist');
      return s;
    }
    case 'message_template': return [`template:${item.params.channel}:${item.params.name.trim().toLowerCase()}`];
    case 'closure': return ['closure'];
    case 'after_hours_fee': return ['after_hours_fee'];
    case 'automation': return [`automation:${item.params.slug}`];
    case 'advisory': return [];
  }
}

export function defaultEnabledIds(pb: Playbook): string[] {
  return pb.items.filter((i) => i.defaultEnabled !== false).map((i) => i.id);
}

export function detectConflicts(pb: Playbook, enabledIds: string[], state: Pick<CurrentState, 'liveSurfaces'>): Conflict[] {
  const enabled = new Set(enabledIds);
  const out: Conflict[] = [];
  for (const item of pb.items) {
    if (!enabled.has(item.id)) continue;
    for (const s of surfacesOf(item)) {
      const held = state.liveSurfaces[s];
      if (held) out.push({ surface: s, itemId: item.id, heldBy: held });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation / guardrails
// ---------------------------------------------------------------------------

export function validatePlaybook(pb: Playbook): GuardrailViolation[] {
  const v: GuardrailViolation[] = [];
  if (!Array.isArray(pb.items) || pb.items.length === 0 || pb.items.length > PB_LIMITS.maxItems) {
    return [{ itemId: null, code: 'bad_shape', message: `A playbook needs between 1 and ${PB_LIMITS.maxItems} items.` }];
  }
  if (pb.defaultDurationHours < 1 || pb.defaultDurationHours > pb.maxDurationHours || pb.maxDurationHours > PB_LIMITS.maxWindowDays * 24) {
    v.push({ itemId: null, code: 'duration', message: `Duration must be between 1 hour and ${PB_LIMITS.maxWindowDays} days.` });
  }
  const seen = new Set<string>();
  const surfaceOwner = new Map<string, string>();
  for (const item of pb.items) {
    if (!item || typeof item.id !== 'string' || !ID_RE.test(item.id)) { v.push({ itemId: null, code: 'bad_shape', message: 'Every item needs a lowercase id.' }); continue; }
    if (seen.has(item.id)) v.push({ itemId: item.id, code: 'bad_shape', message: 'Duplicate item id.' });
    seen.add(item.id);
    v.push(...textIssues(item.id, 'Title', item.title, PB_LIMITS.title, 1, true));
    v.push(...textIssues(item.id, 'Description', item.why, PB_LIMITS.why, 0, true));
    v.push(...validateItem(item));
    for (const s of surfacesOf(item)) {
      const other = surfaceOwner.get(s);
      if (other) v.push({ itemId: item.id, code: 'bad_shape', message: `Items "${other}" and "${item.id}" both write to ${s}.` });
      surfaceOwner.set(s, item.id);
    }
  }
  return v;
}

function inRange(n: unknown, r: { min: number; max: number }): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= r.min && n <= r.max;
}

export function validateItem(item: AnyPlaybookItem): GuardrailViolation[] {
  const id = item.id;
  const v: GuardrailViolation[] = [];
  const bad = (message: string, code: GuardrailViolation['code'] = 'bad_shape') => v.push({ itemId: id, code, message });
  switch (item.kind) {
    case 'call_script': {
      const p = item.params;
      if (!(SCRIPT_SCENARIOS as readonly string[]).includes(p.scenario)) bad('Unknown call-script scenario.');
      v.push(...textIssues(id, 'Opening line', p.opening_line ?? '', PB_LIMITS.scriptOpening));
      v.push(...textIssues(id, 'Script body', p.body, PB_LIMITS.scriptBody, PB_LIMITS.scriptBodyMin));
      break;
    }
    case 'surge': {
      const p = item.params;
      v.push(...textIssues(id, 'Surge message', p.message, PB_LIMITS.surgeMessage, 1));
      v.push(...textIssues(id, 'Surge priority', p.priority, PB_LIMITS.surgePriority, 1));
      if (p.maxBookingsPerDay !== undefined && !inRange(p.maxBookingsPerDay, PB_LIMITS.maxBookingsPerDay)) bad('Max bookings per day is out of range.', 'bad_range');
      break;
    }
    case 'escalation_rule': {
      const p = item.params;
      if (!['emergency', 'after_hours', 'no_answer'].includes(p.trigger)) bad('Unknown escalation trigger.');
      if (!['sms', 'transfer'].includes(p.action)) bad('Unknown escalation action.');
      v.push(...textIssues(id, 'Note', p.note ?? '', PB_LIMITS.escalationNote));
      break;
    }
    case 'capacity': {
      const p = item.params;
      if (p.maxSlotsScalePct !== undefined && !inRange(p.maxSlotsScalePct, PB_LIMITS.maxSlotsScalePct)) bad('Slot change must be between -60% and +50%.', 'bad_range');
      if (p.emergencyReserveAdd !== undefined) {
        if (typeof p.emergencyReserveAdd === 'number' && p.emergencyReserveAdd < 0) bad('Playbooks can raise the emergency reserve but never lower it.', 'reserve_decrease');
        else if (!inRange(p.emergencyReserveAdd, PB_LIMITS.emergencyReserveAdd)) bad('Emergency reserve change must be 0 to 5.', 'bad_range');
      }
      if (p.overbookJobsPerTech !== undefined && !inRange(p.overbookJobsPerTech, PB_LIMITS.overbook)) bad('Overbooking must be 0 to 3.', 'bad_range');
      if (surfacesOf(item).length === 0) bad('Capacity item changes nothing.');
      break;
    }
    case 'message_template': {
      const p = item.params;
      if (!['sms', 'email'].includes(p.channel)) bad('Unknown channel.');
      if (!['appointment', 'service_update', 'payment', 'review_request', 'follow_up', 'marketing'].includes(p.category)) bad('Unknown template category.');
      v.push(...textIssues(id, 'Template name', p.name, PB_LIMITS.templateName, 1, true));
      v.push(...textIssues(id, 'Template body', p.body, p.channel === 'sms' ? PB_LIMITS.smsBody : PB_LIMITS.emailBody, 1, true));
      if (p.channel === 'email') v.push(...textIssues(id, 'Subject', p.subject ?? '', PB_LIMITS.subject, 1, true));
      if (p.channel === 'sms' && p.category === 'marketing' && !/\bstop\b/i.test(p.body)) v.push({ itemId: id, code: 'template_compliance', message: 'Marketing texts must include opt-out language such as "Reply STOP to opt out."' });
      if (p.channel === 'email' && p.category === 'marketing' && !p.body.includes('{{unsubscribe_link}}')) v.push({ itemId: id, code: 'template_compliance', message: 'Marketing emails must include {{unsubscribe_link}}.' });
      break;
    }
    case 'closure': {
      v.push(...textIssues(id, 'Closure label', item.params.label, PB_LIMITS.closureLabel, 1));
      v.push(...textIssues(id, 'Closure message', item.params.message, PB_LIMITS.closureMessage, 1));
      break;
    }
    case 'after_hours_fee': {
      if (!inRange(item.params.amountCents, { min: 0, max: PB_LIMITS.afterHoursFeeCentsMax })) bad('Fee out of range.', 'bad_range');
      v.push(...textIssues(id, 'Fee note', item.params.note ?? '', PB_LIMITS.surgeMessage));
      break;
    }
    case 'automation': {
      if (!SLUG_RE.test(item.params.slug ?? '')) bad('Invalid automation slug.');
      break;
    }
    case 'advisory': {
      v.push(...textIssues(id, 'Advisory', item.params.detail, PB_LIMITS.advisory, 1));
      if (item.params.boostPct !== undefined && !inRange(item.params.boostPct, { min: 0, max: 100 })) bad('Boost percent out of range.', 'bad_range');
      break;
    }
    default:
      bad(`Unknown item kind "${(item as { kind: string }).kind}".`, 'unknown_kind');
  }
  return v;
}

/** Violations only for the items the owner actually left switched on. */
export function validateSelection(pb: Playbook, enabledIds: string[]): GuardrailViolation[] {
  const enabled = new Set(enabledIds);
  const unknown = enabledIds.filter((id) => !pb.items.some((i) => i.id === id));
  const v: GuardrailViolation[] = unknown.map((id) => ({ itemId: id, code: 'bad_shape' as const, message: 'Unknown item selected.' }));
  v.push(...validatePlaybook(pb).filter((x) => x.itemId === null || enabled.has(x.itemId)));
  return v;
}

// ---------------------------------------------------------------------------
// Windows, tokens
// ---------------------------------------------------------------------------

export interface Window { startsAt: Date; endsAt: Date }

export function resolveWindow(pb: Playbook, startsAt: Date, endsAt: Date | null): { window: Window; violations: GuardrailViolation[] } {
  const end = endsAt ?? new Date(startsAt.getTime() + pb.defaultDurationHours * 3_600_000);
  const hours = (end.getTime() - startsAt.getTime()) / 3_600_000;
  const violations: GuardrailViolation[] = [];
  if (!Number.isFinite(hours) || hours <= 0) violations.push({ itemId: null, code: 'duration', message: 'The end must be after the start.' });
  else if (hours > pb.maxDurationHours) violations.push({ itemId: null, code: 'duration', message: `This playbook can run at most ${Math.floor(pb.maxDurationHours / 24)} days at a time.` });
  return { window: { startsAt, endsAt: end }, violations };
}

/** Local calendar date (YYYY-MM-DD) in an IANA timezone. */
export function localDate(d: Date, tz: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Replace %START_DATE% / %END_DATE% with a plain "Month D" in the business timezone. */
export function applyTokens(text: string, w: Window, tz: string | null): string {
  const fmt = (d: Date) => {
    const [, m, day] = localDate(d, tz).split('-');
    return `${MONTHS[Number(m) - 1]} ${Number(day)}`;
  };
  return text.split('%START_DATE%').join(fmt(w.startsAt)).split('%END_DATE%').join(fmt(w.endsAt));
}

/** Calendar dates covered by the window (inclusive), capped. */
export function windowDates(w: Window, tz: string | null, cap = PB_LIMITS.maxWindowDays): string[] {
  const out: string[] = [];
  const last = localDate(new Date(w.endsAt.getTime() - 1), tz);
  let cursor = w.startsAt.getTime();
  for (let i = 0; i < cap + 2; i++) {
    const d = localDate(new Date(cursor), tz);
    if (!out.includes(d)) out.push(d);
    if (d >= last) break;
    cursor += 12 * 3_600_000;
  }
  return out.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Diff (preview / dry-run)
// ---------------------------------------------------------------------------

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildDiff(pb: Playbook, enabledIds: string[], state: CurrentState, w: Window): DiffRow[] {
  const enabled = new Set(enabledIds);
  const tz = state.timezone;
  const rows: DiffRow[] = [];
  const conflicts = detectConflicts(pb, enabledIds, state);
  const conflictBy = new Map(conflicts.map((c) => [c.itemId, c] as const));

  for (const item of pb.items) {
    if (!enabled.has(item.id)) continue;
    const base = { itemId: item.id, kind: item.kind as ItemKind, title: item.title, surface: surfacesOf(item)[0] ?? null };
    const c = conflictBy.get(item.id);
    if (c) {
      rows.push({ ...base, status: 'blocked', before: `Held by "${c.heldBy.playbookName ?? c.heldBy.playbookKey}"`, after: 'Not applied', reason: `Another active playbook already controls ${c.surface}. Roll it back or switch this item off.` });
      continue;
    }
    const approval = requiresApproval(item);
    switch (item.kind) {
      case 'call_script': {
        const live = state.scriptActive[item.params.scenario];
        rows.push({ ...base, status: approval ? 'needs_approval' : 'will_change', before: live ? 'Your current live script' : 'Base assistant prompt (no scenario script)', after: clip(applyTokens(item.params.opening_line || item.params.body, w, tz)) });
        break;
      }
      case 'surge':
        rows.push({ ...base, status: 'will_change', before: state.surge.active ? `Surge on: ${clip(state.surge.message ?? '', 80)}` : 'Surge off', after: `Surge on: ${clip(applyTokens(item.params.message, w, tz), 100)}`, reason: state.surge.active && state.surge.source === 'manual' ? 'A surge you turned on by hand is replaced for the window and restored afterwards.' : undefined });
        break;
      case 'escalation_rule': {
        if (!state.ownerPhone) { rows.push({ ...base, status: 'inactive', before: 'No rule', after: 'Skipped', reason: 'Add a phone number to your profile so alerts have somewhere to go.' }); break; }
        const exists = state.escalationRules.some((r) => r.trigger === item.params.trigger && r.action === item.params.action && r.target === state.ownerPhone);
        rows.push({ ...base, status: exists ? 'no_change' : 'will_change', before: exists ? 'Rule already exists' : 'No such rule', after: `${item.params.trigger} -> ${item.params.action} to your phone` });
        break;
      }
      case 'capacity': {
        const p = item.params;
        const bp = state.bookingPolicy; const dp = state.demandPolicy;
        const bits: string[] = []; const was: string[] = [];
        if (p.maxSlotsScalePct !== undefined && bp) { const next = Math.min(48, Math.max(1, Math.round(bp.maxSlotsPerDay * (1 + p.maxSlotsScalePct / 100)))); was.push(`${bp.maxSlotsPerDay} slots/day`); bits.push(`${next} slots/day`); }
        if (p.overbookJobsPerTech !== undefined && bp) { was.push(`overbook ${bp.overbookJobsPerTech}`); bits.push(`overbook ${p.overbookJobsPerTech}`); }
        if (p.emergencyReserveAdd !== undefined && dp) { was.push(`${dp.emergencyReserveSlots} emergency reserve`); bits.push(`${dp.emergencyReserveSlots + p.emergencyReserveAdd} emergency reserve`); }
        if (p.waitlistEnabled !== undefined && dp) { was.push(`waitlist ${dp.waitlistEnabled ? 'on' : 'off'}`); bits.push(`waitlist ${p.waitlistEnabled ? 'on' : 'off'}`); }
        const inactive = (p.maxSlotsScalePct !== undefined || p.overbookJobsPerTech !== undefined) && !!bp && !bp.enabled;
        rows.push({ ...base, status: inactive ? 'inactive' : bits.length ? 'will_change' : 'no_change', before: was.join(', ') || 'Defaults', after: bits.join(', ') || 'Defaults', reason: inactive ? 'Capacity booking is switched off, so slot limits have no effect until you enable it.' : undefined });
        break;
      }
      case 'message_template': {
        const exists = state.templateNames.includes(item.params.name.trim().toLowerCase());
        rows.push({ ...base, status: exists ? 'no_change' : 'will_change', before: exists ? 'Template with this name exists' : 'No template', after: `Draft ${item.params.channel.toUpperCase()} template. Needs your review before it can send.` });
        break;
      }
      case 'closure': {
        const dates = windowDates(w, tz);
        const existing = new Set(state.holidays.map((h) => h.date));
        const added = dates.filter((d) => !existing.has(d));
        rows.push({ ...base, status: added.length ? 'will_change' : 'no_change', before: `${existing.size} closure date(s)`, after: added.length ? `Closes ${added.length} day(s): ${added[0]}${added.length > 1 ? ` to ${added[added.length - 1]}` : ''}` : 'Dates already closed' });
        break;
      }
      case 'after_hours_fee':
        rows.push({ ...base, status: 'needs_approval', before: state.afterHoursFeeCents === null ? 'No after-hours fee' : 'Current after-hours fee', after: 'New after-hours fee (owner approval required)', reason: 'Price changes always need the account owner to approve.' });
        break;
      case 'automation': {
        const cur = state.automations[item.params.slug];
        rows.push({ ...base, status: cur === 'active' ? 'no_change' : 'will_change', before: cur ?? 'Not installed', after: 'Active' });
        break;
      }
      case 'advisory':
        rows.push({ ...base, status: approval ? 'needs_approval' : 'advisory', before: 'No automatic change', after: clip(item.params.detail), reason: approval ? 'Recorded as a recommendation. Vireek never changes ad budgets or pricing on its own.' : 'Recommendation only. Vireek does not change anything for this item.' });
        break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Scheduler decisions (used by playbook-tick; RPCs re-check under lock)
// ---------------------------------------------------------------------------

export interface ActivationLite { id: string; status: ActivationStatus; startsAt: Date; endsAt: Date; suggestExpiresAt?: Date | null }
export type Transition = 'apply' | 'expire' | 'rollback_expired' | 'stale' | 'noop';

export function decideTransition(a: ActivationLite, now: Date): Transition {
  const t = now.getTime();
  if (a.status === 'suggested') {
    const exp = a.suggestExpiresAt ?? a.endsAt;
    return t >= exp.getTime() ? 'stale' : 'noop';
  }
  if (a.status === 'scheduled') {
    if (t >= a.endsAt.getTime()) return 'expire';       // window fully missed: never apply
    return t >= a.startsAt.getTime() ? 'apply' : 'noop';
  }
  if (a.status === 'active') return t >= a.endsAt.getTime() ? 'rollback_expired' : 'noop';
  return 'noop';
}

/** Auto-start is only for owner-opted-in keys, and only for real signals (never the calendar alone). */
export function mayAutoApply(key: string, autoApplyKeys: string[], trigger: TriggerKind): boolean {
  return autoApplyKeys.includes(key) && (trigger === 'weather' || trigger === 'call_spike');
}

// ---------------------------------------------------------------------------
// Suggestions from real signals
// ---------------------------------------------------------------------------

export interface WeatherSignal { eventType: string; headline?: string; expiresAt: Date | null }
export interface SuggestionInput {
  trade: string | null;
  now: Date;
  weather: WeatherSignal[];
  calls: { last24h: number; trailingDailyAvg: number } | null;
  /** Playbook keys that already have a live (suggested/scheduled/active) activation. */
  liveKeys: string[];
  /** Keys the owner dismissed recently; not re-suggested within the cool-down. */
  dismissedKeys: string[];
}
export interface Suggestion { key: PlaybookKey; trigger: TriggerKind; reason: string; score: number; signal: Record<string, unknown> }

export function tradeMatches(pb: Playbook, trade: string | null): boolean {
  if (pb.trades.includes('all')) return true;
  if (!trade) return false;
  return pb.trades.includes(trade as TradeKey);
}

export function isCallSpike(calls: { last24h: number; trailingDailyAvg: number } | null, ratio: number, minCalls: number): boolean {
  if (!calls) return false;
  const base = Math.max(calls.trailingDailyAvg, 1);
  return calls.last24h >= minCalls && calls.last24h >= ratio * base;
}

/** At most three suggestions, strongest signal first: weather > call spike > season. */
export function suggestPlaybooks(input: SuggestionInput, catalog: Playbook[] = PLAYBOOKS): Suggestion[] {
  const out: Suggestion[] = [];
  const month = input.now.getUTCMonth() + 1;
  const skip = new Set([...input.liveKeys, ...input.dismissedKeys]);
  for (const pb of catalog) {
    if (skip.has(pb.key) || !tradeMatches(pb, input.trade)) continue;
    const alert = input.weather.find((w) => pb.trigger.nwsEvents?.includes(w.eventType) && (!w.expiresAt || w.expiresAt.getTime() > input.now.getTime()));
    if (alert) {
      out.push({ key: pb.key, trigger: 'weather', score: 100, reason: `${alert.eventType} is active for your area.`, signal: { eventType: alert.eventType, headline: alert.headline ?? null, expiresAt: alert.expiresAt?.toISOString() ?? null } });
      continue;
    }
    const cs = pb.trigger.callSpike;
    if (cs && isCallSpike(input.calls, cs.ratio, cs.minCalls)) {
      out.push({ key: pb.key, trigger: 'call_spike', score: 70, reason: `Calls in the last 24 hours (${input.calls!.last24h}) are well above your recent daily average (${input.calls!.trailingDailyAvg.toFixed(1)}).`, signal: { last24h: input.calls!.last24h, trailingDailyAvg: input.calls!.trailingDailyAvg } });
      continue;
    }
    if (pb.trigger.months?.includes(month) && pb.seasons[0] !== 'any') {
      out.push({ key: pb.key, trigger: 'seasonal', score: 30, reason: 'It is the right time of year for this playbook.', signal: { month } });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function filterPlaybooks(list: Playbook[], f: { trade?: TradeKey | 'any'; season?: string; goal?: string; q?: string }): Playbook[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return list.filter((p) => {
    if (f.trade && f.trade !== 'any' && !p.trades.includes(f.trade) && !p.trades.includes('all')) return false;
    if (f.season && f.season !== 'any' && !p.seasons.includes(f.season as never) && !p.seasons.includes('any')) return false;
    if (f.goal && f.goal !== 'any' && !p.goals.includes(f.goal as never)) return false;
    if (q && !`${p.name} ${p.tagline} ${p.summary}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
