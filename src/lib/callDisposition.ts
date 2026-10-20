/**
 * Call dispositions — pure domain logic (no network, no React).
 *
 * After each call staff (or the AI) tags ONE outcome. Some outcomes REQUIRE a
 * follow-up task. The rule table below is mirrored in SQL
 * (20271021000000_call_dispositions.sql -> call_disposition_requires_follow_up)
 * and callDisposition.test.ts fails if the two ever drift apart.
 *
 * Network access lives in callDispositionApi.ts.
 */

import type { TaskPriority } from '@/lib/tasks';

export const DISPOSITION_OUTCOMES = [
  'booked',
  'quoted',
  'existing_customer_issue',
  'no_answer',
  'vendor',
  'wrong_number',
  'spam',
] as const;

export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number];
export type FollowUpRule = 'required' | 'optional' | 'none';
export type DispositionSource = 'staff' | 'ai';

export interface DispositionMeta {
  value: DispositionOutcome;
  label: string;
  description: string;
  followUp: FollowUpRule;
  /** Tailwind classes already used across the dashboard (see AnalyticsPage / LeadSourceBreakdown). */
  barClass: string;
  chipClass: string;
  /** Prefilled follow-up task. */
  followUpTitle: (who: string) => string;
  followUpPriority: TaskPriority;
  followUpDueHours: number;
}

export const DISPOSITIONS: Record<DispositionOutcome, DispositionMeta> = {
  booked: {
    value: 'booked',
    label: 'Booked',
    description: 'An appointment or job was scheduled.',
    followUp: 'optional',
    barClass: 'bg-success-500',
    chipClass: 'bg-success-500/10 text-success-500',
    followUpTitle: (who) => `Confirm appointment with ${who}`,
    followUpPriority: 'normal',
    followUpDueHours: 24,
  },
  quoted: {
    value: 'quoted',
    label: 'Quoted',
    description: 'A price or estimate was given but nothing is booked yet.',
    followUp: 'required',
    barClass: 'bg-accent',
    chipClass: 'bg-accent/10 text-accent',
    followUpTitle: (who) => `Follow up on quote with ${who}`,
    followUpPriority: 'high',
    followUpDueHours: 24,
  },
  existing_customer_issue: {
    value: 'existing_customer_issue',
    label: 'Existing customer issue',
    description: 'A current customer called about a past job, billing, or warranty.',
    followUp: 'required',
    barClass: 'bg-warning-500',
    chipClass: 'bg-warning-500/10 text-warning-500',
    followUpTitle: (who) => `Resolve issue for ${who}`,
    followUpPriority: 'high',
    followUpDueHours: 4,
  },
  no_answer: {
    value: 'no_answer',
    label: 'No answer',
    description: 'We could not reach the caller, or they hung up / left no details.',
    followUp: 'required',
    barClass: 'bg-cta',
    chipClass: 'bg-cta/10 text-cta',
    followUpTitle: (who) => `Call back ${who}`,
    followUpPriority: 'normal',
    followUpDueHours: 2,
  },
  vendor: {
    value: 'vendor',
    label: 'Vendor / sales',
    description: 'A supplier, salesperson, or solicitation.',
    followUp: 'optional',
    barClass: 'bg-blue-500',
    chipClass: 'bg-bg-tertiary text-text-secondary',
    followUpTitle: (who) => `Review vendor call from ${who}`,
    followUpPriority: 'low',
    followUpDueHours: 72,
  },
  wrong_number: {
    value: 'wrong_number',
    label: 'Wrong number',
    description: 'The caller dialed the wrong business.',
    followUp: 'none',
    barClass: 'bg-text-secondary/50',
    chipClass: 'bg-bg-tertiary text-text-secondary',
    followUpTitle: () => '',
    followUpPriority: 'low',
    followUpDueHours: 0,
  },
  spam: {
    value: 'spam',
    label: 'Spam',
    description: 'Robocall, scam, or unwanted automated call.',
    followUp: 'none',
    barClass: 'bg-danger',
    chipClass: 'bg-danger/10 text-danger',
    followUpTitle: () => '',
    followUpPriority: 'low',
    followUpDueHours: 0,
  },
};

export const NOTE_MAX = 2000;
const TITLE_MAX = 200;

