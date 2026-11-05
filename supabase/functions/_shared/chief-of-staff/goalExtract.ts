// supabase/functions/_shared/chief-of-staff/goalExtract.ts
//
// Deterministic goal-target extraction from typed text or a pasted/uploaded CSV/TSV. NO language model:
// every number returned appears verbatim in the input and carries a source reference (A1 cell or text
// span), so nothing can be invented. Ambiguity becomes at most two clarifying questions (codes only;
// the UI renders the words through i18next).

import { GOAL_METRICS, LIMITS, METRIC_UNIT, type GoalMetric, type GoalUnit } from "./types.ts";

export type PeriodAnswer = "week" | "month" | "quarter" | "year";

export interface ParsedTarget {
  metric: GoalMetric;
  value: number;
  unit: GoalUnit;
  periodStart: string | null;
  periodEnd: string | null;
  source: "typed" | "spreadsheet";
  /** "B4" for spreadsheets, "line 2" for typed text. */
  sourceRef: string;
  /** The exact text the value was read from. */
  sourceText: string;
}

export interface ClarifyQuestion {
  id: "period" | "duplicate_metric" | "missing_value";
  metric?: GoalMetric;
  /** period: week|month|quarter|year ; duplicate_metric: the competing values as strings. */
  options?: string[];
}

export type ExtractWarning =
  | { code: "fraction_converted"; ref: string }
  | { code: "truncated"; detail: string }
  | { code: "input_too_long" };

export interface Unresolved {
  metric: GoalMetric;
  ref: string;
  reason: "missing_value" | "duplicate_metric";
}

export interface ExtractResult {
  targets: ParsedTarget[];
  /** Values found without any period: saved only once the owner answers the period question. */
  pendingPeriod: ParsedTarget[];
  unresolved: Unresolved[];
  questions: ClarifyQuestion[];
  warnings: ExtractWarning[];
}

export interface ExtractAnswers {
  period?: PeriodAnswer;
  /** For a duplicate_metric question: the value the owner picked. */
  pick?: Partial<Record<GoalMetric, number>>;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    out += ch === "٬" ? "," : ch === "٫" ? "." : ch === "٪" ? "%" : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates (UTC arithmetic, ISO strings only)
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && iso(d) === v;
}

export function periodRange(period: PeriodAnswer, today: string): { start: string; end: string } {
  const t = new Date(`${today}T00:00:00Z`);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (period === "month") return { start: iso(utc(y, m, 1)), end: iso(utc(y, m + 1, 0)) };
  if (period === "quarter") {
    const q = Math.floor(m / 3) * 3;
    return { start: iso(utc(y, q, 1)), end: iso(utc(y, q + 3, 0)) };
  }
  if (period === "year") return { start: iso(utc(y, 0, 1)), end: iso(utc(y, 11, 31)) };
  // ISO week: Monday..Sunday
  const dow = (t.getUTCDay() + 6) % 7;
  const monday = utc(y, m, t.getUTCDate() - dow);
  return { start: iso(monday), end: iso(utc(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6)) };
}

interface Period { start: string; end: string }

const PERIOD_PATTERNS: { re: RegExp; period: PeriodAnswer }[] = [
  { re: /(?:\bper\s+month\b|\ba\s+month\b|\beach\s+month\b|\bmonthly\b|\/\s?mo\b|\bthis\s+month\b|ماهانه|این\s+ماه|ماهیانه)/iu, period: "month" },
  { re: /(?:\bper\s+week\b|\ba\s+week\b|\bweekly\b|\bthis\s+week\b|هفتگی|این\s+هفته)/iu, period: "week" },
  { re: /(?:\bquarterly\b|\bper\s+quarter\b|\bthis\s+quarter\b|سه\s*ماهه|این\s+فصل)/iu, period: "quarter" },
  { re: /(?:\bper\s+year\b|\bannual(?:ly)?\b|\byearly\b|\bthis\s+year\b|سالانه|امسال)/iu, period: "year" },
];

