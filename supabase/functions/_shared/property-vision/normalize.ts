// supabase/functions/_shared/property-vision/normalize.ts
//
// Turns raw (untrusted) vision-model JSON into a strictly typed, bounded,
// sanitized NormAnalysis. Nothing the model returns reaches the database
// without passing through here: enums are clamped, codes are mapped to the
// controlled vocabulary, numbers are bounded, text is stripped of markup and
// control characters, and references to "known assets" are validated.
//
// Pure module (no I/O) — covered by memory.test.ts.

import {
  AGE_BASES, COMPONENT_KINDS, CONDITIONS, CONDITION_CODES, EQUIPMENT_KINDS, HAZARD_CODES,
  INSTALL_ISSUE_CODES, INSTALL_QUALITIES, ROOM_TYPES, SERIAL_LEGIBILITY, SEVERITIES,
  type AgeBasis, type Condition, type FindingType, type InstallQuality, type NormAnalysis,
  type NormEquipment, type NormFinding, type PriorStatus, type Region, type SerialLegibility, type Severity,
} from "./taxonomy.ts";

type Obj = Record<string, unknown>;

const MAX_EQUIPMENT = 8;
const MAX_FINDINGS_PER_TYPE = 12;
const MAX_AREA_FINDINGS = 10;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Strips control chars + angle brackets, collapses whitespace, bounds length. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v)
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function textOrNull(v: unknown, max: number): string | null {
  const s = cleanText(v, max);
  return s ? s : null;
}
function clamp01(v: unknown, fallback = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}
function snake(v: unknown): string {
  return cleanText(v, 60).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function codeOf(v: unknown, allowed: readonly string[]): string {
  const s = snake(v);
  return allowed.includes(s) ? s : "other";
}
export function humanize(code: string): string {
  const s = code.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function extractJson(text: string): unknown {
  const t = text.replace(/```json|```/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json_object");
  return JSON.parse(t.slice(start, end + 1));
}

// ------------------------------------------------------------------
// Serial numbers
// ------------------------------------------------------------------

const SERIAL_PLACEHOLDERS = new Set(["SERIAL", "SERIALNUMBER", "SERIALNO", "UNKNOWN", "NONE", "NA", "NOTVISIBLE", "UNREADABLE"]);

/** Upper-case alphanumerics only; null when it does not look like a real serial. */
export function normalizeSerial(raw: unknown): string | null {
  const s = cleanText(raw, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 5 || s.length > 24) return null;
  if (SERIAL_PLACEHOLDERS.has(s)) return null;
  if ((s.match(/[0-9]/g) ?? []).length < 2) return null;
  if (/^(.)\1+$/.test(s)) return null;
  return s;
}

/** Visually-confusable collapse (O/0, I/L/1) — only ever used to SUGGEST a match, never to auto-merge. */
export function serialLooseKey(norm: string): string {
  return norm.replace(/O/g, "0").replace(/[IL]/g, "1");
}

// ------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------

export function toRegion(v: unknown): Region | null {
  const a = arr(v);
  if (a.length !== 4) return null;
  const n = a.map((x) => Math.round(Math.min(1000, Math.max(0, Number(x)))));
  if (n.some((x) => !Number.isFinite(x))) return null;
  const [ymin, xmin, ymax, xmax] = n;
  if (ymax - ymin < 5 || xmax - xmin < 5) return null;
  return [ymin, xmin, ymax, xmax];
}

// ------------------------------------------------------------------
// Findings
// ------------------------------------------------------------------

function slug(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, max);
}

function normFinding(raw: unknown, type: FindingType, allowedCodes: readonly string[]): NormFinding | null {
  if (!isObj(raw)) return null;
  const code = codeOf(raw.code ?? raw.type, allowedCodes);
  const description = cleanText(raw.description ?? raw.hazard ?? raw.issue, 600);
  let locus = cleanText(raw.locus ?? raw.location, 80).toLowerCase();
  // "other" findings would all collide on (type, code, locus): disambiguate by their description.
  if (code === "other" && !locus) locus = slug(description);
  if (code === "other" && !description) return null;
  const severity = pick<Severity>(raw.severity, SEVERITIES, type === "hazard" ? "medium" : "low");
  const hint = type === "installation_issue" ? textOrNull(raw.standard_hint, 300) : null;
  const title = code === "other"
    ? (description.slice(0, 80) || humanize(code))
    : `${humanize(code)}${locus ? ` · ${locus}` : ""}`.slice(0, 200);
  return {
    type, code, locus, title, description, severity,
    standard_hint: hint,
    // Installation findings are advisory deviations, never a legal conclusion.
    verify_required: type === "installation_issue",
    attrs: {},
    region: toRegion(raw.region),
  };
}

function normComponent(raw: unknown): NormFinding | null {
  if (!isObj(raw)) return null;
  const code = codeOf(raw.kind, COMPONENT_KINDS);
  const label = cleanText(raw.label, 60);
  const locus = (label || (code === "other" ? slug(cleanText(raw.notes, 60)) : "")).toLowerCase();
  if (code === "other" && !locus) return null;
  const condition = pick<Condition>(raw.condition, CONDITIONS, "unknown");
  const origin = pick(raw.origin, ["original", "appears_replaced", "unknown"] as const, "unknown");
  return {
    type: "component", code, locus,
    title: (label || humanize(code)).slice(0, 200),
    description: cleanText(raw.notes, 400),
    severity: condition === "critical" ? "medium" : condition === "poor" ? "low" : "info",
    standard_hint: null,
    verify_required: false,
    attrs: { material: textOrNull(raw.material, 60), condition, origin },
    region: toRegion(raw.region),
  };
}

function mapFindings(list: unknown, type: FindingType, codes: readonly string[]): NormFinding[] {
  return arr(list).map((r) => normFinding(r, type, codes)).filter((f): f is NormFinding => f !== null)
    .slice(0, MAX_FINDINGS_PER_TYPE);
}

// ------------------------------------------------------------------
// Equipment
// ------------------------------------------------------------------

function normEquipment(
  raw: unknown, idx: number, photoCount: number, knownRefs: Set<string>, nowYear: number,
): NormEquipment | null {
  if (!isObj(raw)) return null;

  const idxs = arr(raw.photo_indexes).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < photoCount);
  const photo_indexes = idxs.length ? [...new Set(idxs)] : Array.from({ length: photoCount }, (_, i) => i);

  const serial_raw = textOrNull(raw.serial, 40);
  let serial_legibility = pick<SerialLegibility>(raw.serial_legibility, SERIAL_LEGIBILITY, serial_raw ? "partial" : "none");
  const serial_norm = normalizeSerial(serial_raw);
  if (serial_legibility === "clear" && !serial_norm) serial_legibility = "partial";

  const matchObj = isObj(raw.match) ? raw.match : {};
  const refRaw = cleanText(matchObj.asset_ref, 10).toUpperCase();
  const match_ref = refRaw && knownRefs.has(refRaw) ? refRaw : null;

  // Age: never trust a "label/serial" basis without an actual plausible year.
  const ageObj = isObj(raw.age) ? raw.age : {};
  let age_basis = pick<AgeBasis>(ageObj.basis, AGE_BASES, "unknown");
  if (age_basis === "human") age_basis = "unknown"; // the model can never claim a human-verified age
  const yr = Number(ageObj.install_year);
  const install_year = Number.isInteger(yr) && yr >= 1950 && yr <= nowYear ? yr : null;
  const rg = arr(ageObj.range_years).map(Number);
  const age_range: [number, number] | null =
    rg.length === 2 && rg.every((n) => Number.isFinite(n) && n >= 0 && n <= 80) && rg[0] <= rg[1]
      ? [rg[0], rg[1]] : null;
  if ((age_basis === "label_date" || age_basis === "serial_decode") && !install_year) {
    age_basis = age_range ? "visual" : "unknown";
  }
  if (age_basis === "visual" && !age_range) age_basis = "unknown";

  const installObj = isObj(raw.installation) ? raw.installation : {};
  const findings: NormFinding[] = [
    ...mapFindings(raw.hazards, "hazard", HAZARD_CODES),
    ...mapFindings(installObj.issues, "installation_issue", INSTALL_ISSUE_CODES),
    ...mapFindings(raw.condition_indicators, "condition_indicator", CONDITION_CODES),
    ...arr(raw.components).map(normComponent).filter((f): f is NormFinding => f !== null).slice(0, MAX_FINDINGS_PER_TYPE),
  ];

  return {
    local_id: cleanText(raw.local_id, 8) || `E${idx + 1}`,
    photo_indexes,
    kind: codeOf(raw.kind, EQUIPMENT_KINDS),
    make: textOrNull(raw.make, 60),
    model: textOrNull(raw.model, 80),
    serial_raw, serial_norm, serial_legibility,
    specs: textOrNull(raw.specs, 200),
    location_label: textOrNull(raw.location_label, 120),
    match_ref,
    match_confidence: clamp01(matchObj.confidence),
    match_basis: textOrNull(matchObj.basis, 200),
    condition: pick<Condition>(raw.condition, CONDITIONS, "unknown"),
    installation_quality: pick<InstallQuality>(installObj.quality, INSTALL_QUALITIES, "unknown"),
    age_basis, install_year, age_range,
    age_confidence: clamp01(ageObj.confidence),
    region: toRegion(raw.region),
    confidence: clamp01(raw.confidence, 0.5),
    findings,
  };
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export function normalizeAnalysis(
  raw: unknown,
  opts: { photoCount: number; knownRefs: Set<string>; knownFindingRefs?: Set<string>; nowYear: number },
): NormAnalysis {
  const r = isObj(raw) ? raw : {};
  const equipment = arr(r.equipment)
    .map((e, i) => normEquipment(e, i, opts.photoCount, opts.knownRefs, opts.nowYear))
    .filter((e): e is NormEquipment => e !== null)
    .slice(0, MAX_EQUIPMENT);

  const prior_review: Record<string, PriorStatus> = {};
  for (const p of arr(r.prior_findings_review)) {
    if (!isObj(p)) continue;
    const ref = cleanText(p.ref, 16).toUpperCase();
    const st = pick<PriorStatus>(p.status, ["still_visible", "no_longer_visible", "not_in_frame"], "not_in_frame");
    if (ref && (!opts.knownFindingRefs || opts.knownFindingRefs.has(ref))) prior_review[ref] = st;
  }

  const photo_quality = arr(r.photo_quality).flatMap((q) => {
    if (!isObj(q)) return [];
    const photo_index = Number(q.photo_index);
    if (!Number.isInteger(photo_index) || photo_index < 0 || photo_index >= opts.photoCount) return [];
    return [{
      photo_index,
      usable: q.usable !== false,
      issues: arr(q.issues).map((i) => cleanText(i, 80)).filter(Boolean).slice(0, 5),
    }];
  });

  return {
    room_type: pick(r.room_type, ROOM_TYPES, "other"),
    scene_summary: cleanText(r.scene_summary, 500),
    photo_quality,
    equipment,
    area_findings: mapFindings(r.area_hazards, "hazard", HAZARD_CODES).slice(0, MAX_AREA_FINDINGS),
    prior_review,
  };
}
