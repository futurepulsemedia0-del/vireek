// supabase/functions/_shared/remote-resolution/score.ts
//
// Vireek Remote Resolution Engine — deterministic core.
//
// The LLM only PROPOSES (hypotheses, next question, candidate steps). Everything that decides
// money or safety is plain code in this file: the safety hold, the final probability, the
// dispatch decision and the filtering of troubleshooting steps. No I/O, no Deno or DOM APIs,
// so it runs unchanged in edge functions and in unit tests.

export type SafetyReason =
  | "gas"
  | "carbon_monoxide"
  | "electrical_hazard"
  | "fire_smoke"
  | "flooding"
  | "sewage"
  | "structural"
  | "vulnerable_extreme_temp";

export type Band = "high" | "medium" | "low";
export type DispatchReason =
  | "safety"
  | "low_probability"
  | "steps_exhausted"
  | "no_safe_steps"
  | "insufficient_evidence"
  | "customer_request"
  | "customer_not_fixed"
  | "staff_override";

export const MAX_TURNS = 12;
export const MAX_STEPS = 6;
export const MAX_HYPOTHESES = 6;

// ---------------------------------------------------------------------------
// 1. SAFETY (deterministic, never overridden by the model)
// ---------------------------------------------------------------------------

const SAFETY_RULES: { reason: SafetyReason; re: RegExp }[] = [
  { reason: "gas", re: /\b(smell(s|ed)? (of )?(natural )?gas|gas (smell|leak|odou?r)|rotten egg|propane leak|huele a gas|fuga de gas)\b|بوی گاز|نشت گاز/gi },
  { reason: "carbon_monoxide", re: /\b(carbon monoxide|co (alarm|detector)|monoxide (alarm|detector)|monóxido)\b|مونوکسید/gi },
  { reason: "electrical_hazard", re: /\b(spark(s|ing|ed)?|arcing|electric(al)? shock|got shocked|shocked me|exposed (live )?wir(e|es|ing)|burning (smell|plastic|wire)|smell(s)? (like )?burning|melted (outlet|plug|wire|breaker)|hot (outlet|breaker|panel|plug)|buzzing (panel|breaker)|chispas)\b|جرقه/gi },
  { reason: "fire_smoke", re: /\b(on fire|caught fire|flames?|smoking|smoke (is )?coming|visible smoke|fuego|humo)\b|دود|آتش/gi },
  { reason: "flooding", re: /\b(flood(ed|ing)?|water (is )?(pouring|gushing|spraying)|burst pipe|pipe burst|ceiling (is )?(dripping|collapsing|leaking badly)|inundaci[oó]n)\b|سیل|ترکیدگی لوله/gi },
  { reason: "sewage", re: /\b(sewage|sewer (backup|smell)|raw sewage|toilet (is )?overflowing|aguas negras)\b|فاضلاب/gi },
  { reason: "structural", re: /\b(ceiling (is )?(sagging|bulging)|structural damage|foundation crack|roof (is )?collaps)\b/gi },
  { reason: "vulnerable_extreme_temp", re: /\b((infant|baby|newborn|elderly|oxygen|dialysis|medical equipment|insulin)\b.{0,80}\b(no (heat|cooling|ac|a\/c|power)|too (hot|cold))|(no (heat|cooling|ac|a\/c)|too (hot|cold))\b.{0,80}\b(infant|baby|newborn|elderly|oxygen|dialysis|medical equipment|insulin))\b/gi },
];

const NEGATION_RE = /\b(no|not|don'?t|doesn'?t|didn'?t|without|never|nothing|nope|sin|ningún)\W*$/i;

export interface SafetyResult {
  hold: boolean;
  reasons: SafetyReason[];
}

/** True if the match at `index` is directly negated ("no gas smell"). */
function isNegated(text: string, index: number): boolean {
  return NEGATION_RE.test(text.slice(Math.max(0, index - 16), index));
}

export function screenSafety(texts: ReadonlyArray<string | null | undefined>): SafetyResult {
  const found = new Set<SafetyReason>();
  for (const raw of texts) {
    if (typeof raw !== "string" || !raw) continue;
    const text = raw.slice(0, 4000);
    for (const rule of SAFETY_RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text)) !== null) {
        if (!isNegated(text, m.index)) {
          found.add(rule.reason);
          break;
        }
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
  }
  const reasons = [...found];
  return { hold: reasons.length > 0, reasons };
}