export function detectPeriod(text: string, today: string): Period | null {
  const range = /(\d{4}-\d{2}-\d{2})\s*(?:to|until|->|→|–|—)\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
  if (range && isIsoDate(range[1]) && isIsoDate(range[2]) && range[2] > range[1]) return { start: range[1], end: range[2] };

  const by = /\bby\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  if (by && isIsoDate(by[1]) && by[1] > today) return { start: today, end: by[1] };

  const q = /\bQ([1-4])(?:\s*(\d{4}))?\b/i.exec(text);
  if (q) {
    const year = q[2] ? Number(q[2]) : new Date(`${today}T00:00:00Z`).getUTCFullYear();
    const sm = (Number(q[1]) - 1) * 3;
    return { start: iso(utc(year, sm, 1)), end: iso(utc(year, sm + 3, 0)) };
  }
  for (const p of PERIOD_PATTERNS) if (p.re.test(text)) return periodRange(p.period, today);
  return null;
}

// ---------------------------------------------------------------------------
// Metric + number scanning
// ---------------------------------------------------------------------------

// Order matters: most specific first. Each match range is consumed so "answer rate" can't also hit "rate".
const METRIC_PATTERNS: { metric: GoalMetric; re: RegExp }[] = [
  { metric: "answer_rate", re: /(?:call\s+)?(?:answer(?:ed)?\s+rate|pick-?up\s+rate|answer(?:ed)?\s+calls?|نرخ\s+پاسخ(?:گویی)?|پاسخگویی)/giu },
  { metric: "gross_margin", re: /(?:gross\s+margin|profit\s+margin|\bmargins?\b|حاشیه\s+سود|مارژین)/giu },
  { metric: "booked_jobs", re: /(?:booked\s+jobs?|jobs?\s+booked|\bbookings?\b|\bappointments?\b|\bjobs?\b|کار(?:های)?\s+رزرو(?:\s*شده)?|رزرو)/giu },
  { metric: "revenue", re: /(?:\brevenue\b|\bsales\b|\bincome\b|\bturnover\b|درآمد|فروش)/giu },
];

interface MetricHit { metric: GoalMetric; index: number; end: number }

export function findMetrics(text: string): MetricHit[] {
  const taken: [number, number][] = [];
  const hits: MetricHit[] = [];
  for (const { metric, re } of METRIC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (taken.some(([a, b]) => start < b && a < end)) continue;
      taken.push([start, end]);
      hits.push({ metric, index: start, end });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

interface NumHit { index: number; end: number; raw: string; value: number; dollar: boolean; pct: boolean }

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

function maskNonTargetNumbers(text: string): string {
  const blank = (s: string) => " ".repeat(s.length);
  return text
    .replace(/\d{4}-\d{2}-\d{2}/g, blank)
    .replace(/\bQ[1-4]\b(?:\s*\d{4})?/gi, blank)
    .replace(new RegExp(`\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,4}\\b`, "gi"), blank)
    .replace(/\b(?:in|for|of|by)\s+(?:19|20)\d{2}\b/gi, blank);
}

export function scanNumbers(text: string): NumHit[] {
  const masked = maskNonTargetNumbers(text);
  const re = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k\b|m\b|thousand\b|million\b|%|percent\b))?/giu;
  const out: NumHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const prev = m.index > 0 ? masked[m.index - 1] : " ";
    if (/[A-Za-z_]/.test(prev) && !m[1]) continue; // part of an identifier like "abc123"
    let value = Number((m[2] ?? "").replace(/,/g, "") + (m[3] ?? ""));
    if (!Number.isFinite(value)) continue;
    const suffix = (m[4] ?? "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") value *= 1_000;
    else if (suffix === "m" || suffix === "million") value *= 1_000_000;
    out.push({
      index: m.index, end: m.index + m[0].length, raw: m[0].trim(), value,
      dollar: Boolean(m[1]), pct: suffix === "%" || suffix === "percent",
    });
  }
  return out;
}

interface Pairing { metric: GoalMetric; num: NumHit | null; hit: MetricHit }

