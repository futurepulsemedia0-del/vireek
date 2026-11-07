// supabase/functions/_shared/sarah-learn/schema.ts
//
// The contract for what Sarah may "learn", plus the validator that turns
// untrusted model output into trustworthy fields.
//
// Hallucination policy (enforced in code, not in the prompt):
//   * every field key is whitelisted; values are shape-checked per kind
//   * a price/amount is kept ONLY if every dollar figure in it appears in a
//     fetched source (or the owner's own words)
//   * licenses / insurance / warranty / financing claims are kept ONLY if the
//     model's quoted evidence is found verbatim in the cited source
//   * list items (services) not grounded in the sources are dropped
//   * anything else the model could not quote is kept but flagged
//     `assumed: true` with confidence "low"
//   * sensitive fields are never auto-approved
// Quotes are capped at 160 chars so we never store third-party text wholesale.

import { normalizeForMatch } from './sanitize.ts';

export type Confidence = 'high' | 'medium' | 'low';
export type FieldKind = 'text' | 'list' | 'hours' | 'price' | 'faq' | 'emergency';
export type FieldGroup = 'basics' | 'services' | 'hours_area' | 'pricing' | 'trust' | 'voice' | 'faq';

export interface FieldDef {
  key: string;
  kind: FieldKind;
  group: FieldGroup;
  /** Needs explicit owner approval before go-live (prices, emergency rules, legal claims). */
  sensitive: boolean;
  /** Requires verbatim quoted evidence or the field is dropped. */
  requiresEvidence: boolean;
  required: boolean;
}

const def = (
  key: string,
  kind: FieldKind,
  group: FieldGroup,
  o: Partial<Pick<FieldDef, 'sensitive' | 'requiresEvidence' | 'required'>> = {},
): FieldDef => ({ key, kind, group, sensitive: !!o.sensitive, requiresEvidence: !!o.requiresEvidence, required: !!o.required });

export const FIELD_DEFS: readonly FieldDef[] = [
  def('business_name', 'text', 'basics', { required: true }),
  def('trade', 'text', 'basics'),
  def('languages', 'list', 'basics'),
  def('brand_pronunciation', 'text', 'voice'),
  def('team_names', 'list', 'voice'),
  def('tone_samples', 'list', 'voice'),
  def('tone_preference', 'text', 'voice'),
  def('services_offered', 'list', 'services', { required: true }),
  def('services_not_offered', 'list', 'services'),
  def('never_book', 'list', 'services', { sensitive: true }),
  def('differentiators', 'list', 'services'),
  def('service_area', 'text', 'hours_area', { required: true }),
  def('service_area_notes', 'text', 'hours_area'),
  def('hours', 'hours', 'hours_area'),
  def('holiday_hours', 'text', 'hours_area'),
  def('emergency_policy', 'emergency', 'hours_area', { sensitive: true }),
  def('pricing_signals', 'price', 'pricing', { sensitive: true, requiresEvidence: true }),
  def('diagnostic_fee', 'price', 'pricing', { sensitive: true, requiresEvidence: true }),
  def('financing', 'text', 'pricing', { sensitive: true, requiresEvidence: true }),
  def('licenses_insurance', 'text', 'trust', { sensitive: true, requiresEvidence: true }),
  def('warranties', 'text', 'trust', { sensitive: true, requiresEvidence: true }),
  def('escalation_contact', 'text', 'trust', { sensitive: true }),
  def('faqs', 'faq', 'faq'),
] as const;

export const FIELD_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(FIELD_DEFS.map((d) => [d.key, d]));
export const REQUIRED_KEYS: readonly string[] = FIELD_DEFS.filter((d) => d.required).map((d) => d.key);

export type HoursValue = Record<string, { open: string; close: string }>;
export interface EmergencyValue {
  mode: 'yes_premium' | 'yes_same_rate' | 'business_hours_only' | 'unknown';
  note: string;
}
export interface FaqItem {
  question: string;
  answer: string;
}
export type FieldValue = string | string[] | HoursValue | EmergencyValue | FaqItem[];

export interface ValidatedField {
  key: string;
  value: FieldValue;
  confidence: Confidence;
  assumed: boolean;
  sensitive: boolean;
  /** Short quote proving the field (<=160 chars) or null when assumed. */
  citation: string | null;
  sourceRef: string | null;
}

export interface SourceText {
  /** Opaque label shown to the model, e.g. "s1". */
  ref: string;
  text: string;
}

const MAX_TEXT = 400;
const MAX_ITEM = 120;
const MAX_ITEMS = 30;
const MAX_QUOTE = 160;
const DAY_KEYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMERGENCY_MODES = new Set(['yes_premium', 'yes_same_rate', 'business_hours_only', 'unknown']);
const CONFIDENCES = new Set<Confidence>(['high', 'medium', 'low']);

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // strip control chars and anything that looks like markup
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};

