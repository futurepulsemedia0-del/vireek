// supabase/functions/live-copilot/normalize.ts
//
// Pure, dependency-free validation for the Live Multimodal Technician Copilot.
// Everything the model returns is UNTRUSTED input: clamped, enum-checked and
// length-capped here. Also holds the deterministic SAFETY FLOOR - a keyword
// layer that can only ever RAISE severity, never lower it, so a model
// hallucination can't downplay a gas / CO / fire / live-wire hazard.
//
// Keep the exported types in sync with src/lib/liveCopilot.ts.

export type Severity = "low" | "medium" | "high" | "emergency";
export type Necessity = "likely" | "possible" | "if_confirmed";
export type SoundClass =
  | "none_detected" | "normal" | "grinding" | "squealing" | "rattling"
  | "buzzing_humming" | "clicking" | "hissing" | "banging" | "gurgling" | "unclear";

export const SEVERITIES: Severity[] = ["low", "medium", "high", "emergency"];
export const SOUND_CLASSES: SoundClass[] = [
  "none_detected", "normal", "grinding", "squealing", "rattling",
  "buzzing_humming", "clicking", "hissing", "banging", "gurgling", "unclear",
];
const NECESSITIES: Necessity[] = ["likely", "possible", "if_confirmed"];

// deno-lint-ignore no-explicit-any
type Loose = any;

export interface Nameplate {
  legible: boolean;
  brand: string;
  model: string;
  serial: string;
  manufacture_date: string;
  ratings: string;
  refrigerant: string;
}

export interface Perception {
  transcript: string;
  nameplate: Nameplate;
  sound: { class: SoundClass; description: string; anomalies: string[] };
  visual_findings: string[];
  error_codes: string[];
  capture_quality: { issues: string[]; retake_hint: string };
}

export interface LiveCause { cause: string; likelihood: number; reasoning: string; evidence: string[] }
export interface LiveStep { step: string; tool_needed: string; expected_result: string }
export interface LivePart { name: string; quantity: number; necessity: Necessity }
export interface ManualRef { id: string; title: string; why: string }