function pairMetricsWithNumbers(text: string): Pairing[] {
  const metrics = findMetrics(text);
  const nums = scanNumbers(text);
  const used = new Set<number>();
  const result: Pairing[] = [];
  metrics.forEach((hit, i) => {
    const nextMetricStart = metrics[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    // 1) a number directly in front ("120 booked jobs", "$50k revenue")
    let pick = nums.find((n, idx) => !used.has(idx) && n.end <= hit.index && /^\s{0,2}$/.test(text.slice(n.end, hit.index)));
    // 2) otherwise the closest number after ("revenue of $50k", "answer rate: 90%")
    if (!pick) pick = nums.find((n, idx) => !used.has(idx) && n.index >= hit.end && n.index - hit.end <= 35 && n.index < nextMetricStart);
    if (pick) used.add(nums.indexOf(pick));
    result.push({ metric: hit.metric, num: pick ?? null, hit });
  });
  return result;
}

function validate(metric: GoalMetric, n: NumHit, ref: string, warnings: ExtractWarning[]): number | null {
  let v = n.value;
  if (metric === "revenue") return v > 0 && !n.pct ? round2(v) : null;
  if (metric === "booked_jobs") return Number.isInteger(v) && v > 0 && !n.pct && !n.dollar ? v : null;
  // rates
  if (n.dollar) return null;
  if (!n.pct && v > 0 && v <= 1) { v = round2(v * 100); warnings.push({ code: "fraction_converted", ref }); }
  return v > 0 && v <= 100 ? round2(v) : null;
}
const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

export function parseDelimited(text: string, maxRows = 500, maxCols = 50): { rows: string[][]; truncated: boolean } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let truncated = false;
  const pushCell = () => { row.push(cell.trim()); cell = ""; };
  const pushRow = () => {
    pushCell();
    rows.push(row.slice(0, maxCols)); // blank rows are kept so row numbers match the spreadsheet (A1 references)
    if (row.length > maxCols) truncated = true;
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) pushCell();
    else if (ch === "\n") { pushRow(); if (rows.length >= maxRows) { truncated = true; break; } }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) pushRow();
  return { rows, truncated };
}

