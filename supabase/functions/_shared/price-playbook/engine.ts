// supabase/functions/_shared/price-playbook/engine.ts
//
// Vireek Price-First Playbook — deterministic core.
//
// Callers who open with "how much?" get an honest, policy-bound answer. This module
// decides WHAT may be said about price; it never decides what a price IS.
//
// Rules (same philosophy as quote-truth/engine.ts and ai-core/priceEnforcement.ts):
//   - Pure & deterministic: no network, no Date.now(), no randomness, no LLM, no imports.
//     `now` is injected. Usable from Deno edge functions, Vitest and (type-only) the app.
//   - Never invents a number. Every dollar figure in a reply is a `Figure` carrying the
//     PriceSource it came from. If no valid figure exists the answer is "needs a visit".
//   - Fails closed: inactive / invalid / stale / region-unapproved policies degrade to
//     `needs_visit` (no dollar amount spoken) instead of guessing.
//   - Channel-agnostic: voice, SMS and web chat call the same functions; `channel` only
//     changes formatting (one question per voice turn, numbered list in text).
//
// NOT LEGAL ADVICE. Topics flagged for counsel before enabling dollar figures in a state:
//   - state unfair/deceptive-practices & price-advertising rules (bait-and-switch, "starting at")
//   - diagnostic / trip-fee disclosure and credit-toward-repair wording
//   - written-estimate / authorization-before-work requirements for home repair
//   - contractor licence-number disclosure, right-to-cancel for in-home sales
//   - call-recording consent (handled elsewhere: _shared/compliance/recordingConsent.ts)

export const PLAYBOOK_VERSION = '1.0.0';

export type PriceMode = 'exact_flat' | 'range' | 'starting_at' | 'diagnostic_fee_only' | 'needs_visit';
export type Trade = 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'roofing' | 'general';
export type Channel = 'voice' | 'sms' | 'web';
export type FigureKind = 'flat' | 'range_low' | 'range_high' | 'starting_at' | 'diagnostic_fee';
export type DowngradeReason =
  | 'inactive'
  | 'invalid_policy'
  | 'stale_source'
  | 'legal_gate'
  | 'region_unknown';

export interface PriceSource {
  kind: 'price_book' | 'owner_entered';
  price_book_item_id: string | null;
  /** ISO timestamp of the last time a human verified this figure. */
  verified_at: string;
}

export interface PricePolicy {
  service_key: string;
  display_name: string;
  trade: Trade;
  mode: PriceMode;
  amount_low_cents: number | null;
  amount_high_cents: number | null;
  diagnostic_fee_cents: number | null;
  fee_credited_on_repair: boolean;
  /** Only say "you get the price before any work starts" when the business really does this. */
  written_price_before_work: boolean;
  includes: string[];
  changes_price: string[];
  source: PriceSource;
  /** Two-letter US states where counsel approved speaking dollar figures. Empty = none. */
  approved_states: string[];
  legal_review_status: 'pending' | 'approved';
  active: boolean;
}

export interface PriceBookLite {
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number;
  price_max_cents: number | null;
}

export interface Figure {
  cents: number;
  kind: FigureKind;
  source: PriceSource;
}

export interface PriceAnswer {
  mode_used: PriceMode;
  downgraded_reason: DowngradeReason | null;
  figures: Figure[];
  /** The allowed answer, spoken FIRST. */
  core_sentence: string;
  fee_sentence: string | null;
  included_sentence: string | null;
  changes_sentence: string | null;
  /** Human-readable provenance for the dashboard (never spoken). */
  source_labels: string[];
  /** core + fee + included + changes, ready to say. */
  spoken: string;
}

export interface ResolveContext {
  /** Normalised 2-letter state, or null when unknown. */
  state: string | null;
  now: Date;
  /** Figures older than this are not spoken. Default 180. */
  max_source_age_days?: number;
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function formatCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rem = cents % 100;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rem === 0 ? `$${w}` : `$${w}.${rem.toString().padStart(2, '0')}`;
}

function isCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100_000_000;
}

// ---------------------------------------------------------------------------
// Price-book linkage: a policy sourced from the price book reads amounts LIVE
// from the catalog item, so a catalog edit can never leave Sarah quoting stale numbers.
// ---------------------------------------------------------------------------