/** All dollar-like numbers in a string, as plain numbers (e.g. "$1,250.50" -> 1250.5). */
export function extractAmounts(s: string): number[] {
  const out: number[] = [];
  const re = /(?:\$|usd\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|bucks|usd)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const whole = (m[1] ?? m[3] ?? '').replace(/,/g, '');
    const frac = m[2] ?? m[4] ?? '';
    const n = Number(frac ? `${whole}.${frac}` : whole);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function corpusIncludesAmount(corpus: string, amount: number): boolean {
  return extractAmounts(corpus).some((a) => Math.abs(a - amount) < 0.005);
}

function stem(w: string): string {
  return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w;
}

/** An item is grounded when it (or every meaningful word of it) occurs in the sources. */
export function isGrounded(item: string, normalizedCorpus: string): boolean {
  const n = normalizeForMatch(item);
  if (!n) return false;
  if (normalizedCorpus.includes(n)) return true;
  const words = n.split(/[^a-z0-9À-ɏ]+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.every((w) => normalizedCorpus.includes(stem(w)));
}

function validateValue(kind: FieldKind, raw: unknown): FieldValue | null {
  switch (kind) {
    case 'text':
    case 'price': {
      if (kind === 'price' && Array.isArray(raw)) {
        const items = raw.map((x) => clean(x, MAX_ITEM)).filter((x): x is string => !!x).slice(0, MAX_ITEMS);
        return items.length ? items : null;
      }
      return clean(raw, MAX_TEXT);
    }
    case 'list': {
      if (!Array.isArray(raw)) return null;
      const items = raw.map((x) => clean(x, MAX_ITEM)).filter((x): x is string => !!x).slice(0, MAX_ITEMS);
      return items.length ? Array.from(new Set(items)) : null;
    }
    case 'hours': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const out: HoursValue = {};
      for (const [day, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!DAY_KEYS.has(day) || !v || typeof v !== 'object') continue;
        const { open, close } = v as Record<string, unknown>;
        if (typeof open === 'string' && typeof close === 'string' && TIME_RE.test(open) && TIME_RE.test(close) && open < close) {
          out[day] = { open, close };
        }
      }
      return Object.keys(out).length ? out : null;
    }
    case 'faq': {
      if (!Array.isArray(raw)) return null;
      const out: FaqItem[] = [];
      for (const x of raw.slice(0, 25)) {
        if (!x || typeof x !== 'object') continue;
        const q = clean((x as Record<string, unknown>).question, 200);
        const a = clean((x as Record<string, unknown>).answer, 400);
        if (q && a) out.push({ question: q, answer: a });
      }
      return out.length ? out : null;
    }
    case 'emergency': {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const mode = typeof r.mode === 'string' && EMERGENCY_MODES.has(r.mode) ? (r.mode as EmergencyValue['mode']) : 'unknown';
      const note = clean(r.note, MAX_TEXT) ?? '';
      return mode === 'unknown' && !note ? null : { mode, note };
    }
  }
}

function valueToString(v: FieldValue): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : `${x.question} ${x.answer}`)).join(' ; ');
  if ('mode' in v) return `${v.mode} ${v.note}`;
  return JSON.stringify(v);
}

export interface ValidateOptions {
  /** Only these keys may be returned (defaults to all). */
  allowedKeys?: ReadonlySet<string>;
}

/**
 * Validates the model's extraction output against the sources.
 * Expected raw shape: { fields: [{ key, value, confidence, quote, source }] }
 */
export function validateExtraction(raw: unknown, sources: SourceText[], opts: ValidateOptions = {}): ValidatedField[] {
  const list: unknown[] = Array.isArray((raw as { fields?: unknown })?.fields) ? (raw as { fields: unknown[] }).fields : [];
  const corpus = sources.map((s) => s.text).join('\n');
  const normCorpus = normalizeForMatch(corpus);
  const byRef = new Map(sources.map((s) => [s.ref, normalizeForMatch(s.text)]));
  const seen = new Set<string>();
  const out: ValidatedField[] = [];

  for (const item of list.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : '';
    const d = FIELD_BY_KEY.get(key);
    if (!d || seen.has(key) || (opts.allowedKeys && !opts.allowedKeys.has(key))) continue;

    let value = validateValue(d.kind, r.value);
    if (value === null) continue;

    const sourceRef = typeof r.source === 'string' && byRef.has(r.source) ? r.source : null;
    const quoteRaw = clean(r.quote, MAX_QUOTE);
    const evidenceCorpus = sourceRef ? (byRef.get(sourceRef) as string) : normCorpus;
    const quoteFound = !!quoteRaw && normalizeForMatch(quoteRaw).length >= 4 && evidenceCorpus.includes(normalizeForMatch(quoteRaw));

    // --- price grounding: every amount must exist in the sources -------------
    if (d.kind === 'price') {
      const amounts = extractAmounts(valueToString(value));
      if (amounts.some((a) => !corpusIncludesAmount(corpus, a))) continue; // invented price: drop entirely
      if (amounts.length === 0 && !quoteFound) continue; // a "price" with no figure and no evidence
    }

    // --- legal / financing claims need verbatim evidence ---------------------
    if (d.requiresEvidence && !quoteFound) continue;

    // --- list items must be grounded ----------------------------------------
    if (d.kind === 'list' && Array.isArray(value) && ['services_offered', 'services_not_offered', 'team_names'].includes(key)) {
      const grounded = (value as string[]).filter((x) => isGrounded(x, normCorpus));
      if (!grounded.length) continue;
      value = grounded;
    }

    let confidence: Confidence = typeof r.confidence === 'string' && CONFIDENCES.has(r.confidence as Confidence) ? (r.confidence as Confidence) : 'low';
    const assumed = !quoteFound;
    if (assumed) confidence = 'low';
    else if (confidence === 'high' && d.sensitive) confidence = 'medium'; // sensitive items are never "high" from a website alone

    seen.add(key);
    out.push({
      key,
      value,
      confidence,
      assumed,
      sensitive: d.sensitive,
      citation: quoteFound ? quoteRaw : null,
      sourceRef: quoteFound ? sourceRef : null,
    });
  }
  return out;
}