export const isOutcome = (v: unknown): v is DispositionOutcome =>
  typeof v === 'string' && (DISPOSITION_OUTCOMES as readonly string[]).includes(v);

export const requiresFollowUp = (o: DispositionOutcome) => DISPOSITIONS[o].followUp === 'required';
export const offersFollowUp = (o: DispositionOutcome) => DISPOSITIONS[o].followUp !== 'none';

// ---------------------------------------------------------------- types ---

export interface DispositionRow {
  id: string;
  user_id: string;
  call_id: string;
  outcome: DispositionOutcome;
  source: DispositionSource;
  ai_outcome: DispositionOutcome | null;
  ai_confidence: number | null;
  note: string | null;
  follow_up_task_id: string | null;
  set_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowUpDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  /** datetime-local value (local time); '' = no due date */
  dueLocal: string;
  assignedTo: string | null;
}

export interface DispositionDraft {
  outcome: DispositionOutcome | null;
  note: string;
  /** Only meaningful for 'optional' outcomes; 'required' is always on, 'none' always off. */
  followUpOn: boolean;
  followUp: FollowUpDraft;
}

// ---------------------------------------------------------- follow-up ---

const pad = (n: number) => String(n).padStart(2, '0');

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Who the call was with, for task titles. */
export function callerLabel(call: { caller_name?: string | null; caller_phone?: string | null }): string {
  return call.caller_name?.trim() || call.caller_phone?.trim() || 'caller';
}

export function defaultFollowUp(
  outcome: DispositionOutcome,
  who: string,
  assignedTo: string | null,
  now: Date = new Date(),
): FollowUpDraft {
  const meta = DISPOSITIONS[outcome];
  const due = new Date(now.getTime() + meta.followUpDueHours * 3_600_000);
  // Round up to the next 5 minutes so the prefilled time looks intentional.
  due.setSeconds(0, 0);
  due.setMinutes(Math.ceil(due.getMinutes() / 5) * 5);
  return {
    title: meta.followUpTitle(who).slice(0, TITLE_MAX),
    description: '',
    priority: meta.followUpPriority,
    dueLocal: meta.followUpDueHours > 0 ? toLocalInput(due) : '',
    assignedTo,
  };
}

export function emptyDispositionDraft(assignedTo: string | null = null): DispositionDraft {
  return {
    outcome: null,
    note: '',
    followUpOn: false,
    followUp: { title: '', description: '', priority: 'normal', dueLocal: '', assignedTo },
  };
}

/**
 * Switching outcome keeps the note and resets the follow-up to that outcome's
 * default. A required outcome turns the follow-up on, unless the call already
 * has a linked task (then creating another is the person's choice).
 */
export function selectOutcome(
  draft: DispositionDraft,
  outcome: DispositionOutcome,
  who: string,
  assignedTo: string | null,
  now: Date = new Date(),
  hasExistingFollowUp = false,
): DispositionDraft {
  const rule = DISPOSITIONS[outcome].followUp;
  return {
    ...draft,
    outcome,
    followUpOn: rule === 'required' && !hasExistingFollowUp,
    followUp: rule === 'none' ? draft.followUp : defaultFollowUp(outcome, who, draft.followUp.assignedTo ?? assignedTo, now),
  };
}

/** The follow-up form is in play: the rule allows one AND the toggle is on (locked on when required with none yet). */
export const followUpIsActive = (d: DispositionDraft): boolean =>
  !!d.outcome && DISPOSITIONS[d.outcome].followUp !== 'none' && d.followUpOn;

export type DispositionErrors = Partial<Record<'outcome' | 'note' | 'title' | 'dueLocal', string>>;

/**
 * `hasExistingFollowUp`: the call already has a live linked task, which
 * satisfies a "required" rule without creating another one.
 */
