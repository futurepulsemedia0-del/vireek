// supabase/functions/technician-simulator/normalize.ts
//
// Pure, dependency-free validation of the AI-generated scenario. Everything the
// model returns is UNTRUSTED: strings are length-capped, ids are re-issued by
// the server (after shuffling, so list position and id order can never leak the
// answer), and structural invariants are enforced before a scenario is ever
// stored or shown to a technician.

export const TRADES = ["hvac", "plumbing", "electrical", "appliance"] as const;
export const DIFFICULTIES = ["foundation", "professional", "master"] as const;
export const DECISIONS = ["repair_now", "quote_and_schedule", "escalate_specialist"] as const;

export type Trade = (typeof TRADES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Decision = (typeof DECISIONS)[number];

export interface TruthCause { id: string; label: string; is_root: boolean; near_miss: boolean }
export interface TruthMeasurement {
  id: string; label: string; tool: string; location: string; reading: string;
  supports_cause_ids: string[]; rules_out_cause_ids: string[];
  decisive: boolean; intrusive: boolean; minutes: number;
}
export interface TruthFact { id: string; topic: string; answer: string; critical: boolean }
export interface TruthSafety { id: string; label: string; required: boolean }
export interface TruthPart { id: string; label: string; correct: boolean }

export interface Truth {
  causes: TruthCause[];
  measurements: TruthMeasurement[];
  facts: TruthFact[];
  safety_checks: TruthSafety[];
  parts: TruthPart[];
  correct_decision: Decision;
  decision_rationale: string;
  par_minutes: number;
}

/** Everything the technician is allowed to see. Contains no verdicts, readings or flags. */
export interface Brief {
  title: string;
  trade: Trade;
  difficulty: Difficulty;
  equipment: { type: string; make: string; model: string; age_years: number | null };
  customer_complaint: string;
  environment: string;
  candidate_causes: { id: string; label: string }[];
  measurement_options: { id: string; label: string; tool: string; location: string; minutes: number; intrusive: boolean }[];
  question_topics: { id: string; topic: string }[];
  safety_checks: { id: string; label: string }[];
  parts_catalog: { id: string; label: string }[];
  time_limit_minutes: number;
}

export const TIME_LIMIT_MINUTES = 60;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strList = (v: unknown, max: number, itemMax: number): string[] =>
  arr(v).map((x) => str(x, itemMax)).filter(Boolean).slice(0, max);

export function shuffle<T>(input: readonly T[], rnd: () => number = Math.random): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type NormalizeResult =
  | { ok: true; brief: Brief; truth: Truth }
  | { ok: false; errors: string[] };

export function normalizeScenario(
  raw: unknown,
  ctx: { trade: Trade; difficulty: Difficulty },
  rnd: () => number = Math.random,
): NormalizeResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["Response was not a JSON object."] };

  const title = str(raw.title, 120);
  const complaint = str(raw.customer_complaint, 600);
  const environment = str(raw.environment, 300);
  if (!title) errors.push("title missing");
  if (!complaint) errors.push("customer_complaint missing");

  const eq = isObj(raw.equipment) ? raw.equipment : {};
  const equipment = {
    type: str(eq.type, 60) || "Equipment",
    make: str(eq.make, 60) || "Unknown",
    model: str(eq.model, 60) || "Unknown",
    age_years: typeof eq.age_years === "number" && eq.age_years >= 0 ? clamp(Math.round(eq.age_years), 0, 60) : null,
  };

  // ---- causes -------------------------------------------------------------
  const rawCauses = shuffle(arr(raw.causes).filter(isObj), rnd);
  const causeIdMap = new Map<string, string>();
  const causes: TruthCause[] = [];
  for (const c of rawCauses.slice(0, 7)) {
    const label = str(c.label, 140);
    const rawId = str(c.id, 60);
    if (!label || !rawId || causeIdMap.has(rawId)) continue;
    const id = `c${causes.length + 1}`;
    causeIdMap.set(rawId, id);
    causes.push({ id, label, is_root: bool(c.is_root), near_miss: bool(c.near_miss) });
  }
  const rootCount = causes.filter((c) => c.is_root).length;
  if (causes.length < 3) errors.push("need at least 3 candidate causes");
  if (rootCount !== 1) errors.push(`exactly one root cause required (got ${rootCount})`);
  for (const c of causes) if (c.is_root) c.near_miss = false;
  const rootId = causes.find((c) => c.is_root)?.id;

  const mapCauseIds = (v: unknown): string[] =>
    [...new Set(arr(v).map((x) => causeIdMap.get(str(x, 60))).filter((x): x is string => !!x))];

  // ---- measurements ---------------------------------------------------------
  const rawMeas = shuffle(arr(raw.measurements).filter(isObj), rnd);
  const measurements: TruthMeasurement[] = [];
  const seenMeasLabels = new Set<string>();
  for (const m of rawMeas.slice(0, 16)) {
    const label = str(m.label, 120);
    const reading = str(m.reading, 200);
    if (!label || !reading || seenMeasLabels.has(label.toLowerCase())) continue;
    seenMeasLabels.add(label.toLowerCase());
    measurements.push({
      id: `m${measurements.length + 1}`,
      label,
      tool: str(m.tool, 60) || "Meter",
      location: str(m.location, 100) || "At unit",
      reading,
      supports_cause_ids: mapCauseIds(m.supports_cause_ids),
      rules_out_cause_ids: mapCauseIds(m.rules_out_cause_ids),
      decisive: bool(m.decisive),
      intrusive: bool(m.intrusive),
      minutes: Math.round(clamp(num(m.minutes, 5), 1, 45)),
    });
  }
  if (measurements.length < 8) errors.push("need at least 8 measurements");
  for (const m of measurements) {
    if (m.decisive && rootId && (!m.supports_cause_ids.includes(rootId) || m.rules_out_cause_ids.includes(rootId))) {
      m.decisive = false; // a "decisive" test must actually point at the root cause
    }
  }
  if (!measurements.some((m) => m.decisive)) errors.push("no decisive measurement supports the root cause");

  // ---- customer facts -------------------------------------------------------
  const facts: TruthFact[] = [];
  for (const f of shuffle(arr(raw.customer_facts).filter(isObj), rnd).slice(0, 8)) {
    const topic = str(f.topic, 80);
    const answer = str(f.answer, 400);
    if (!topic || !answer) continue;
    facts.push({ id: `f${facts.length + 1}`, topic, answer, critical: bool(f.critical) });
  }
  if (facts.length < 4) errors.push("need at least 4 customer facts");
  if (!facts.some((f) => f.critical)) errors.push("need at least 1 critical customer fact");

  // ---- safety ---------------------------------------------------------------
  const safety_checks: TruthSafety[] = [];
  for (const s of shuffle(arr(raw.safety_checks).filter(isObj), rnd).slice(0, 6)) {
    const label = str(s.label, 140);
    if (!label) continue;
    safety_checks.push({ id: `s${safety_checks.length + 1}`, label, required: bool(s.required) });
  }
  if (safety_checks.length < 2) errors.push("need at least 2 safety checks");
  if (!safety_checks.some((s) => s.required)) errors.push("need at least 1 required safety check");

  // ---- decision & parts -----------------------------------------------------
  const decision = str(raw.correct_decision, 40) as Decision;
  if (!DECISIONS.includes(decision)) errors.push("invalid correct_decision");

  const parts: TruthPart[] = [];
  for (const p of shuffle(arr(raw.parts).filter(isObj), rnd).slice(0, 10)) {
    const label = str(p.label, 120);
    if (!label) continue;
    parts.push({ id: `p${parts.length + 1}`, label, correct: bool(p.correct) });
  }
  if (parts.length < 4) errors.push("need at least 4 parts in the catalog");
  if (decision !== "escalate_specialist" && !parts.some((p) => p.correct)) errors.push("need at least 1 correct part");

  if (errors.length > 0) return { ok: false, errors };

  const truth: Truth = {
    causes,
    measurements,
    facts,
    safety_checks,
    parts,
    correct_decision: decision,
    decision_rationale: str(raw.decision_rationale, 500),
    par_minutes: Math.round(clamp(num(raw.par_minutes, 30), 10, 90)),
  };

  const brief: Brief = {
    title,
    trade: ctx.trade,
    difficulty: ctx.difficulty,
    equipment,
    customer_complaint: complaint,
    environment,
    candidate_causes: causes.map((c) => ({ id: c.id, label: c.label })),
    measurement_options: measurements.map((m) => ({
      id: m.id, label: m.label, tool: m.tool, location: m.location, minutes: m.minutes, intrusive: m.intrusive,
    })),
    question_topics: facts.map((f) => ({ id: f.id, topic: f.topic })),
    safety_checks: safety_checks.map((s) => ({ id: s.id, label: s.label })),
    parts_catalog: parts.map((p) => ({ id: p.id, label: p.label })),
    time_limit_minutes: TIME_LIMIT_MINUTES,
  };

  return { ok: true, brief, truth };
}