const SAFETY_GUIDANCE: Record<SafetyReason, string> = {
  gas: "If you smell gas: do not use switches, flames or phones inside. Leave the building and call your gas utility or 911 from outside.",
  carbon_monoxide: "If a carbon monoxide alarm is sounding or anyone feels dizzy or sick: get everyone outside into fresh air and call 911.",
  electrical_hazard: "Do not touch the equipment. If it is safe to do so, switch off the power at the main breaker. If you see fire or feel unwell, call 911.",
  fire_smoke: "If there is fire or smoke: leave the building and call 911 immediately.",
  flooding: "If water is actively flooding: shut off the main water valve if you can reach it safely, and keep clear of anything electrical that is wet.",
  sewage: "Avoid contact with the water, keep children and pets away, and do not run more water down the drains.",
  structural: "Stay out of the affected area until it has been inspected.",
  vulnerable_extreme_temp: "Someone in your home may be at risk from the temperature. Move them to a safe, comfortable place if you can, and call 911 if they feel unwell.",
};

export function safetyGuidance(reasons: ReadonlyArray<SafetyReason>): string[] {
  return reasons.map((r) => SAFETY_GUIDANCE[r]).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 2. PROBABILITY
// ---------------------------------------------------------------------------

export interface Hypothesis {
  cause: string;
  likelihood: number; // 0..1, normalised by the scorer
  remote_fixable: boolean;
  needs_parts: boolean;
  evidence_for: string[];
  evidence_against: string[];
}

export interface EvidenceCounts {
  answers: number;
  photos: number;
  audio: number;
  sensors: number;
  history: number;
}

export interface CategoryRate {
  rate: number; // 0..1 observed remote-resolution rate for this account + category
  n: number; // number of attempted cases behind it
}

export interface ScoreInput {
  category: string;
  hypotheses: Hypothesis[];
  counts: EvidenceCounts;
  conflicts: number;
  failedSteps: number;
  previousProbability: number | null; // 0..100, last stored value
  accountRate?: CategoryRate | null;
  safetyHold: boolean;
}

export interface Factor {
  label: string;
  effect: "up" | "down" | "neutral";
  detail: string;
}

export interface ScoreResult {
  probability: number; // 0..100 integer
  band: Band;
  completeness: number; // 0..1
  factors: Factor[];
}

/**
 * STARTING priors only: conservative guesses for how often a first call in each category ends up
 * fixable without a visit. They are NOT industry statistics. As soon as an account has attempted
 * cases, its own observed rate takes over via Bayesian shrinkage (see `blendedPrior`).
 */
export const DEFAULT_PRIORS: Record<string, number> = {
  hvac_cooling: 0.28,
  hvac_heating: 0.22,
  plumbing_clog: 0.3,
  plumbing_leak: 0.08,
  water_heater: 0.18,
  electrical_power: 0.2,
  appliance: 0.3,
  other: 0.12,
  unknown: 0.12,
};
export const CATEGORIES = Object.keys(DEFAULT_PRIORS);
const PRIOR_STRENGTH = 10; // pseudo-observations behind the default prior

export function blendedPrior(category: string, account?: CategoryRate | null): number {
  const base = DEFAULT_PRIORS[category] ?? DEFAULT_PRIORS.unknown;
  if (!account || !Number.isFinite(account.rate) || account.n <= 0) return base;
  const n = Math.min(account.n, 500);
  return (n * clamp01(account.rate) + PRIOR_STRENGTH * base) / (n + PRIOR_STRENGTH);
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function evidenceCompleteness(c: EvidenceCounts): number {
  const score =
    Math.min(c.answers, 6) / 6 * 0.45 +
    (c.photos > 0 ? 0.2 : 0) +
    (c.audio > 0 ? 0.1 : 0) +
    (c.sensors > 0 ? 0.15 : 0) +
    (c.history > 0 ? 0.1 : 0);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function bandOf(probability: number): Band {
  return probability >= 75 ? "high" : probability >= 45 ? "medium" : "low";
}

export function scoreCase(input: ScoreInput): ScoreResult {
  const completeness = evidenceCompleteness(input.counts);
  const factors: Factor[] = [];

  if (input.safetyHold) {
    return {
      probability: 0,
      band: "low",
      completeness,
      factors: [{ label: "Safety hold", effect: "down", detail: "A safety risk was detected, so a technician is required." }],
    };
  }

  const hyps = input.hypotheses.slice(0, MAX_HYPOTHESES);
  const total = hyps.reduce((s, h) => s + clamp01(h.likelihood), 0);
  const weights = hyps.map((h) => (total > 0 ? clamp01(h.likelihood) / total : 1 / Math.max(hyps.length, 1)));

  // Probability mass of causes that can be fixed by the customer, with no parts needed.
  let raw = 0;
  hyps.forEach((h, i) => {
    if (h.remote_fixable && !h.needs_parts) raw += weights[i];
  });
  if (hyps.length === 0) raw = 0;

  const prior = blendedPrior(input.category, input.accountRate);
  const w = 0.35 + 0.55 * completeness; // more evidence -> trust the case-specific reading more
  let p = w * raw + (1 - w) * prior;

  factors.push({
    label: "Starting point for this problem type",
    effect: "neutral",
    detail: `${Math.round(prior * 100)}% of similar calls end without a visit${input.accountRate && input.accountRate.n > 0 ? ` (based on ${input.accountRate.n} of your own cases)` : " (starting estimate)"}.`,
  });

  const top = [...hyps].sort((a, b) => b.likelihood - a.likelihood)[0];
  if (top) {
    factors.push({
      label: "Most likely cause",
      effect: top.remote_fixable && !top.needs_parts ? "up" : "down",
      detail: `${top.cause} — ${top.remote_fixable && !top.needs_parts ? "can usually be fixed by the customer" : "needs a technician or parts"}.`,
    });
  }

  factors.push({
    label: "Evidence collected",
    effect: completeness >= 0.6 ? "up" : "neutral",
    detail: `${Math.round(completeness * 100)}% complete (${input.counts.answers} answers, ${input.counts.photos} photo, ${input.counts.audio} audio, ${input.counts.sensors} sensor, ${input.counts.history} history).`,
  });

  if (input.conflicts > 0) {
    const pen = Math.min(0.12, input.conflicts * 0.04);
    p -= pen;
    factors.push({ label: "Conflicting signals", effect: "down", detail: `${input.conflicts} signal(s) point in different directions.` });
  }

  if (input.failedSteps > 0) {
    p *= Math.pow(0.8, input.failedSteps);
    factors.push({ label: "Steps already tried", effect: "down", detail: `${input.failedSteps} step(s) did not change anything.` });
    if (input.previousProbability != null) p = Math.min(p, input.previousProbability / 100);
  }

  const probability = Math.round(Math.min(0.95, Math.max(0.01, p)) * 100);
  return { probability, band: bandOf(probability), completeness, factors };
}

// ---------------------------------------------------------------------------
// 3. DECISION
// ---------------------------------------------------------------------------

export type Decision =
  | { action: "ask" }
  | { action: "troubleshoot" }
  | { action: "dispatch"; reason: DispatchReason };

export interface DecideInput {
  probability: number;
  threshold: number; // account setting, 20..95
  completeness: number;
  turns: number; // turns already used, including this one
  hasNextQuestion: boolean;
  hasSteps: boolean;
  failedSteps: number;
  remainingSteps: number;
  safetyHold: boolean;
}

export function decide(i: DecideInput): Decision {
  if (i.safetyHold) return { action: "dispatch", reason: "safety" };
  if (i.failedSteps > 0 && i.remainingSteps === 0) return { action: "dispatch", reason: "steps_exhausted" };
  if (i.turns >= MAX_TURNS) return { action: "dispatch", reason: "insufficient_evidence" };

  if (i.probability >= i.threshold) {
    if (i.hasSteps) return { action: "troubleshoot" };
    if (i.hasNextQuestion) return { action: "ask" };
    return { action: "dispatch", reason: "no_safe_steps" };
  }

  // Gray zone: more evidence could still move the number over the line.
  const grayZone = i.probability >= Math.floor(i.threshold * 0.6);
  if (grayZone && i.completeness < 0.55 && i.hasNextQuestion && i.failedSteps === 0) return { action: "ask" };
  return { action: "dispatch", reason: "low_probability" };
}

// ---------------------------------------------------------------------------
// 4. SANITISERS (model output -> shapes the database accepts)
// ---------------------------------------------------------------------------

export function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

export function normalizeHypotheses(v: unknown): Hypothesis[] {
  if (!Array.isArray(v)) return [];
  const out: Hypothesis[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const cause = str(o.cause, 160);
    if (!cause) continue;
    const n = typeof o.likelihood === "number" ? o.likelihood : Number(o.likelihood);
    out.push({
      cause,
      likelihood: clamp01(n),
      remote_fixable: o.remote_fixable === true,
      needs_parts: o.needs_parts === true,
      evidence_for: strList(o.evidence_for, 4, 160),
      evidence_against: strList(o.evidence_against, 4, 160),
    });
    if (out.length >= MAX_HYPOTHESES) break;
  }
  return out;
}

export interface Question {
  id: string;
  text: string;
  type: "choice" | "yes_no" | "text" | "number";
  options: string[];
  why: string;
}

export function normalizeQuestion(v: unknown, usedIds: ReadonlySet<string>): Question | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = str(o.text, 300);
  if (text.length < 5) return null;
  let type: Question["type"] = ["choice", "yes_no", "text", "number"].includes(o.type as string)
    ? (o.type as Question["type"])
    : "text";
  const options = strList(o.options, 6, 80);
  if (type === "choice" && options.length < 2) type = "text";
  let id = str(o.id, 30).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id || usedIds.has(id)) id = `q${usedIds.size + 1}`;
  return { id, text, type, options: type === "choice" ? options : [], why: str(o.why, 200) };
}

export interface Step {
  id: string;
  title: string;
  instructions: string;
  expected: string;
  safety_note: string;
  minutes: number;
  result: null | "no_change" | "fixed" | "cannot_do";
}

/** Anything that needs tools, panels, gas, refrigerant, heights or live electrical work is never offered to a customer. */
const UNSAFE_STEP_RE = new RegExp(
  [
    "gas (valve|line|pipe|connection|supply)",
    "pilot( light)?",
    "refrigerant",
    "freon",
    "capacitor",
    "contactor",
    "compressor",
    "(breaker|electrical|service) panel",
    "fuse box",
    "bypass",
    "jumper",
    "live wire",
    "exposed wir",
    "wiring",
    "wire nut",
    "multimeter",
    "voltage",
    "(open|remove|take off|unscrew|pry) (the )?(panel|cover|cabinet|access|control board|housing|casing)",
    "screwdriver|wrench|pliers|drill",
    "ladder|climb|roof|attic|crawl ?space",
    "solder|torch|blowtorch",
    "heating element|ignit|igniter|burner|flue|vent pipe",
    "pressure relief|t&p valve",
    "drain the (water )?(heater|tank)",
    "disassembl",
    "chemical drain|drain cleaner|muriatic|bleach and",
  ].join("|"),
  "i",
);

export function isStepSafe(text: string): boolean {
  return !UNSAFE_STEP_RE.test(text);
}

export function normalizeSteps(v: unknown): Step[] {
  if (!Array.isArray(v)) return [];
  const out: Step[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.safe_for_homeowner !== true) continue;
    const title = str(o.title, 120);
    const instructions = str(o.instructions, 600);
    if (title.length < 3 || instructions.length < 10) continue;
    if (!isStepSafe(`${title} ${instructions}`)) continue;
    const minutes = Math.min(30, Math.max(1, Math.round(Number(o.minutes) || 5)));
    out.push({
      id: `s${out.length + 1}`,
      title,
      instructions,
      expected: str(o.expected, 240),
      safety_note: str(o.safety_note, 240),
      minutes,
      result: null,
    });
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

export function normalizeCategory(v: unknown): string {
  const c = str(v, 40).toLowerCase();
  return CATEGORIES.includes(c) ? c : "unknown";
}

/** Keeps customer results on steps that already exist; unknown ids are ignored. */
export function mergeStepResults(existing: Step[], incoming: Step[]): Step[] {
  const done = new Map(existing.filter((s) => s.result).map((s) => [s.id, s]));
  const merged = incoming.map((s) => done.get(s.id) ?? s);
  // Steps the customer already performed are never silently replaced or removed.
  for (const d of done.values()) if (!merged.some((m) => m.id === d.id)) merged.push(d);
  return merged.slice(0, MAX_STEPS + done.size);
}

// ---------------------------------------------------------------------------
// 5. DEVICE READINGS (sanity ranges so a broken sensor can't poison the case)
// ---------------------------------------------------------------------------

export const METRIC_RANGES: Record<string, [number, number]> = {
  supply_air_temp_f: [-20, 200],
  return_air_temp_f: [-20, 200],
  delta_t_f: [-60, 80],
  indoor_temp_f: [-20, 140],
  outdoor_temp_f: [-60, 150],
  setpoint_f: [40, 100],
  humidity_pct: [0, 100],
  compressor_amps: [0, 200],
  fan_amps: [0, 100],
  water_pressure_psi: [0, 250],
  water_flow_gpm: [0, 200],
  water_temp_f: [30, 220],
  power_voltage: [0, 500],
  leak_detected: [0, 1],
  filter_clogged: [0, 1],
  door_open: [0, 1],
};

export function validReading(metric: string, value: number): boolean {
  const r = METRIC_RANGES[metric];
  return !!r && Number.isFinite(value) && value >= r[0] && value <= r[1];
}
