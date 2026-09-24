// supabase/functions/diagnosis-copilot/normalize.ts
//
// Pure, dependency-free validation/clamping of the model's JSON. Everything
// the model returns is UNTRUSTED input - clamped, enum-checked, length-capped.

export type Severity = "low" | "medium" | "high" | "emergency";
export type Necessity = "likely" | "possible" | "if_confirmed";

export interface ProbableCause {
  cause: string;
  likelihood: number;
  reasoning: string;
}

export interface TestStep {
  step: string;
  tool_needed: string;
  expected_result: string;
}

export interface PartNeeded {
  name: string;
  quantity: number;
  necessity: Necessity;
}

export interface NormalizedDiagnosis {
  summary: string;
  probable_causes: ProbableCause[];
  test_steps: TestStep[];
  safety_warnings: string[];
  parts_needed: PartNeeded[];
  repair_path: string[];
  severity: Severity;
  confidence: number;
  missing_info: string[];
  recommend_specialist: boolean;
  warnings: string[];
}

const SEVERITIES: Severity[] = ["low", "medium", "high", "emergency"];
const NECESSITIES: Necessity[] = ["likely", "possible", "if_confirmed"];

// deno-lint-ignore no-explicit-any
type Loose = any;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function num01(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function extractJson(text: string): Loose | null {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeCause(raw: Loose): ProbableCause | null {
  if (!raw || typeof raw !== "object") return null;
  const cause = str(raw.cause, 160);
  if (!cause) return null;
  return { cause, likelihood: num01(raw.likelihood, 0.5), reasoning: str(raw.reasoning, 300) };
}

function normalizeStep(raw: Loose): TestStep | null {
  if (!raw || typeof raw !== "object") return null;
  const step = str(raw.step, 220);
  if (!step) return null;
  return {
    step,
    tool_needed: str(raw.tool_needed, 100) || "Standard hand tools",
    expected_result: str(raw.expected_result, 220),
  };
}

function normalizePart(raw: Loose): PartNeeded | null {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 140);
  if (!name) return null;
  return {
    name,
    quantity: int(raw.quantity, 1, 99, 1),
    necessity: NECESSITIES.includes(raw.necessity) ? raw.necessity : "possible",
  };
}

export function normalizeDiagnosis(parsed: Loose): NormalizedDiagnosis | null {
  if (!parsed || typeof parsed !== "object") return null;

  const probable_causes = (Array.isArray(parsed.probable_causes) ? parsed.probable_causes : [])
    .slice(0, 6)
    .map(normalizeCause)
    .filter((c: ProbableCause | null): c is ProbableCause => c !== null)
    .sort((a: ProbableCause, b: ProbableCause) => b.likelihood - a.likelihood);

  const test_steps = (Array.isArray(parsed.test_steps) ? parsed.test_steps : [])
    .slice(0, 8)
    .map(normalizeStep)
    .filter((s: TestStep | null): s is TestStep => s !== null);

  if (probable_causes.length === 0 && test_steps.length === 0) return null;

  const parts_needed = (Array.isArray(parsed.parts_needed) ? parsed.parts_needed : [])
    .slice(0, 10)
    .map(normalizePart)
    .filter((p: PartNeeded | null): p is PartNeeded => p !== null);

  const warnings: string[] = [];
  const safety_warnings = strList(parsed.safety_flags ?? parsed.safety_warnings, 6, 220);

  let severity: Severity = SEVERITIES.includes(parsed.severity) ? parsed.severity : "low";
  // A safety warning with a "low"/"medium" severity is contradictory - never under-report.
  if (safety_warnings.length > 0 && (severity === "low" || severity === "medium")) {
    severity = "high";
  }
  if (probable_causes.length === 0) {
    warnings.push("No probable cause could be isolated from the input - add a closer photo or a measured reading.");
  }

  return {
    summary: str(parsed.summary, 500),
    probable_causes,
    test_steps,
    safety_warnings,
    parts_needed,
    repair_path: strList(parsed.repair_path, 10, 240),
    severity,
    confidence: num01(parsed.confidence, probable_causes[0]?.likelihood ?? 0),
    missing_info: strList(parsed.missing_info, 6, 200),
    recommend_specialist: Boolean(parsed.recommend_specialist) || severity === "emergency",
    warnings,
  };
}
