/**
 * Site Safety Intelligence — pure core (no imports, no I/O).
 *
 * This file is shared by the browser (src/lib/siteSafety.ts), by Vitest and by Deno edge
 * functions (supabase/functions/safety-tick, vapi-webhook). Keep it dependency-free.
 *
 * FAIRNESS CONTRACT (enforced here and again by DB constraints):
 *  - Only event-based, behaviour-based and self-reported facts, each with a source and a date.
 *  - No neighbourhood / crime scoring, no demographic or voice/audio based inference,
 *    no inference from protected attributes. Facts attach to an exact address, never an area.
 *  - Machine-extracted facts are "pending_review": they never raise a job to the highest tier
 *    until a person confirms them.
 */

/* ------------------------------------------------------------------ */
/*  Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const HAZARD_CATEGORIES = [
  'animal',
  'lighting',
  'structure',
  'aggressive_behavior',
  'intoxication_reported',
  'access_hazard',
  'electrical_hazard',
  'biological_hazard',
  'other_event',
] as const;
export type HazardCategory = (typeof HAZARD_CATEGORIES)[number];

export const FACT_SOURCES = [
  'call_volunteered',
  'staff_incident',
  'equipment_data',
  'technician_report',
  'customer_self_report',
] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export const REVIEW_STATUSES = ['pending_review', 'confirmed', 'rejected', 'disputed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const RISK_TIERS = ['standard', 'elevated', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const PRECAUTIONS = [
  'customer_present',
  'daytime_only',
  'two_person_crew',
  'meet_outside_first',
  'remote_video_preassessment',
] as const;
export type Precaution = (typeof PRECAUTIONS)[number];

export const ESCALATION_STEPS = ['dispatcher', 'emergency_contact', 'company_next'] as const;
export type EscalationStepKind = (typeof ESCALATION_STEPS)[number];

/** Categories that describe a *person's* behaviour. They need human confirmation to count as high. */
export const PERSON_CATEGORIES: ReadonlySet<HazardCategory> = new Set<HazardCategory>([
  'aggressive_behavior',
  'intoxication_reported',
]);

/** Sources written by a person (as opposed to machine-extracted). */
export const HUMAN_SOURCES: ReadonlySet<FactSource> = new Set<FactSource>([
  'staff_incident',
  'technician_report',
  'customer_self_report',
]);

export const DEFAULT_PRECAUTIONS: Record<RiskTier, Precaution[]> = {
  standard: [],
  elevated: ['customer_present', 'meet_outside_first'],
  high: ['customer_present', 'meet_outside_first', 'two_person_crew', 'daytime_only'],
};

export const MAX_FACT_TEXT = 300;
export const DEFAULT_FACT_TTL_DAYS = 365;

/** Shown in every escalation message and in the app. We never claim to contact emergency services. */
export const EMERGENCY_SERVICES_NOTICE =
  'Vireek does not contact emergency services. If someone may be in danger, call your local emergency number first.';

/* ------------------------------------------------------------------ */
/*  Fairness lint (backstop — human review is the real control)         */
/* ------------------------------------------------------------------ */

/**
 * Words that point at protected attributes or at area/demographic profiling. A fact whose text
 * contains one of these is rejected at write time. This list is a best-effort backstop; it cannot
 * catch every phrasing, which is why call-derived facts also go through human review.
 */
const PROTECTED_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'race_ethnicity', re: /\b(black|white|asian|latino|latina|hispanic|arab|african|caucasian|ethnic\w*|race|racial|minorit\w+)\b/i },
  { code: 'religion', re: /\b(muslim|islam\w*|jewish|jew|christian|hindu|sikh|buddhist|religio\w+|church|mosque|temple)\b/i },
  { code: 'nationality_immigration', re: /\b(immigra\w+|foreign\w*|illegal alien|undocumented|nationalit\w+|refugee)\b/i },
  { code: 'accent_voice_language', re: /\b(accent\w*|sounded like|sounds like|voice (?:sounded|tone|pitch)|broken english|spoke poor english)\b/i },
  { code: 'gender_orientation', re: /\b(gay|lesbian|trans\w*|homosexual|sexual orientation|gender identity)\b/i },
  { code: 'disability_health', re: /\b(disab\w+|mental(?:ly)? (?:ill|unstable)|crazy|insane|psycho\w*|retard\w*|schizo\w*)\b/i },
  { code: 'age', re: /\b(elderly|old (?:man|woman|lady|guy)|senior citizen|too old|teenager)\b/i },
  { code: 'area_profiling', re: /\b(bad|rough|sketchy|dangerous|poor|ghetto|high[- ]crime|crime[- ]ridden)\s+(neighbou?rhood|area|part of town|district|block)\b|\bneighbou?rhood\b|\bcrime (?:rate|score|map)\b/i },
  { code: 'class_proxy', re: /\b(trailer park|projects|section 8|welfare|low[- ]income)\b/i },
];