const colLetter = (i: number) => {
  let s = "";
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

interface Raw { metric: GoalMetric; value: number; period: Period | null; ref: string; text: string }

function extractFromTable(rows: string[][], today: string, warnings: ExtractWarning[]): { raws: Raw[]; missing: Unresolved[] } {
  const raws: Raw[] = [];
  const missing: Unresolved[] = [];
  if (rows.length === 0) return { raws, missing };
  const h0 = Math.max(0, rows.findIndex((r) => r.some((c) => c !== "")));
  const header = rows[h0] ?? [];
  const headerMetrics = header.map((h) => findMetrics(h)[0]?.metric ?? null);
  const wide = headerMetrics.some(Boolean) && rows.length > h0 + 1;
  const periodCol = header.findIndex((h) => /\b(period|timeframe|cadence|horizon)\b|دوره/i.test(h));

  if (wide) {
    headerMetrics.forEach((metric, c) => {
      if (!metric) return;
      for (let r = h0 + 1; r < rows.length; r++) {
        const cellText = rows[r]?.[c] ?? "";
        if (cellText === "") continue;
        const ref = `${colLetter(c)}${r + 1}`;
        const num = scanNumbers(normalizeDigits(cellText))[0];
        const rowPeriodText = periodCol >= 0 ? rows[r]?.[periodCol] ?? "" : "";
        const period = detectPeriod(`${rowPeriodText} ${header[c] ?? ""}`, today);
        const value = num ? validate(metric, num, ref, warnings) : null;
        if (value === null) { missing.push({ metric, ref, reason: "missing_value" }); continue; }
        raws.push({ metric, value, period, ref, text: cellText });
        break; // one value per column; later rows are other periods/notes
      }
    });
    return { raws, missing };
  }

  for (let r = h0 + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const rowText = normalizeDigits(cells.join(" | "));
    const rowPeriod = detectPeriod(rowText, today);
    cells.forEach((cellRaw, c) => {
      const cell = normalizeDigits(cellRaw);
      const hit = findMetrics(cell)[0];
      if (!hit) return;
      const ref = `${colLetter(c)}${r + 1}`;
      // the first numeric cell to the right, else a number inside the same cell
      let num: NumHit | undefined = scanNumbers(cell.slice(hit.end))[0] ?? scanNumbers(cell)[0];
      let valueRef = ref;
      if (!num) {
        for (let k = c + 1; k < cells.length && !num; k++) {
          const cand = scanNumbers(normalizeDigits(cells[k] ?? ""))[0];
          if (cand) { num = cand; valueRef = `${colLetter(k)}${r + 1}`; }
        }
      }
      const value = num ? validate(hit.metric, num, valueRef, warnings) : null;
      if (value === null) { missing.push({ metric: hit.metric, ref, reason: "missing_value" }); return; }
      raws.push({ metric: hit.metric, value, period: rowPeriod, ref: valueRef, text: cellRaw });
    });
  }
  return { raws, missing };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ExtractInput {
  text?: string;
  csv?: string;
  today: string;
  answers?: ExtractAnswers;
}

export function extractGoalTargets(input: ExtractInput): ExtractResult {
  const warnings: ExtractWarning[] = [];
  const empty: ExtractResult = { targets: [], pendingPeriod: [], unresolved: [], questions: [], warnings };
  const source = input.csv !== undefined ? "spreadsheet" : "typed";
  const rawInput = input.csv ?? input.text ?? "";
  if (rawInput.length > LIMITS.maxGoalInputChars) return { ...empty, warnings: [{ code: "input_too_long" }] };
  if (!isIsoDate(input.today)) throw new Error("today must be an ISO date");

  let raws: Raw[] = [];
  let missing: Unresolved[] = [];

  if (source === "spreadsheet") {
    const { rows, truncated } = parseDelimited(rawInput);
    if (truncated) warnings.push({ code: "truncated", detail: "rows/columns" });
    ({ raws, missing } = extractFromTable(rows, input.today, warnings));
  } else {
    const lines = rawInput.split(/\r?\n|;/);
    const globalPeriods = new Set<string>();
    const perLine: { text: string; pairs: Pairing[]; period: Period | null; line: number }[] = [];
    lines.forEach((l, i) => {
      const text = normalizeDigits(l);
      if (text.trim() === "") return;
      const period = detectPeriod(text, input.today);
      if (period) globalPeriods.add(`${period.start}|${period.end}`);
      perLine.push({ text, pairs: pairMetricsWithNumbers(text), period, line: i + 1 });
    });
    // A period stated once in the whole message applies to lines that don't state their own.
    const fallback = globalPeriods.size === 1 ? [...globalPeriods][0]!.split("|") : null;
    for (const l of perLine) {
      const period = l.period ?? (fallback ? { start: fallback[0]!, end: fallback[1]! } : null);
      for (const p of l.pairs) {
        const ref = `line ${l.line}`;
        const value = p.num ? validate(p.metric, p.num, ref, warnings) : null;
        if (value === null) { missing.push({ metric: p.metric, ref, reason: "missing_value" }); continue; }
        raws.push({ metric: p.metric, value, period, ref, text: l.text.trim().slice(0, 200) });
      }
    }
  }

  // Apply the owner's answers.
  const answer = input.answers?.period ? periodRange(input.answers.period, input.today) : null;
  const picks = input.answers?.pick ?? {};

  // Duplicate detection: same metric, different value.
  const byMetric = new Map<GoalMetric, Raw[]>();
  for (const r of raws) byMetric.set(r.metric, [...(byMetric.get(r.metric) ?? []), r]);
  const unresolved: Unresolved[] = [...missing];
  const questions: ClarifyQuestion[] = [];
  const kept: Raw[] = [];
  for (const metric of GOAL_METRICS) {
    const list = byMetric.get(metric) ?? [];
    const distinct = [...new Set(list.map((r) => r.value))];
    if (distinct.length <= 1) { if (list[0]) kept.push(list[0]); continue; }
    const chosen = picks[metric];
    const match = chosen !== undefined ? list.find((r) => r.value === chosen) : undefined;
    if (match) { kept.push(match); continue; }
    unresolved.push({ metric, ref: list.map((r) => r.ref).join(","), reason: "duplicate_metric" });
    questions.push({ id: "duplicate_metric", metric, options: distinct.map(String) });
  }

  const targets: ParsedTarget[] = [];
  const pendingPeriod: ParsedTarget[] = [];
  for (const r of kept) {
    const period = r.period ?? answer;
    const t: ParsedTarget = {
      metric: r.metric, value: r.value, unit: METRIC_UNIT[r.metric],
      periodStart: period?.start ?? null, periodEnd: period?.end ?? null,
      source, sourceRef: r.ref, sourceText: r.text,
    };
    (period ? targets : pendingPeriod).push(t);
  }

  const ordered: ClarifyQuestion[] = [];
  if (pendingPeriod.length > 0) ordered.push({ id: "period", options: ["week", "month", "quarter", "year"] });
  ordered.push(...questions);
  for (const u of unresolved.filter((x) => x.reason === "missing_value")) ordered.push({ id: "missing_value", metric: u.metric });

  return {
    targets,
    pendingPeriod,
    unresolved,
    questions: ordered.slice(0, LIMITS.maxClarifyingQuestions),
    warnings,
  };
}