export interface LiveResult {
  headline: string;
  spoken_answer: string;
  probable_causes: LiveCause[];
  test_steps: LiveStep[];
  safety_warnings: string[];
  parts_needed: LivePart[];
  history_insights: string[];
  manual_refs: ManualRef[];
  next_capture: string;
  missing_info: string[];
  severity: Severity;
  confidence: number;
  escalate: { recommended: boolean; reason: string };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
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
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
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

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Pass A - perception
// ---------------------------------------------------------------------------

export function normalizePerception(parsed: Loose): Perception {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  const np = p.nameplate && typeof p.nameplate === "object" ? p.nameplate : {};
  const legible = np.legible === true;
  const sound = p.sound && typeof p.sound === "object" ? p.sound : {};
  const cq = p.capture_quality && typeof p.capture_quality === "object" ? p.capture_quality : {};

  return {
    transcript: str(p.transcript, 1200),
    // A nameplate the model itself calls illegible is never trusted for identifiers.
    nameplate: {
      legible,
      brand: legible ? str(np.brand, 60) : "",
      model: legible ? str(np.model, 80) : "",
      serial: legible ? str(np.serial, 80) : "",
      manufacture_date: legible ? str(np.manufacture_date, 40) : "",
      ratings: legible ? str(np.ratings, 200) : "",
      refrigerant: legible ? str(np.refrigerant, 60) : "",
    },
    sound: {
      class: SOUND_CLASSES.includes(sound.class) ? sound.class : "unclear",
      description: str(sound.description, 300),
      anomalies: strList(sound.anomalies, 5, 160),
    },
    visual_findings: strList(p.visual_findings, 8, 200),
    error_codes: strList(p.error_codes, 5, 40),
    capture_quality: {
      issues: strList(cq.issues, 4, 120),
      retake_hint: str(cq.retake_hint, 200),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic safety floor
// ---------------------------------------------------------------------------

interface Hazard { id: string; re: RegExp; level: Severity; warning: string }

const HAZARDS: Hazard[] = [
  {
    id: "gas",
    re: /\b(smell(s|ed|ing)?\s+(of\s+)?(natural\s+)?gas|gas\s+(smell|odor|leak)|rotten\s+egg|sulfur\s+smell|olor\s+a\s+gas)\b/i,
    level: "emergency",
    warning: "STOP WORK: possible gas leak. No ignition sources, no switches. Ventilate, evacuate occupants and call the gas utility / 911 from outside.",
  },
  {
    id: "co",
    re: /\b(carbon\s+monoxide|co\s+(alarm|detector|reading|level)|monoxido)\b/i,
    level: "emergency",
    warning: "STOP WORK: possible carbon monoxide hazard. Evacuate occupants, ventilate and verify with a calibrated CO meter before continuing.",
  },
  {
    id: "fire",
    re: /\b(smoke(?!\s+(detector|alarm))|smoking|on\s+fire|flames?|burning\s+(smell|odor)|burnt\s+(smell|odor)|melted\s+(wire|wiring|insulation|connector))\b/i,
    level: "emergency",
    warning: "STOP WORK: smoke / burning / melted insulation. De-energize at the breaker if safe to reach it, keep clear and call 911 if there is fire.",
  },
  {
    id: "live",
    re: /\b(sparking|arcing|sparks?|exposed\s+(live\s+)?(wire|wiring|conductor)|live\s+wire|shock(ed)?)\b/i,
    level: "emergency",
    warning: "STOP WORK: arcing / exposed live conductors. De-energize and lock out / tag out before touching anything.",
  },
  {
    id: "water",
    re: /\b(flood(ed|ing)?|standing\s+water|water\s+(near|on|in)\s+(the\s+)?(panel|breaker|electrical|wiring))\b/i,
    level: "high",
    warning: "Water near electrical components: de-energize first, do not stand in water while working on live equipment.",
  },
  {
    id: "refrigerant",
    re: /\b(refrigerant\s+leak|freon\s+leak|hissing\s+(refrigerant|line))\b/i,
    level: "high",
    warning: "Suspected refrigerant leak: ventilate the area, keep ignition sources away and follow EPA 608 handling rules.",
  },
];

export interface SafetyHit { id: string; level: Severity; warning: string }

/** Scans free text (question + transcript + visual findings) for hard-stop hazards. */
export function detectHazards(...texts: string[]): SafetyHit[] {
  const haystack = texts.filter(Boolean).join(" \n ");
  if (!haystack.trim()) return [];
  return HAZARDS.filter((h) => h.re.test(haystack)).map(({ id, level, warning }) => ({ id, level, warning }));
}

// ---------------------------------------------------------------------------
// Pass B - reasoning result
// ---------------------------------------------------------------------------

export interface ManualCandidate { id: string; title: string }

export function normalizeLiveResult(
  parsed: Loose,
  opts: { manuals: ManualCandidate[]; hazards: SafetyHit[]; turnNumber: number },
): LiveResult | null {
  if (!parsed || typeof parsed !== "object") return null;

  const probable_causes: LiveCause[] = (Array.isArray(parsed.probable_causes) ? parsed.probable_causes : [])
    .slice(0, 5)
    .map((raw: Loose): LiveCause | null => {
      if (!raw || typeof raw !== "object") return null;
      const cause = str(raw.cause, 160);
      if (!cause) return null;
      return {
        cause,
        likelihood: num01(raw.likelihood, 0.5),
        reasoning: str(raw.reasoning, 300),
        evidence: strList(raw.evidence, 4, 140),
      };
    })
    .filter((c: LiveCause | null): c is LiveCause => c !== null)
    .sort((a: LiveCause, b: LiveCause) => b.likelihood - a.likelihood);

  const test_steps: LiveStep[] = (Array.isArray(parsed.test_steps) ? parsed.test_steps : [])
    .slice(0, 8)
    .map((raw: Loose): LiveStep | null => {
      if (!raw || typeof raw !== "object") return null;
      const step = str(raw.step, 220);
      if (!step) return null;
      return {
        step,
        tool_needed: str(raw.tool_needed, 100) || "Standard hand tools",
        expected_result: str(raw.expected_result, 220),
      };
    })
    .filter((s: LiveStep | null): s is LiveStep => s !== null);

  const headline = str(parsed.headline, 200);
  if (!headline && probable_causes.length === 0 && test_steps.length === 0) return null;

  const parts_needed: LivePart[] = (Array.isArray(parsed.parts_needed) ? parsed.parts_needed : [])
    .slice(0, 8)
    .map((raw: Loose): LivePart | null => {
      if (!raw || typeof raw !== "object") return null;
      const name = str(raw.name, 140);
      if (!name) return null;
      return {
        name,
        quantity: int(raw.quantity, 1, 99, 1),
        necessity: NECESSITIES.includes(raw.necessity) ? raw.necessity : "possible",
      };
    })
    .filter((p: LivePart | null): p is LivePart => p !== null);

  // The model cites manuals by their 1-based index in the prompt; anything out
  // of range is dropped, so a citation can never point at a made-up document.
  const seenRefs = new Set<string>();
  const manual_refs: ManualRef[] = (Array.isArray(parsed.manual_refs) ? parsed.manual_refs : [])
    .map((raw: Loose): ManualRef | null => {
      const idx = Number(raw?.ref);
      if (!Number.isInteger(idx) || idx < 1 || idx > opts.manuals.length) return null;
      const m = opts.manuals[idx - 1];
      if (seenRefs.has(m.id)) return null;
      seenRefs.add(m.id);
      return { id: m.id, title: m.title, why: str(raw?.why, 200) };
    })
    .filter((r: ManualRef | null): r is ManualRef => r !== null)
    .slice(0, 3);

  const warnings: string[] = [];
  let safety_warnings = strList(parsed.safety_warnings ?? parsed.safety_flags, 6, 240);

  let severity: Severity = SEVERITIES.includes(parsed.severity) ? parsed.severity : "low";
  // A safety warning with a "low"/"medium" severity is contradictory - never under-report.
  if (safety_warnings.length > 0 && severityRank(severity) < severityRank("high")) severity = "high";

  // Deterministic floor: hazards detected in the raw inputs win over the model.
  for (const h of opts.hazards) severity = maxSeverity(severity, h.level);
  if (opts.hazards.length > 0) {
    const floor = opts.hazards.map((h) => h.warning);
    safety_warnings = [...floor, ...safety_warnings.filter((w) => !floor.includes(w))].slice(0, 8);
  }

  const confidence = num01(parsed.confidence, 0.4);

  const escRaw = parsed.escalate && typeof parsed.escalate === "object" ? parsed.escalate : {};
  let escalateRecommended = escRaw.recommended === true || parsed.recommend_specialist === true;
  let escalateReason = str(escRaw.reason, 240);
  if (!escalateRecommended && confidence < 0.4 && opts.turnNumber >= 2) {
    escalateRecommended = true;
    escalateReason = "Confidence is still low after several captures - a second pair of eyes will be faster.";
  }
  if (!escalateRecommended && severity === "emergency") {
    escalateRecommended = true;
    escalateReason = "Emergency-level hazard - consult a senior technician / specialist before proceeding.";
  }
  if (escalateRecommended && !escalateReason) escalateReason = "The copilot recommends a human expert review.";

  if (probable_causes.length === 0) {
    warnings.push("No probable cause could be isolated yet - follow the capture suggestion below.");
  }

  const spoken = str(parsed.spoken_answer, 420) || headline;

  return {
    headline: headline || probable_causes[0]?.cause || "Analysis ready",
    spoken_answer: opts.hazards.some((h) => h.level === "emergency")
      ? `Stop work. ${opts.hazards.find((h) => h.level === "emergency")!.warning.replace(/^STOP WORK:\s*/, "")}`
      : spoken,
    probable_causes,
    test_steps,
    safety_warnings,
    parts_needed,
    history_insights: strList(parsed.history_insights, 5, 220),
    manual_refs,
    next_capture: str(parsed.next_capture, 220),
    missing_info: strList(parsed.missing_info, 5, 160),
    severity,
    confidence,
    escalate: { recommended: escalateRecommended, reason: escalateReason },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Equipment matching (nameplate -> saved equipment record)
// ---------------------------------------------------------------------------

export interface EquipmentLite {
  id: string;
  equipment_type: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
}

const canon = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Serial match wins over model match; short/ambiguous tokens never match. */
export function matchEquipment(
  np: Nameplate,
  candidates: EquipmentLite[],
): { id: string; by: "serial" | "model" } | null {
  if (!np.legible) return null;
  const serial = canon(np.serial);
  if (serial.length >= 5) {
    const hit = candidates.find((c) => canon(c.serial_number) === serial);
    if (hit) return { id: hit.id, by: "serial" };
  }
  const model = canon(np.model);
  if (model.length >= 5) {
    const hits = candidates.filter((c) => canon(c.model) === model);
    if (hits.length === 1) return { id: hits[0].id, by: "model" };
  }
  return null;
}