export interface LintResult {
  ok: boolean;
  codes: string[];
}

export function lintFactText(text: string): LintResult {
  const codes: string[] = [];
  const clean = (text ?? '').normalize('NFKC');
  for (const p of PROTECTED_PATTERNS) {
    if (p.re.test(clean)) codes.push(p.code);
  }
  if (clean.trim().length === 0) codes.push('empty');
  if (clean.length > MAX_FACT_TEXT) codes.push('too_long');
  return { ok: codes.length === 0, codes };
}

/* ------------------------------------------------------------------ */
/*  Exact-address key (no neighbourhood matching, by design)            */
/* ------------------------------------------------------------------ */

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\broad\b/g, 'rd'], [/\bdrive\b/g, 'dr'],
  [/\blane\b/g, 'ln'], [/\bboulevard\b/g, 'blvd'], [/\bcourt\b/g, 'ct'], [/\bplace\b/g, 'pl'],
  [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w'],
  [/\bstrasse\b/g, 'str'], [/\bstraße\b/g, 'str'],
];
const UNIT_RE = /\b(?:apt|apartment|unit|suite|ste|flat|wohnung|etage|floor|fl)\.?\s*#?\s*[\w-]+\b|#\s*[\w-]+/g;

/**
 * Normalises a street address so the same house matches across spellings. Unit/apartment
 * designators are dropped on purpose: a loose dog belongs to the property, not to one flat.
 * Returns null when there is no street-level detail (we never fall back to an area).
 */