export function validateDisposition(d: DispositionDraft, hasExistingFollowUp = false): DispositionErrors {
  const errors: DispositionErrors = {};
  if (!d.outcome) {
    errors.outcome = 'Choose how this call ended.';
    return errors;
  }
  if (d.note.length > NOTE_MAX) errors.note = `Keep the note under ${NOTE_MAX} characters.`;

  const mustCreate = requiresFollowUp(d.outcome) && !hasExistingFollowUp;
  if (mustCreate || followUpIsActive(d)) {
    const title = d.followUp.title.trim();
    if (!title) errors.title = 'Give the follow-up task a title.';
    else if (title.length > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`;
    if (d.followUp.dueLocal && Number.isNaN(new Date(d.followUp.dueLocal).getTime())) errors.dueLocal = 'Enter a valid due date.';
  }
  return errors;
}

/** Whether saving this draft must send a task (vs. relying on an existing one). */
export function shouldSendFollowUp(d: DispositionDraft, hasExistingFollowUp: boolean): boolean {
  if (!d.outcome) return false;
  if (requiresFollowUp(d.outcome) && !hasExistingFollowUp) return true;
  return followUpIsActive(d);
}

export interface FollowUpPayload {
  title: string;
  description: string | null;
  priority: TaskPriority;
  due_at: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
}

export function toFollowUpPayload(f: FollowUpDraft, assigneeName: string | null): FollowUpPayload {
  const due = f.dueLocal ? new Date(f.dueLocal) : null;
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    priority: f.priority,
    due_at: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
    assigned_to: f.assignedTo,
    assigned_to_name: f.assignedTo ? assigneeName : null,
  };
}

// ----------------------------------------------------------- suggestion ---

export interface DispositionSuggestion {
  outcome: DispositionOutcome;
  confidence: number;
  reason: string;
}

export interface SuggestableCall {
  status?: string | null;
  booking_outcome?: string | null;
  is_voicemail?: boolean | null;
  duration_seconds?: number | null;
  transcript?: string | null;
  summary?: string | null;
  intent?: string | null;
}

const has = (text: string, re: RegExp) => re.test(text);

/**
 * Deterministic suggestion from data the call already carries (status,
 * booking outcome produced by Call Intelligence, voicemail flag, intent,
 * summary). It never writes anything: the UI offers it as a one-tap shortcut
 * and the person confirms. Returns null when nothing is clear enough.
 */
export function suggestDisposition(call: SuggestableCall): DispositionSuggestion | null {
  if (call.status === 'spam') return { outcome: 'spam', confidence: 0.95, reason: 'This call is already marked as spam.' };
  if (call.booking_outcome === 'booked' || call.status === 'booked') {
    return { outcome: 'booked', confidence: 0.9, reason: 'An appointment was booked on this call.' };
  }

  const text = `${call.intent ?? ''} ${call.summary ?? ''}`.toLowerCase();
  if (has(text, /\bwrong number\b|\bdialed the wrong\b|\bmeant to call\b/)) {
    return { outcome: 'wrong_number', confidence: 0.8, reason: 'The summary mentions a wrong number.' };
  }
  if (has(text, /\bsolicit|\bvendor\b|\bsales ?(?:rep|person|call|pitch)\b|\bmarketing (?:service|offer)|\bextended warranty\b|\bseo\b/)) {
    return { outcome: 'vendor', confidence: 0.7, reason: 'The call looks like a sales or vendor pitch.' };
  }
  if (call.is_voicemail || (!call.transcript?.trim() && (call.duration_seconds ?? 0) <= 10)) {
    return { outcome: 'no_answer', confidence: 0.75, reason: call.is_voicemail ? 'The caller left a voicemail.' : 'The call was very short with no conversation.' };
  }
  if (has(text, /\bexisting customer\b|\bpast (?:job|service)\b|\bcomplain|\bfollow(?:ing)? up on (?:a |the )?(?:repair|job|service|invoice)\b|\binvoice\b|\bbilling\b|\bwarranty\b|\bcome back\b|\bnot fixed\b/)) {
    return { outcome: 'existing_customer_issue', confidence: 0.6, reason: 'The caller appears to be asking about a past job or invoice.' };
  }
  if (has(text, /\bquote\b|\bestimate\b|\bpric(?:e|ing)\b|\bhow much\b|\bcost\b/)) {
    return { outcome: 'quoted', confidence: 0.55, reason: 'The caller asked about pricing or an estimate.' };
  }
  return null;
}

// ------------------------------------------------------------- analytics ---

export interface OutcomeCount {
  outcome: DispositionOutcome;
  total: number;
  ai_count: number;
  with_task: number;
  tasks_done: number;
}

export interface DispositionSummary {
  total_calls: number;
  tagged: number;
  ai_reviewed: number;
  ai_agreed: number;
  by_outcome: OutcomeCount[];
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Defensive parse of the RPC payload: unknown outcomes dropped, numbers coerced. */
export function parseSummary(raw: unknown): DispositionSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(r.by_outcome) ? r.by_outcome : [];
  const by_outcome: OutcomeCount[] = [];
  for (const item of rows) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (!isOutcome(o.outcome)) continue;
    by_outcome.push({
      outcome: o.outcome,
      total: num(o.total),
      ai_count: num(o.ai_count),
      with_task: num(o.with_task),
      tasks_done: num(o.tasks_done),
    });
  }
  const tagged = num(r.tagged);
  return {
    total_calls: Math.max(num(r.total_calls), tagged),
    tagged,
    ai_reviewed: num(r.ai_reviewed),
    ai_agreed: Math.min(num(r.ai_agreed), num(r.ai_reviewed)),
    by_outcome,
  };
}

export interface BreakdownRow {
  outcome: DispositionOutcome;
  label: string;
  barClass: string;
  count: number;
  /** Share of tagged calls, 0-100. */
  pct: number;
  followUp: FollowUpRule;
  withTask: number;
  tasksDone: number;
}

export interface DispositionBreakdown {
  rows: BreakdownRow[];
  tagged: number;
  untagged: number;
  taggedPct: number;
  /** booked / (booked + quoted): of real sales conversations, how many closed. null when none. */
  closeRate: number | null;
  /** (spam + wrong number + vendor) / tagged: calls that never needed staff time. null when nothing tagged. */
  noiseRate: number | null;
  /** Follow-up tasks created / calls whose outcome calls for one (required + optional-with-task). null when none. */
  followUpCoverage: number | null;
  aiAgreement: number | null;
  aiReviewed: number;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function buildBreakdown(summary: DispositionSummary): DispositionBreakdown {
  const byOutcome = new Map(summary.by_outcome.map((r) => [r.outcome, r]));
  const rows: BreakdownRow[] = DISPOSITION_OUTCOMES.map((outcome) => {
    const r = byOutcome.get(outcome);
    const meta = DISPOSITIONS[outcome];
    return {
      outcome,
      label: meta.label,
      barClass: meta.barClass,
      count: r?.total ?? 0,
      pct: pct(r?.total ?? 0, summary.tagged),
      followUp: meta.followUp,
      withTask: r?.with_task ?? 0,
      tasksDone: r?.tasks_done ?? 0,
    };
  })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  const count = (o: DispositionOutcome) => byOutcome.get(o)?.total ?? 0;
  const sales = count('booked') + count('quoted');
  const noise = count('spam') + count('wrong_number') + count('vendor');

  const needsFollowUp = rows.filter((r) => r.followUp === 'required').reduce((s, r) => s + r.count, 0);
  const requiredCovered = rows.filter((r) => r.followUp === 'required').reduce((s, r) => s + Math.min(r.withTask, r.count), 0);

  return {
    rows,
    tagged: summary.tagged,
    untagged: Math.max(summary.total_calls - summary.tagged, 0),
    taggedPct: pct(summary.tagged, summary.total_calls),
    closeRate: sales > 0 ? pct(count('booked'), sales) : null,
    noiseRate: summary.tagged > 0 ? pct(noise, summary.tagged) : null,
    followUpCoverage: needsFollowUp > 0 ? pct(requiredCovered, needsFollowUp) : null,
    aiAgreement: summary.ai_reviewed > 0 ? pct(summary.ai_agreed, summary.ai_reviewed) : null,
    aiReviewed: summary.ai_reviewed,
  };
}

// --------------------------------------------------------------- errors ---

/** Maps Postgres / RPC error text to a message a person can act on. */
export function describeDispositionError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '')).toLowerCase();
  if (msg.includes('follow_up_required')) return 'This outcome needs a follow-up task. Add one and save again.';
  if (msg.includes('call_not_found')) return 'This call could not be found. It may have been deleted.';
  if (msg.includes('invalid_follow_up')) return 'The follow-up task needs a title (up to 200 characters).';
  if (msg.includes('note_too_long')) return `Keep the note under ${NOTE_MAX} characters.`;
  if (msg.includes('row-level security') || msg.includes('permission denied')) return 'You do not have permission to tag this call or assign that task.';
  if (msg.includes('not_authenticated') || msg.includes('jwt')) return 'Your session expired. Sign in again and retry.';
  return 'Could not save the outcome. Check your connection and try again.';
}