export function applyPriceBookAmounts(policy: PricePolicy, item: PriceBookLite | null): PricePolicy {
  if (policy.source.kind !== 'price_book') return policy;
  if (!item || item.pricing_model === 'hourly') {
    // Hourly rates are not a job price; unlinked items have nothing to speak.
    return { ...policy, amount_low_cents: null, amount_high_cents: null };
  }
  return {
    ...policy,
    amount_low_cents: item.price_cents,
    amount_high_cents: item.pricing_model === 'range' ? item.price_max_cents : null,
  };
}

// ---------------------------------------------------------------------------
// Policy -> allowed answer
// ---------------------------------------------------------------------------

function needsVisit(policy: PricePolicy, reason: DowngradeReason | null): PriceAnswer {
  const core =
    `I don't want to give you a number I can't stand behind. For ${policy.display_name}, the price depends on what a technician actually finds, so I'd rather get you an accurate one than a guess.`;
  return {
    mode_used: 'needs_visit',
    downgraded_reason: reason,
    figures: [],
    core_sentence: core,
    fee_sentence: null,
    included_sentence: null,
    changes_sentence: null,
    source_labels: [],
    spoken: core,
  };
}

function listJoin(items: string[]): string {
  const clean = items.map((s) => s.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

function srcLabel(source: PriceSource, what: string): string {
  const day = source.verified_at.slice(0, 10);
  const origin = source.kind === 'price_book' ? 'Price book' : 'Owner entered';
  return `${what}: ${origin}, verified ${day}`;
}

export function validatePolicy(p: PricePolicy): boolean {
  switch (p.mode) {
    case 'exact_flat':
    case 'starting_at':
      return isCents(p.amount_low_cents) && p.amount_low_cents > 0;
    case 'range':
      return (
        isCents(p.amount_low_cents) &&
        isCents(p.amount_high_cents) &&
        p.amount_low_cents > 0 &&
        p.amount_high_cents >= p.amount_low_cents
      );
    case 'diagnostic_fee_only':
      return isCents(p.diagnostic_fee_cents) && p.diagnostic_fee_cents > 0;
    case 'needs_visit':
      return true;
    default:
      return false;
  }
}

export function resolvePriceAnswer(policyIn: PricePolicy, ctx: ResolveContext): PriceAnswer {
  const p = policyIn;
  if (!p.active) return needsVisit(p, 'inactive');
  if (p.mode === 'needs_visit') return needsVisit(p, null);
  if (!validatePolicy(p)) return needsVisit(p, 'invalid_policy');

  const verified = Date.parse(p.source.verified_at);
  const maxAge = (ctx.max_source_age_days ?? 180) * DAY_MS;
  if (!Number.isFinite(verified) || ctx.now.getTime() - verified > maxAge || verified > ctx.now.getTime() + DAY_MS) {
    return needsVisit(p, 'stale_source');
  }

  if (!ctx.state) return needsVisit(p, 'region_unknown');
  if (p.legal_review_status !== 'approved' || !p.approved_states.includes(ctx.state)) {
    return needsVisit(p, 'legal_gate');
  }

  const figures: Figure[] = [];
  const labels: string[] = [];
  let core = '';
  const name = p.display_name;

  switch (p.mode) {
    case 'exact_flat': {
      const c = p.amount_low_cents as number;
      figures.push({ cents: c, kind: 'flat', source: p.source });
      labels.push(srcLabel(p.source, `${formatCents(c)} flat rate`));
      core = `Our flat rate for ${name} is ${formatCents(c)}.`;
      break;
    }
    case 'range': {
      const lo = p.amount_low_cents as number;
      const hi = p.amount_high_cents as number;
      figures.push({ cents: lo, kind: 'range_low', source: p.source }, { cents: hi, kind: 'range_high', source: p.source });
      labels.push(srcLabel(p.source, `${formatCents(lo)}–${formatCents(hi)} range`));
      core =
        lo === hi
          ? `${name} is typically ${formatCents(lo)}.`
          : `${name} typically runs between ${formatCents(lo)} and ${formatCents(hi)}, depending on what the technician finds.`;
      break;
    }
    case 'starting_at': {
      const c = p.amount_low_cents as number;
      figures.push({ cents: c, kind: 'starting_at', source: p.source });
      labels.push(srcLabel(p.source, `Starting at ${formatCents(c)}`));
      core = `${name} starts at ${formatCents(c)}. The final price depends on the job, and it can be higher than that.`;
      break;
    }
    case 'diagnostic_fee_only': {
      const c = p.diagnostic_fee_cents as number;
      figures.push({ cents: c, kind: 'diagnostic_fee', source: p.source });
      labels.push(srcLabel(p.source, `${formatCents(c)} diagnostic fee`));
      core = `I can't responsibly quote the repair before a technician has looked at it. The diagnostic visit is ${formatCents(c)}.`;
      break;
    }
    default:
      return needsVisit(p, 'invalid_policy');
  }

  // Fee disclosure: a diagnostic/trip fee attached to a priced service must always be said.
  let fee: string | null = null;
  if (p.mode !== 'diagnostic_fee_only' && isCents(p.diagnostic_fee_cents) && p.diagnostic_fee_cents > 0) {
    figures.push({ cents: p.diagnostic_fee_cents, kind: 'diagnostic_fee', source: p.source });
    labels.push(srcLabel(p.source, `${formatCents(p.diagnostic_fee_cents)} diagnostic fee`));
    fee = `There is also a ${formatCents(p.diagnostic_fee_cents)} diagnostic fee${
      p.fee_credited_on_repair ? ', which is credited toward the repair if you go ahead' : ''
    }.`;
  } else if (p.mode === 'diagnostic_fee_only' && p.fee_credited_on_repair) {
    fee = 'That fee is credited toward the repair if you go ahead.';
  }
  if (p.mode === 'diagnostic_fee_only' && p.written_price_before_work) {
    fee = `${fee ? fee + ' ' : ''}You get the repair price before any work starts.`;
  }

  const inc = listJoin(p.includes);
  const chg = listJoin(p.changes_price);
  const included = inc ? `That includes ${inc}.` : null;
  const changes = chg ? `The price can change if ${chg}.` : null;

  const spoken = [core, fee, included, changes].filter(Boolean).join(' ');
  return {
    mode_used: p.mode,
    downgraded_reason: null,
    figures,
    core_sentence: core,
    fee_sentence: fee,
    included_sentence: included,
    changes_sentence: changes,
    source_labels: labels,
    spoken,
  };
}

// ---------------------------------------------------------------------------
// Qualifying questions (2–3, trade-aware, skip what the caller already told us)
// ---------------------------------------------------------------------------

export interface QualifyingQuestion {
  id: string;
  text: string;
}

const Q: Record<Trade, QualifyingQuestion[]> = {
  hvac: [
    { id: 'hvac_symptom', text: 'What is the system doing right now: not cooling or heating, making noise, or leaking?' },
    { id: 'hvac_age', text: 'Roughly how old is the system?' },
    { id: 'hvac_type', text: 'Is it a central system, a heat pump, or a ductless unit?' },
    { id: 'hvac_urgency', text: 'Is anyone without heat or cooling right now?' },
  ],
  plumbing: [
    { id: 'plumb_issue', text: 'What is happening: a leak, a clog, no hot water, or something else?' },
    { id: 'plumb_where', text: 'Which fixture or part of the house is it in?' },
    { id: 'plumb_active', text: 'Is water actively running or leaking right now?' },
    { id: 'plumb_age', text: 'Do you know roughly how old the fixture or water heater is?' },
  ],
  electrical: [
    { id: 'elec_issue', text: 'What are you seeing: no power, a tripping breaker, or an outlet or switch that is not working?' },
    { id: 'elec_scope', text: 'Is it one spot or several rooms?' },
    { id: 'elec_safety', text: 'Have you noticed any burning smell, sparking, or a hot panel?' },
    { id: 'elec_age', text: 'Do you know roughly how old the home or panel is?' },
  ],
  appliance: [
    { id: 'app_type', text: 'Which appliance is it, and what brand?' },
    { id: 'app_symptom', text: 'What is it doing, or not doing?' },
    { id: 'app_age', text: 'Roughly how old is it?' },
  ],
  roofing: [
    { id: 'roof_issue', text: 'Is this a leak, missing shingles, or a full replacement question?' },
    { id: 'roof_size', text: 'Roughly how large is the home, or how many stories?' },
    { id: 'roof_material', text: 'Do you know what the roof is made of?' },
    { id: 'roof_active', text: 'Is water coming inside right now?' },
  ],
  general: [
    { id: 'gen_issue', text: 'Can you tell me a little more about what is going on?' },
    { id: 'gen_where', text: 'Where in the home is it?' },
    { id: 'gen_urgency', text: 'How urgent is it for you?' },
  ],
};

export function pickQualifyingQuestions(
  trade: Trade,
  answered: ReadonlySet<string>,
  max = 3,
): QualifyingQuestion[] {
  const cap = Math.min(Math.max(Math.trunc(max), 0), 3);
  return (Q[trade] ?? Q.general).filter((q) => !answered.has(q.id)).slice(0, cap);
}

// ---------------------------------------------------------------------------
// Value & objections. Only claims the business has ENABLED are ever spoken.
// ---------------------------------------------------------------------------

export interface ValueProps {
  licensed_techs: boolean;
  warranty_months: number | null;
  on_time_guarantee: boolean;
}

export function composeValueLine(v: ValueProps): string | null {
  const bits: string[] = [];
  if (v.licensed_techs) bits.push('licensed technicians');
  if (v.warranty_months && v.warranty_months > 0) {
    bits.push(`a ${v.warranty_months}-month warranty on our work`);
  }
  if (v.on_time_guarantee) bits.push('our on-time arrival policy');
  if (bits.length === 0) return null;
  return `What you get with us: ${listJoin(bits)}.`;
}

export type ObjectionKind = 'cheaper_online' | 'too_expensive' | 'shopping_around' | 'none';

export function classifyObjection(text: string): ObjectionKind {
  const t = text.toLowerCase();
  if (/(cheaper|lower|less)\b.{0,30}\b(online|website|app|chat ?bot|chatbot|elsewhere|other (company|place|guy))|\b(online|website|chat ?bot|chatbot)\b.{0,40}\b(quote|price|said|told|\$)/.test(t)) {
    return 'cheaper_online';
  }
  if (/too (much|expensive|high)|can'?t afford|out of my budget|that'?s a lot/.test(t)) return 'too_expensive';
  if (/shopping around|getting (a few|other|several) (quotes|estimates)|comparing|calling around/.test(t)) {
    return 'shopping_around';
  }
  return 'none';
}

export function composeObjectionReply(kind: ObjectionKind, v: ValueProps): string | null {
  if (kind === 'none') return null;
  const value = composeValueLine(v);
  const compare =
    'When you compare, it helps to ask each company whether the number is a firm quote or an estimate, and what it includes, such as parts, permits, warranty and who does the work.';
  switch (kind) {
    case 'cheaper_online':
      return [
        "That's fair, and I can't speak to another company's quote or what went into it.",
        compare,
        value,
        'If you would like, I can get you an accurate number for your situation so you can compare like for like.',
      ]
        .filter(Boolean)
        .join(' ');
    case 'shopping_around':
      return [
        'Comparing is smart.',
        compare,
        value,
        'I can get you a number for your exact situation so it is easy to compare.',
      ]
        .filter(Boolean)
        .join(' ');
    case 'too_expensive':
      return [
        'I hear you, a repair bill matters.',
        'The number depends on what is actually wrong, and there is often more than one option.',
        value,
        'I can have someone look at your situation and walk you through the options.',
      ]
        .filter(Boolean)
        .join(' ');
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Fastest next step. Nothing is offered unless the orchestrator says it is READY.
// ---------------------------------------------------------------------------

export interface NextStepOptions {
  /** True only when a text-able remote-estimate link can be generated during this call. */
  remote_estimate_ready: boolean;
  has_mobile_number: boolean;
  same_day_slot_available: boolean;
  human_callback_available: boolean;
  /** Mention financing only when enabled AND the top figure is at/above this threshold. */
  financing_min_cents: number | null;
}

export type NextStepKind = 'remote_estimate' | 'same_day_diagnostic' | 'human_callback';

export interface NextStep {
  kind: NextStepKind;
  speak: string;
}

export function buildNextSteps(answer: PriceAnswer, o: NextStepOptions): { steps: NextStep[]; financing_line: string | null } {
  const steps: NextStep[] = [];
  if (o.remote_estimate_ready && o.has_mobile_number) {
    steps.push({
      kind: 'remote_estimate',
      speak: 'The fastest way is a quick photo or video estimate. I can text you a link right now, and it takes a couple of minutes.',
    });
  }
  if (o.same_day_slot_available) {
    steps.push({
      kind: 'same_day_diagnostic',
      speak: 'We also have a same-day diagnostic slot available if you would like a technician to come out.',
    });
  }
  if (o.human_callback_available) {
    steps.push({
      kind: 'human_callback',
      speak: 'Or I can have one of our estimators call you back to go through it in detail.',
    });
  }
  const top = answer.figures.filter((f) => f.kind !== 'diagnostic_fee').reduce((m, f) => Math.max(m, f.cents), 0);
  const financing_line =
    o.financing_min_cents !== null && top >= o.financing_min_cents
      ? 'Financing may be available for larger jobs, and I can text you the details if that would help.'
      : null;
  return { steps, financing_line };
}

// ---------------------------------------------------------------------------
// Playbook guidance appended to the tool result / message context: what to do AFTER the price
// answer (value, "found it cheaper online", fastest next step). Only enabled claims appear.
// ---------------------------------------------------------------------------

export interface PlaybookSettings extends ValueProps {
  same_day_diagnostic_enabled: boolean;
  human_callback_enabled: boolean;
  financing_min_cents: number | null;
}

export const DEFAULT_PLAYBOOK_SETTINGS: PlaybookSettings = {
  licensed_techs: false,
  warranty_months: null,
  on_time_guarantee: false,
  same_day_diagnostic_enabled: false,
  human_callback_enabled: false,
  financing_min_cents: null,
};

export function composeGuidance(answer: PriceAnswer, s: PlaybookSettings, channel: Channel, hasMobileNumber: boolean): string {
  const lines: string[] = ['AFTER THE PRICE ANSWER (put it in your own words; never add or change a dollar amount):'];
  const value = composeValueLine(s);
  if (value) lines.push(`- Once they have answered your question, explain the value: ${value}`);
  for (const [label, kind] of [
    ['they say they found it cheaper online or elsewhere', 'cheaper_online'],
    ['they say it is too expensive', 'too_expensive'],
    ['they say they are shopping around', 'shopping_around'],
  ] as const) {
    const r = composeObjectionReply(kind, s);
    if (r) lines.push(`- If ${label}: ${r}`);
  }
  const { steps, financing_line } = buildNextSteps(answer, {
    remote_estimate_ready: false, // no public text-a-link estimate flow exists yet; never offered
    has_mobile_number: hasMobileNumber,
    same_day_slot_available: channel === 'voice' && s.same_day_diagnostic_enabled,
    human_callback_available: s.human_callback_enabled,
    financing_min_cents: s.financing_min_cents,
  });
  for (const st of steps) {
    const note = st.kind === 'same_day_diagnostic' ? ' (confirm a real slot with the availability tool first; never promise one you have not confirmed)' : '';
    lines.push(`- Fastest next step option: ${st.speak}${note}`);
  }
  if (financing_line) lines.push(`- You may mention: ${financing_line}`);
  lines.push('- Never disparage another company, never claim to be the cheapest, never offer a price match, never pressure the caller.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// First reply: acknowledge -> allowed answer FIRST -> qualifying questions.
// Same function for voice / SMS / web; channel only changes formatting.
// ---------------------------------------------------------------------------

export interface FirstReply {
  text: string;
  answer: PriceAnswer;
  questions: QualifyingQuestion[];
}

export function composeFirstReply(
  policy: PricePolicy,
  ctx: ResolveContext,
  channel: Channel,
  answeredQuestionIds: ReadonlySet<string> = new Set(),
): FirstReply {
  const answer = resolvePriceAnswer(policy, ctx);
  const all = pickQualifyingQuestions(policy.trade, answeredQuestionIds, 3);
  // Voice asks one question per turn (a spoken list is unusable); text asks all of them at once.
  const questions = channel === 'voice' ? all.slice(0, 1) : all;
  const ack = 'Good question, and I want to give you an honest answer.';
  let tail = '';
  if (questions.length > 0) {
    tail =
      channel === 'voice'
        ? `To narrow it down: ${questions[0].text}`
        : `To narrow it down:\n${questions.map((q, i) => `${i + 1}) ${q.text}`).join('\n')}`;
  }
  const sep = channel === 'voice' ? ' ' : '\n\n';
  return { text: [ack, answer.spoken, tail].filter(Boolean).join(channel === 'voice' ? ' ' : sep), answer, questions };
}

// ---------------------------------------------------------------------------
// Audit: deterministic check of what was actually SAID (no LLM grading its own output).
// Used by the scenario evals and runnable post-call / pre-send on SMS and web.
// ---------------------------------------------------------------------------

export type Violation =
  | 'invented_price'
  | 'missing_fee_disclosure'
  | 'disparagement'
  | 'false_superlative_or_price_match'
  | 'unbacked_guarantee'
  | 'pressure_tactic'
  | 'banned_persona_phrase';

const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const DISPARAGE_RE = /\b(scam|scammers?|rip[- ]?off|ripoffs|liars?|fraud|fake quote|cowboys?|shady|crooks?)\b/i;
const SUPERLATIVE_RE = /\b(cheapest|lowest price|best price|beat any|price[- ]match|we'?ll match|guaranteed lowest)\b/i;
const GUARANTEE_RE = /\bguarantee[sd]?\b/i;
const PRESSURE_RE = /\b(act now|today only|limited time|before it'?s too late|last chance|only \d+ (spots|slots) left|prices? (will|are going to) go up)\b/i;
const BANNED_PERSONA_RE =
  /(i understand your frustration|your call is important|calm down|as an ai language model)/i;

export interface AuditOptions {
  /** True (default) for the message that states the price; false for follow-ups (value line, objection reply, next step). */
  expect_fee?: boolean;
}

export function auditReply(text: string, answer: PriceAnswer, v: ValueProps, opts: AuditOptions = {}): Violation[] {
  const out = new Set<Violation>();
  const allowed = new Set(answer.figures.map((f) => f.cents));
  for (const m of text.matchAll(MONEY_RE)) {
    const cents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
    if (!allowed.has(cents)) out.add('invented_price');
  }
  const fee = answer.figures.find((f) => f.kind === 'diagnostic_fee');
  if (fee && opts.expect_fee !== false && !text.includes(formatCents(fee.cents))) out.add('missing_fee_disclosure');
  if (DISPARAGE_RE.test(text)) out.add('disparagement');
  if (SUPERLATIVE_RE.test(text)) out.add('false_superlative_or_price_match');
  if (GUARANTEE_RE.test(text) && !v.on_time_guarantee && !(v.warranty_months && v.warranty_months > 0)) {
    out.add('unbacked_guarantee');
  }
  if (PRESSURE_RE.test(text)) out.add('pressure_tactic');
  if (BANNED_PERSONA_RE.test(text)) out.add('banned_persona_phrase');
  return [...out];
}

// ---------------------------------------------------------------------------
// Metrics. One row per conversation event; summary is computed from the LATEST stage
// each conversation reached, so a booked call is never also counted as abandoned.
// ---------------------------------------------------------------------------

export type PriceStage =
  | 'price_asked'
  | 'answer_given'
  | 'qualified'
  | 'objection'
  | 'next_step_offered'
  | 'booked'
  | 'abandoned';

const STAGE_RANK: Record<PriceStage, number> = {
  price_asked: 1,
  answer_given: 2,
  qualified: 3,
  objection: 3,
  next_step_offered: 4,
  abandoned: 5,
  booked: 6,
};

export interface PriceEvent {
  conversation_key: string;
  stage: PriceStage;
  ticket_cents: number | null;
  occurred_at: string;
}

export interface PriceMetrics {
  conversations_with_price_ask: number;
  price_ask_rate: number | null;
  conversion_after_price: number | null;
  abandon_rate: number | null;
  average_ticket_cents: number | null;
}

export function summarizePriceConversations(events: PriceEvent[], totalConversations: number): PriceMetrics {
  const best = new Map<string, PriceEvent>();
  for (const e of events) {
    const cur = best.get(e.conversation_key);
    if (!cur || STAGE_RANK[e.stage] > STAGE_RANK[cur.stage]) best.set(e.conversation_key, e);
    else if (cur && STAGE_RANK[e.stage] === STAGE_RANK[cur.stage] && e.occurred_at > cur.occurred_at) {
      best.set(e.conversation_key, e);
    }
  }
  const finals = [...best.values()];
  const asked = finals.length;
  const booked = finals.filter((e) => e.stage === 'booked');
  const abandoned = finals.filter((e) => e.stage === 'abandoned').length;
  const tickets = booked.map((e) => e.ticket_cents).filter((n): n is number => typeof n === 'number');
  const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
  return {
    conversations_with_price_ask: asked,
    price_ask_rate: ratio(asked, totalConversations),
    conversion_after_price: ratio(booked.length, asked),
    abandon_rate: ratio(abandoned, asked),
    average_ticket_cents: tickets.length ? Math.round(tickets.reduce((a, b) => a + b, 0) / tickets.length) : null,
  };
}