export function normalizeSiteKey(address: string | null | undefined): string | null {
  if (!address) return null;
  let s = address.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(UNIT_RE, ' ');
  s = s.replace(/[.,;:()\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  // Require a house number token and at least one word: "12 oak st" yes, "springfield" no.
  if (!/\d/.test(s) || s.split(' ').length < 2) return null;
  return s.slice(0, 200);
}

/* ------------------------------------------------------------------ */
/*  Call-derived facts (deterministic, conservative, English only)      */
/* ------------------------------------------------------------------ */

export interface ExtractedFact {
  category: HazardCategory;
  /** Short neutral description we show to the technician. */
  fact_text: string;
  /** The caller's own sentence the fact was read from (trimmed). */
  quote: string;
}

interface Rule {
  category: HazardCategory;
  fact_text: string;
  re: RegExp;
  /** When false (default) the rule is skipped if the match is negated ("we don't have a loose dog"). */
  allowNegation?: boolean;
}

const RULES: Rule[] = [
  { category: 'animal', fact_text: 'Caller mentioned a loose or aggressive dog at the property.',
    re: /\b(?:loose|unleashed|aggressive|vicious|biting|guard)\s+dogs?\b|\bdogs?\b[^.!?]{0,30}\b(?:bites?|bit|bitten|attack\w*|aggressive|unleashed|loose|not (?:be )?(?:locked|kept|secured|tied))\b|\bbeware of (?:the )?dogs?\b/i },
  { category: 'lighting', fact_text: 'Caller mentioned no working lighting on the stairs, entry or path.', allowNegation: true,
    re: /\b(?:no|without|broken|burnt[- ]?out|dead|dark)\s+(?:\w+\s+){0,2}(?:lights?|lighting|bulbs?)\b[^.!?]{0,40}\b(?:stairs?|stairwell|hallway|entry|porch|driveway|path|steps?)\b|\b(?:stairs?|stairwell|hallway|porch|steps?)\b[^.!?]{0,30}\b(?:is|are)\s+(?:pitch )?dark\b/i },
  { category: 'structure', fact_text: 'Caller mentioned an unsafe or damaged structure (stairs, floor, deck, roof or ceiling).',
    re: /\b(?:stairs?|steps?|porch|deck|balcony|floor|ceiling|roof|attic|ladder)\b[^.!?]{0,40}\b(?:collaps\w*|rott\w*|broken|unsafe|unstable|sagging|falling|loose|missing|soft spots?|caved)\b/i },
  { category: 'aggressive_behavior', fact_text: 'Caller used threatening language during the call.',
    re: /\b(?:i(?:'|’)?ll|i will|i(?:'|’)?m going to|i am going to|gonna|going to)\s+(?:hurt|kill|punch|hit|shoot|beat|stab)\b|\bthreaten(?:ed|ing)?\s+(?:to|you|the (?:tech|technician|driver))\b|\b(?:yell(?:ed|ing)|scream(?:ed|ing)|shout(?:ed|ing))\s+at (?:the |my )?(?:last |previous )?(?:tech\w*|plumber|electrician|worker|driver)\b/i },
  { category: 'intoxication_reported', fact_text: 'Caller said someone at the property is drunk or intoxicated.',
    re: /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are|he(?:'|’)?s|he is|she(?:'|’)?s|she is|they(?:'|’)?re|they are|he was|she was|they were|i was|we were)\s+(?:\w+\s+)?(?:drunk|intoxicated|wasted|hammered|high)\b|\b(?:been drinking|had a few drinks)\b/i },
  { category: 'electrical_hazard', fact_text: 'Caller mentioned exposed wiring, sparking or a gas smell.',
    re: /\b(?:exposed|bare|live)\s+wir(?:e|es|ing)\b|\bspark(?:s|ing|ed)\b|\bsmell(?:s|ed)?\s+(?:of\s+)?gas\b|\bgas (?:leak|smell)\b/i },
  { category: 'biological_hazard', fact_text: 'Caller mentioned mold, sewage, a pest infestation or a wasp or hornet nest.',
    re: /\b(?:black mold|mold|mould|sewage|raw sewage|asbestos|rodent infestation|bed ?bugs|roaches|wasp nest|hornets? nest|bee hive|beehive)\b/i },
  { category: 'access_hazard', fact_text: 'Caller mentioned blocked access or heavy clutter at the work area.',
    re: /\b(?:hoard\w*|blocked (?:access|stairs|hallway|exit)|(?:heavy|lots of|piles of) clutter|no (?:working )?elevator|broken elevator)\b/i },
];

const NEGATORS = /\b(?:no|not|never|n't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|without|used to|wouldn't|none|nothing)\b/i;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads the CALLER's own words (summary or caller-only transcript lines) and returns neutral,
 * source-linked facts. It never looks at audio, voice, sentiment, name, language or location.
 * One fact per category per call; all results are meant to be stored as `pending_review`.
 */
export function extractHazardsFromCall(text: string | null | undefined): ExtractedFact[] {
  if (!text) return [];
  const out = new Map<HazardCategory, ExtractedFact>();
  for (const sentence of splitSentences(text)) {
    if (sentence.length > 600) continue; // runaway sentence: not a clear statement
    for (const rule of RULES) {
      if (out.has(rule.category)) continue;
      const m = rule.re.exec(sentence);
      if (!m) continue;
      if (!rule.allowNegation) {
        const before = sentence.slice(Math.max(0, m.index - 40), m.index + (m[0].length > 12 ? 12 : 0));
        if (NEGATORS.test(before)) continue;
      }
      const quote = sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
      const fact = { category: rule.category, fact_text: rule.fact_text, quote };
      if (!lintFactText(fact.fact_text).ok) continue; // our own templates must pass the lint too
      out.set(rule.category, fact);
    }
  }
  return [...out.values()];
}

/** Keep only the caller's lines from a "Role: text" transcript. Unknown format -> returns the input. */
export function callerLinesOnly(transcript: string | null | undefined): string {
  if (!transcript) return '';
  const lines = transcript.split(/\r?\n/);
  const labelled = lines.some((l) => /^\s*(?:ai|assistant|bot|user|customer|caller|human)\s*:/i.test(l));
  if (!labelled) return transcript;
  return lines
    .filter((l) => /^\s*(?:user|customer|caller|human)\s*:/i.test(l))
    .map((l) => l.replace(/^\s*[a-z]+\s*:\s*/i, ''))
    .join('\n');
}

/* ------------------------------------------------------------------ */
/*  Risk tier                                                            */
/* ------------------------------------------------------------------ */

export interface FactLike {
  id?: string;
  category: HazardCategory;
  source: FactSource;
  review_status: ReviewStatus;
  occurred_on: string; // YYYY-MM-DD
  expires_on: string; // YYYY-MM-DD
}

const CATEGORY_POINTS: Record<HazardCategory, number> = {
  aggressive_behavior: 3,
  intoxication_reported: 2,
  animal: 1,
  structure: 1,
  lighting: 1,
  access_hazard: 1,
  electrical_hazard: 1,
  biological_hazard: 1,
  other_event: 1,
};

export function isFactActive(f: FactLike, now: Date): boolean {
  if (f.review_status === 'rejected') return false;
  const today = now.toISOString().slice(0, 10);
  return f.expires_on >= today && f.occurred_on <= today;
}

/** A fact a person stands behind: confirmed by staff, or written by a person in the first place. */
export function isHumanBacked(f: FactLike): boolean {
  return f.review_status === 'confirmed' || (HUMAN_SOURCES.has(f.source) && f.review_status !== 'disputed');
}

export interface TierResult {
  tier: RiskTier;
  score: number;
  /** True when a machine-extracted fact alone would have pushed the tier higher. */
  capped_pending_review: boolean;
  fact_ids: string[];
}

export function computeRiskTier(facts: FactLike[], now: Date = new Date()): TierResult {
  const active = facts.filter((f) => isFactActive(f, now) && f.review_status !== 'disputed');
  let score = 0;
  let humanPerson = false;
  let pendingPerson = false;
  for (const f of active) {
    const pts = CATEGORY_POINTS[f.category];
    if (PERSON_CATEGORIES.has(f.category)) {
      if (isHumanBacked(f)) { score += pts; humanPerson = true; } else { pendingPerson = true; score += 1; }
    } else {
      score += pts;
    }
  }
  let tier: RiskTier = 'standard';
  if (humanPerson && score >= 3) tier = 'high';
  else if (score >= 5) tier = 'high';
  else if (score >= 2 || pendingPerson) tier = 'elevated';
  // A machine-only person-related signal never reaches "high".
  const wouldBeHigher = pendingPerson && !humanPerson;
  return { tier, score, capped_pending_review: wouldBeHigher, fact_ids: active.map((f) => f.id).filter((x): x is string => !!x) };
}

export type PolicyRules = Partial<Record<RiskTier, Precaution[]>>;

export function resolvePrecautions(tier: RiskTier, rules?: PolicyRules | null): Precaution[] {
  const picked = rules?.[tier] ?? DEFAULT_PRECAUTIONS[tier];
  return PRECAUTIONS.filter((p) => picked.includes(p));
}

/**
 * Daytime check on an already-computed LOCAL hour (0-23). Callers get the local hour from
 * wallTimeIn() in src/lib/timezone.ts, the one place allowed to touch Intl for time zones.
 */
export function isDaytimeHour(localHour: number, startHour = 7, endHour = 19): boolean {
  return Number.isInteger(localHour) && localHour >= startHour && localHour < endHour;
}

/* ------------------------------------------------------------------ */
/*  Region profiles (defaults to review with counsel — not legal advice) */
/* ------------------------------------------------------------------ */

export type RegionProfile = 'standard' | 'strict_eu' | 'custom';

export interface RegionLimits {
  maxLocationRetentionDays: number;
  /** Manager must attest that works-council / labour review is done before location is enabled. */
  requiresLaborReviewAck: boolean;
  /** Where a manager may see a technician's location. */
  allowedLocationVisibility: Array<'on_escalation' | 'during_job'>;
  /** Technician-controlled location sharing starts OFF. */
  locationOptInDefaultOff: boolean;
}

export const REGION_LIMITS: Record<RegionProfile, RegionLimits> = {
  standard: { maxLocationRetentionDays: 90, requiresLaborReviewAck: false, allowedLocationVisibility: ['on_escalation', 'during_job'], locationOptInDefaultOff: true },
  strict_eu: { maxLocationRetentionDays: 14, requiresLaborReviewAck: true, allowedLocationVisibility: ['on_escalation'], locationOptInDefaultOff: true },
  custom: { maxLocationRetentionDays: 365, requiresLaborReviewAck: true, allowedLocationVisibility: ['on_escalation', 'during_job'], locationOptInDefaultOff: true },
};

export interface SettingsDraft {
  region_profile: RegionProfile;
  location_sharing_enabled: boolean;
  location_retention_days: number;
  location_visibility: 'on_escalation' | 'during_job';
  labor_review_ack: boolean;
  checkin_interval_minutes: number;
  checkin_grace_minutes: number;
  overrun_prompt_minutes: number;
  unreachable_minutes: number;
}

export function validateSettings(s: SettingsDraft): string[] {
  const errors: string[] = [];
  const lim = REGION_LIMITS[s.region_profile];
  if (!lim) return ['region_profile'];
  if (s.location_sharing_enabled) {
    if (lim.requiresLaborReviewAck && !s.labor_review_ack) errors.push('labor_review_required');
    if (!lim.allowedLocationVisibility.includes(s.location_visibility)) errors.push('visibility_not_allowed');
  }
  if (!Number.isInteger(s.location_retention_days) || s.location_retention_days < 1 || s.location_retention_days > lim.maxLocationRetentionDays) errors.push('retention_out_of_range');
  if (!Number.isInteger(s.checkin_interval_minutes) || s.checkin_interval_minutes < 10 || s.checkin_interval_minutes > 240) errors.push('interval_out_of_range');
  if (!Number.isInteger(s.checkin_grace_minutes) || s.checkin_grace_minutes < 1 || s.checkin_grace_minutes > 30) errors.push('grace_out_of_range');
  if (!Number.isInteger(s.overrun_prompt_minutes) || s.overrun_prompt_minutes < 5 || s.overrun_prompt_minutes > 240) errors.push('overrun_out_of_range');
  if (!Number.isInteger(s.unreachable_minutes) || s.unreachable_minutes < 5 || s.unreachable_minutes > 120) errors.push('unreachable_out_of_range');
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Escalation chain + lone-worker timer                                 */
/* ------------------------------------------------------------------ */

export interface ChainStep {
  step: EscalationStepKind;
  /** Minutes after the missed check-in (or the duress press) before this step fires. */
  delay_min: number;
}

export const DEFAULT_CHAIN: ChainStep[] = [
  { step: 'dispatcher', delay_min: 0 },
  { step: 'emergency_contact', delay_min: 5 },
  { step: 'company_next', delay_min: 10 },
];

export function validateChain(chain: unknown): chain is ChainStep[] {
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > 5) return false;
  let prev = -1;
  for (const raw of chain) {
    if (!raw || typeof raw !== 'object') return false;
    const s = raw as Partial<ChainStep>;
    if (!ESCALATION_STEPS.includes(s.step as EscalationStepKind)) return false;
    if (typeof s.delay_min !== 'number' || !Number.isInteger(s.delay_min) || s.delay_min < 0 || s.delay_min > 120) return false;
    if (s.delay_min < prev) return false; // steps must be in time order
    prev = s.delay_min;
  }
  return true;
}

export type SessionStatus = 'active' | 'escalating' | 'duress' | 'ended';

export interface SessionState {
  status: SessionStatus;
  isDrill: boolean;
  startedAt: Date;
  expectedEndAt: Date;
  /** When the next check-in is due. */
  nextCheckinDueAt: Date;
  lastSeenAt: Date | null;
  /** When the check-in was declared missed (due + grace), or when duress was pressed. Null when not escalating. */
  escalationAnchorAt: Date | null;
  /** Dedupe keys already written to safety_events for this session. */
  doneKeys: ReadonlySet<string>;
}

export interface TimerSettings {
  checkinGraceMin: number;
  overrunPromptMin: number;
  unreachableMin: number;
  chain: ChainStep[];
}

export type SessionAction =
  | { kind: 'prompt_checkin'; key: string }
  | { kind: 'missed_checkin'; key: string; anchor: Date }
  | { kind: 'overrun_prompt'; key: string }
  | { kind: 'unreachable_prompt'; key: string }
  | { kind: 'escalate'; key: string; step: EscalationStepKind; index: number; simulated: boolean };

const MIN = 60_000;

/** Compressed delays for duress: first step immediately, each later step at most 2 minutes apart. */
export function duressDelay(configuredMin: number, index: number): number {
  return Math.min(configuredMin, index * 2);
}

/**
 * Decides what must happen NOW for one session. Pure and idempotent: it only returns actions whose
 * dedupe key is not in `doneKeys`, so the cron can run every minute (or twice) without double sends.
 */
export function evaluateSession(s: SessionState, cfg: TimerSettings, now: Date): SessionAction[] {
  if (s.status === 'ended') return [];
  const t = now.getTime();
  const actions: SessionAction[] = [];
  const push = (a: SessionAction) => { if (!s.doneKeys.has(a.key)) actions.push(a); };

  const dueMs = s.nextCheckinDueAt.getTime();
  const graceEnd = dueMs + cfg.checkinGraceMin * MIN;

  if (s.status === 'active') {
    if (t >= dueMs && t < graceEnd) push({ kind: 'prompt_checkin', key: `prompt:${dueMs}` });
    if (t >= graceEnd) push({ kind: 'missed_checkin', key: `missed:${dueMs}`, anchor: new Date(graceEnd) });
    const overrunAt = s.expectedEndAt.getTime() + cfg.overrunPromptMin * MIN;
    if (t >= overrunAt) push({ kind: 'overrun_prompt', key: `overrun:${s.expectedEndAt.getTime()}` });
    if (s.lastSeenAt && t - s.lastSeenAt.getTime() >= cfg.unreachableMin * MIN) {
      push({ kind: 'unreachable_prompt', key: `unreach:${s.lastSeenAt.getTime()}` });
    }
  }

  const escalating = s.status === 'escalating' || s.status === 'duress' || (s.status === 'active' && t >= graceEnd);
  if (escalating) {
    // Delays count from the moment the check-in was declared missed (due + grace), so the
    // dispatcher always gets a head start before the emergency contact is bothered.
    const anchor = s.escalationAnchorAt ?? (s.status === 'active' ? new Date(graceEnd) : now);
    const anchorMs = anchor.getTime();
    cfg.chain.forEach((c, index) => {
      const delay = s.status === 'duress' ? duressDelay(c.delay_min, index) : c.delay_min;
      if (t >= anchorMs + delay * MIN) {
        push({
          kind: 'escalate',
          key: `esc:${anchorMs}:${index}`,
          step: c.step,
          index,
          // Drills never wake an emergency contact or the company's next step for real.
          simulated: s.isDrill && c.step !== 'dispatcher',
        });
      }
    });
  }
  return actions;
}

/** New due time after a successful check-in. */
export function nextCheckinAfter(at: Date, intervalMin: number, expectedEndAt: Date): Date {
  const next = new Date(at.getTime() + intervalMin * MIN);
  // Never schedule a check-in beyond the expected end; the end-of-job prompt covers that window.
  return next.getTime() > expectedEndAt.getTime() + intervalMin * MIN ? new Date(expectedEndAt.getTime() + intervalMin * MIN) : next;
}

/* ------------------------------------------------------------------ */
/*  SMS fallback                                                         */
/* ------------------------------------------------------------------ */

export type SmsReply =
  | { kind: 'ok' }
  | { kind: 'help' }
  | { kind: 'duress' }
  | { kind: 'unknown' };

export function normalizeReply(body: string): string {
  return (body ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Interprets an SMS reply. "OK" only counts WITH the one-time code from the prompt (so a stray or
 * spoofed text cannot fake a check-in). "HELP" always counts: a false alarm is cheap, a missed one is not.
 * `isDuressPhrase` receives the normalised text and must compare against the technician's own phrase.
 */
export function parseSmsReply(body: string, expectedCode: string | null, isDuressPhrase?: (normalized: string) => boolean): SmsReply {
  const n = normalizeReply(body);
  if (!n) return { kind: 'unknown' };
  if (/\b(help|sos|duress|panic)\b/.test(n)) return { kind: 'help' };
  const hasCode = !!expectedCode && n.split(' ').includes(expectedCode);
  if (hasCode && isDuressPhrase?.(n)) return { kind: 'duress' };
  if (hasCode && /\b(ok|okay|safe|fine|yes|done)\b/.test(n)) return { kind: 'ok' };
  return { kind: 'unknown' };
}

/** Escalation / prompt message bodies. No names of customers, no addresses beyond what the receiver needs. */
export function buildEscalationSms(opts: {
  step: EscalationStepKind;
  techName: string;
  drill: boolean;
  reason: 'missed_checkin' | 'duress';
  jobRef: string;
  companyName?: string;
}): string {
  const tag = opts.drill ? '[DRILL] ' : '';
  const why = opts.reason === 'duress' ? 'pressed the safety alert' : 'missed a safety check-in';
  const who = opts.techName.slice(0, 60);
  const base = opts.step === 'emergency_contact'
    ? `${tag}${who} ${why} while working${opts.companyName ? ` for ${opts.companyName}` : ''}. Please try to reach them.`
    : `${tag}${who} ${why} on job ${opts.jobRef}. Call them now and check the safety dashboard.`;
  return `${base} ${EMERGENCY_SERVICES_NOTICE}`.slice(0, 480);
}

/* ------------------------------------------------------------------ */
/*  Location gating                                                      */
/* ------------------------------------------------------------------ */

export type LocationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'feature_off' | 'no_active_session' | 'no_monitoring_consent' | 'no_member_opt_in' | 'tracking_gate_refused' | 'out_of_window' };

export function decideLocationCapture(i: {
  featureEnabled: boolean;
  sessionStatus: SessionStatus | null;
  monitoringConsentGranted: boolean;
  memberOptIn: boolean;
  trackingGate: 'allowed' | 'no_consent' | 'off_duty';
  recordedAt: Date;
  sessionStartedAt: Date | null;
  sessionEndedAt: Date | null;
}): LocationDecision {
  if (!i.featureEnabled) return { allowed: false, reason: 'feature_off' };
  if (!i.sessionStatus || i.sessionStatus === 'ended') return { allowed: false, reason: 'no_active_session' };
  if (!i.monitoringConsentGranted) return { allowed: false, reason: 'no_monitoring_consent' };
  if (!i.memberOptIn) return { allowed: false, reason: 'no_member_opt_in' };
  if (i.trackingGate !== 'allowed') return { allowed: false, reason: 'tracking_gate_refused' };
  if (i.sessionStartedAt && i.recordedAt < i.sessionStartedAt) return { allowed: false, reason: 'out_of_window' };
  if (i.sessionEndedAt && i.recordedAt > i.sessionEndedAt) return { allowed: false, reason: 'out_of_window' };
  return { allowed: true };
}

export function locationExpiry(recordedAt: Date, retentionDays: number): Date {
  return new Date(recordedAt.getTime() + retentionDays * 86_400_000);
}

/* ------------------------------------------------------------------ */
/*  Disparate-impact screening                                           */
/* ------------------------------------------------------------------ */

export interface AuditJob {
  /** First characters of the postal code — an AREA screening key only, never shown to technicians. */
  area: string | null;
  tier: RiskTier;
}
export interface AuditFact {
  source: FactSource;
  review_status: ReviewStatus;
}

export const AUDIT_THRESHOLDS = {
  minAreaJobs: 30,
  minAreaFlagged: 5,
  /** Area flag-rate divided by the overall flag-rate. */
  ratioReview: 1.5,
  minReviewed: 10,
  /** Share of reviewed machine facts that people rejected. */
  overturnReview: 0.3,
  /** Share of all flagged jobs held by the single biggest area, vs its share of jobs. */
  concentrationRatio: 2,
} as const;

export type AuditFindingCode =
  | 'area_rate_disparity'
  | 'area_concentration'
  | 'high_overturn_rate'
  | 'insufficient_data';

export interface AuditFinding {
  code: AuditFindingCode;
  detail: Record<string, number | string>;
}

export interface AuditReport {
  jobs: number;
  flagged_jobs: number;
  overall_flag_rate: number;
  by_area: Array<{ area: string; jobs: number; flagged: number; rate: number; ratio: number }>;
  overturn_by_source: Array<{ source: string; reviewed: number; rejected: number; rate: number }>;
  findings: AuditFinding[];
  /** Always true: this screen uses no demographic data and cannot prove absence of bias. */
  limitations_note: true;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function runFairnessAudit(jobs: AuditJob[], facts: AuditFact[]): AuditReport {
  const flaggedJobs = jobs.filter((j) => j.tier !== 'standard').length;
  const overall = jobs.length ? flaggedJobs / jobs.length : 0;
  const areas = new Map<string, { jobs: number; flagged: number }>();
  for (const j of jobs) {
    const key = j.area ?? 'unknown';
    const a = areas.get(key) ?? { jobs: 0, flagged: 0 };
    a.jobs += 1;
    if (j.tier !== 'standard') a.flagged += 1;
    areas.set(key, a);
  }
  const by_area = [...areas.entries()]
    .map(([area, a]) => {
      const rate = a.jobs ? a.flagged / a.jobs : 0;
      return { area, jobs: a.jobs, flagged: a.flagged, rate: round(rate), ratio: overall > 0 ? round(rate / overall, 2) : 0 };
    })
    .sort((x, y) => y.ratio - x.ratio);

  const bySrc = new Map<string, { reviewed: number; rejected: number }>();
  for (const f of facts) {
    if (f.review_status === 'pending_review') continue;
    const s = bySrc.get(f.source) ?? { reviewed: 0, rejected: 0 };
    s.reviewed += 1;
    if (f.review_status === 'rejected') s.rejected += 1;
    bySrc.set(f.source, s);
  }
  const overturn_by_source = [...bySrc.entries()].map(([source, s]) => ({ source, reviewed: s.reviewed, rejected: s.rejected, rate: s.reviewed ? round(s.rejected / s.reviewed) : 0 }));

  const findings: AuditFinding[] = [];
  const T = AUDIT_THRESHOLDS;
  if (jobs.length < T.minAreaJobs) findings.push({ code: 'insufficient_data', detail: { jobs: jobs.length, needed: T.minAreaJobs } });

  for (const a of by_area) {
    if (a.area === 'unknown') continue;
    if (a.jobs >= T.minAreaJobs && a.flagged >= T.minAreaFlagged && a.ratio >= T.ratioReview) {
      findings.push({ code: 'area_rate_disparity', detail: { area: a.area, jobs: a.jobs, flagged: a.flagged, ratio: a.ratio } });
    }
  }
  if (flaggedJobs >= T.minAreaFlagged) {
    for (const a of by_area) {
      if (a.area === 'unknown' || a.jobs < T.minAreaJobs) continue;
      const flagShare = a.flagged / flaggedJobs;
      const jobShare = a.jobs / jobs.length;
      if (jobShare > 0 && flagShare / jobShare >= T.concentrationRatio && a.flagged >= T.minAreaFlagged) {
        findings.push({ code: 'area_concentration', detail: { area: a.area, flag_share: round(flagShare), job_share: round(jobShare) } });
      }
    }
  }
  for (const o of overturn_by_source) {
    if (o.reviewed >= T.minReviewed && o.rate >= T.overturnReview) {
      findings.push({ code: 'high_overturn_rate', detail: { source: o.source, reviewed: o.reviewed, rate: o.rate } });
    }
  }
  return { jobs: jobs.length, flagged_jobs: flaggedJobs, overall_flag_rate: round(overall), by_area, overturn_by_source, findings, limitations_note: true };
}

/* ------------------------------------------------------------------ */
/*  Incident workflow                                                    */
/* ------------------------------------------------------------------ */

export const INCIDENT_CATEGORIES = ['threat', 'injury', 'near_miss', 'hazard'] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ['reported', 'triage', 'investigating', 'actions', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  reported: ['triage', 'closed'],
  triage: ['investigating', 'actions', 'closed'],
  investigating: ['actions', 'closed'],
  actions: ['investigating', 'closed'],
  closed: ['investigating'], // reopen
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Hours until the follow-up wellbeing check is due. Injuries and threats are checked sooner. */
export function wellbeingDueHours(category: IncidentCategory, severity: IncidentSeverity): number | null {
  if (category === 'hazard') return null;
  if (category === 'near_miss') return severity === 'high' || severity === 'critical' ? 48 : null;
  return severity === 'critical' || severity === 'high' ? 24 : 72;
}

export const ATTACHMENT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/mp4'] as const;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

export function validateAttachment(file: { type: string; size: number }, existingCount: number): string | null {
  if (existingCount >= ATTACHMENT_MAX_COUNT) return 'too_many';
  if (!(ATTACHMENT_ALLOWED_TYPES as readonly string[]).includes(file.type)) return 'type_not_allowed';
  if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) return 'too_large';
  return null;
}

/** CSV-injection-safe cell. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/*  Customer-facing safety notes                                         */
/* ------------------------------------------------------------------ */

export type LegalReview = 'not_required' | 'needs_review' | 'approved' | 'blocked';

/** A note may be shown to a customer only if it is confirmed, reviewed, unexpired and has an appeal path. */
export function canPublishToCustomer(n: { review_status: ReviewStatus; legal_review: LegalReview; expires_on: string; appeal_contact: string | null }, now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return n.review_status === 'confirmed' && n.legal_review === 'approved' && n.expires_on >= today && !!n.appeal_contact?.trim();
}