/** Pricing-signal / fee strings built ONLY from the owner's own interview answer. */
export function ownerAnswerField(key: string, answer: string): ValidatedField | null {
  const d = FIELD_BY_KEY.get(key);
  if (!d) return null;
  const text = clean(answer, 600);
  if (!text) return null;
  let value: FieldValue | null;
  if (d.kind === 'list') value = validateValue('list', text.split(/\s*(?:,|;|\band\b|\by\b|\n)\s*/i).filter(Boolean));
  else if (d.kind === 'emergency') value = { mode: classifyEmergencyMode(text), note: text.slice(0, MAX_TEXT) };
  else value = validateValue(d.kind === 'price' ? 'text' : d.kind, text);
  if (value === null) return null;
  return {
    key,
    value,
    confidence: 'high',
    assumed: false,
    sensitive: d.sensitive,
    citation: text.slice(0, MAX_QUOTE),
    sourceRef: null,
  };
}

export function classifyEmergencyMode(text: string): EmergencyValue['mode'] {
  const t = normalizeForMatch(text);
  // 1. unambiguous "no emergency service" phrasings
  if (/business hours only|solo (en )?horario|(do not|don't|dont|we do not|no) (offer|do|take|handle|provide|hacemos|ofrecemos) (any )?(emergenc|after[- ]hours|night|weekend)/.test(t)) return 'business_hours_only';
  // 2. same rate / no surcharge
  if (/\b(same (rate|price)|no (extra|additional|surcharge)|mismo precio|misma tarifa|sin recargo)\b/.test(t)) return 'yes_same_rate';
  // 3. premium
  if (/\b(premium|surcharge|extra|higher rate|after[- ]hours (fee|rate)|time and a half|double|recargo|tarifa de emergencia)\b/.test(t)) return 'yes_premium';
  // 4. softer "no ... emergency"
  if (/\b(no|not|never|sin)\b[^.]{0,40}\b(emergenc|after[- ]hours|nights?|weekends?)/.test(t)) return 'business_hours_only';
  return 'unknown';
}

/** Which required / sensitive keys are still missing from a field map. */
export function missingRequired(have: ReadonlySet<string>): string[] {
  return REQUIRED_KEYS.filter((k) => !have.has(k));
}

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Merges per-source extraction results: best evidence wins; lists and FAQs are unioned. */
export function mergeValidated(batches: readonly ValidatedField[][]): ValidatedField[] {
  const byKey = new Map<string, ValidatedField[]>();
  for (const batch of batches) for (const f of batch) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);

  const out: ValidatedField[] = [];
  for (const [key, cands] of byKey) {
    const ranked = [...cands].sort((a, b) => Number(a.assumed) - Number(b.assumed) || CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
    const best = ranked[0];
    const kind = FIELD_BY_KEY.get(key)?.kind;
    if (kind === 'list' && cands.length > 1) {
      const items = Array.from(new Set(ranked.filter((c) => !c.assumed || c === best).flatMap((c) => (Array.isArray(c.value) ? (c.value as string[]) : []))));
      out.push({ ...best, value: items.slice(0, MAX_ITEMS) });
    } else if (kind === 'faq' && cands.length > 1) {
      const seenQ = new Set<string>();
      const faqs: FaqItem[] = [];
      for (const c of ranked) {
        for (const q of Array.isArray(c.value) ? (c.value as FaqItem[]) : []) {
          const k = q.question.toLowerCase();
          if (!seenQ.has(k) && faqs.length < 25) {
            seenQ.add(k);
            faqs.push(q);
          }
        }
      }
      out.push({ ...best, value: faqs });
    } else if (kind === 'price' && cands.length > 1 && Array.isArray(best.value)) {
      const items = Array.from(new Set(ranked.flatMap((c) => (Array.isArray(c.value) ? (c.value as string[]) : []))));
      out.push({ ...best, value: items.slice(0, MAX_ITEMS) });
    } else {
      out.push(best);
    }
  }
  return out;
}
