// supabase/functions/generate-mission-brief/normalize.ts
//
// Pure, dependency-free validation/clamping of the model's JSON. Everything
// the model returns is UNTRUSTED input - clamped, enum-checked, length-capped.
// The model only ever supplies the diagnostic prediction and checklist text;
// every dollar figure, duration, warranty status and stock number is computed
// by the caller from real rows and merged in AFTER this normalization.

export type PartNecessity = "likely" | "possible" | "if_confirmed";

export interface PredictedPart {
  name: string;
  necessity: PartNecessity;
  quantity: number;
}

export interface NormalizedBrief {
  predicted_issue: string;
  confidence: number;
  reasoning: string;
  parts_likely: PredictedPart[];
  risk_flags: string[];
  before_leaving_checklist: string[];
  on_arrival_checklist: string[];
}

const NECESSITIES: PartNecessity[] = ["likely", "possible", "if_confirmed"];

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

function normalizePart(raw: Loose): PredictedPart | null {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 140);
  if (!name) return null;
  return {
    name,
    necessity: NECESSITIES.includes(raw.necessity) ? raw.necessity : "possible",
    quantity: int(raw.quantity, 1, 99, 1),
  };
}

export function normalizeBrief(parsed: Loose): NormalizedBrief | null {
  if (!parsed || typeof parsed !== "object") return null;

  const predicted_issue = str(parsed.predicted_issue, 160);
  if (!predicted_issue) return null;

  const parts_likely = (Array.isArray(parsed.parts_likely) ? parsed.parts_likely : [])
    .slice(0, 8)
    .map(normalizePart)
    .filter((p: PredictedPart | null): p is PredictedPart => p !== null);

  return {
    predicted_issue,
    confidence: num01(parsed.confidence, 0.4),
    reasoning: str(parsed.reasoning, 500),
    parts_likely,
    risk_flags: strList(parsed.risk_flags, 6, 200),
    before_leaving_checklist: strList(parsed.before_leaving_checklist, 8, 160),
    on_arrival_checklist: strList(parsed.on_arrival_checklist, 8, 160),
  };
}
