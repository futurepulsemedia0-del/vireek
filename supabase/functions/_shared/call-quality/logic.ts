// supabase/functions/_shared/call-quality/logic.ts
//
// AI Quality Center — pure logic (no I/O, no Deno APIs, no browser APIs).
// Shared by:
//   - supabase/functions/call-quality-review  (scoring, compliance, AI-output validation)
//   - src/lib/callQuality.ts / AiQualityCenterPage (grades, trend vs baseline, fix preview)
// Unit-tested from src/lib/callQuality.test.ts.
//
// Design rules:
//   1. Everything that CAN be decided deterministically IS (compliance phrases,
//      price errors, booking misses, scores). The AI only judges what rules cannot:
//      hallucinated claims and knowledge gaps.
//   2. The AI reviewer is itself untrusted: a finding is kept only when its
//      evidence quote really exists in the transcript.
//   3. The AI never writes business facts. Fixes that need a fact (a price, a
//      policy) are proposals that REQUIRE the owner's answer before they apply.

import { sanitizeScriptText, isScenarioKey, LIMITS as SCRIPT_LIMITS, type ScenarioKey } from '../call-scripts/logic.ts';

export const QUALITY_VERSION = 1;
/** Below this many reviews a trend number is shown but flagged as unreliable. */
export const MIN_TREND_SAMPLE = 5;

export type FindingKind = 'hallucination' | 'price_error' | 'missed_booking' | 'missed_upsell' | 'compliance_miss' | 'knowledge_gap';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type DimensionKey = 'accuracy' | 'booking' | 'upsell' | 'compliance' | 'experience';
export type FixType = 'kb_article' | 'script_patch';

export const FINDING_KINDS: FindingKind[] = ['hallucination', 'price_error', 'missed_booking', 'missed_upsell', 'compliance_miss', 'knowledge_gap'];
export const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
export const DIMENSIONS: DimensionKey[] = ['accuracy', 'compliance', 'booking', 'experience', 'upsell'];

export const KIND_LABELS: Record<FindingKind, string> = {
  hallucination: 'Possible hallucination',
  price_error: 'Price error',
  missed_booking: 'Missed booking',
  missed_upsell: 'Missed upsell',
  compliance_miss: 'Compliance miss',
  knowledge_gap: 'Knowledge gap',
};

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  accuracy: 'Accuracy',
  compliance: 'Compliance',
  booking: 'Booking',
  experience: 'Customer experience',
  upsell: 'Upsell',
};

export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = { accuracy: 0.3, compliance: 0.25, booking: 0.2, experience: 0.15, upsell: 0.1 };

export const FIX_LIMITS = { additionMax: 400, titleMax: 120, detailMax: 400, quoteMax: 200, maxFindings: 6, minQuote: 12 } as const;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercase, straighten quotes, drop punctuation, collapse whitespace. */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}$%\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slug(input: string, max = 48): string {
  return normalizeText(input).replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x';
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Transcript turns
// ---------------------------------------------------------------------------

export type TurnRole = 'agent' | 'caller' | 'unknown';
export interface Turn { index: number; role: TurnRole; text: string }

const CALLER_LABELS = new Set(['caller', 'user', 'customer', 'client', 'human', 'homeowner', 'guest', 'prospect', 'lead']);
const AGENT_LABELS = new Set(['ai', 'assistant', 'bot', 'agent', 'receptionist', 'system', 'vireek', 'operator', 'dispatcher', 'sarah']);
const LABEL_RE = /^\s*([A-Za-z][A-Za-z0-9 .'_-]{0,30}?)\s*:\s*(.*)$/;

/** "Speaker: words" per line (Vapi format). Lines without a known role label continue the previous turn. */
export function splitTurns(transcript: string | null | undefined, callerName: string | null = null): Turn[] {
  const raw = String(transcript ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return [];
  const name = callerName?.trim().toLowerCase() || null;
  const first = name?.split(/\s+/)[0] ?? null;
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m = LABEL_RE.exec(line);
    const label = m?.[1].trim().toLowerCase() ?? null;
    let role: TurnRole | null = null;
    if (label) {
      if (AGENT_LABELS.has(label)) role = 'agent';
      else if (CALLER_LABELS.has(label) || label === name || label === first) role = 'caller';
    }
    if (role && m) turns.push({ index: turns.length, role, text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text = `${turns[turns.length - 1].text} ${line.trim()}`.trim();
    else turns.push({ index: 0, role: 'unknown', text: line.trim() });
  }
  return turns.filter((t) => t.text.length > 0).map((t, i) => ({ ...t, index: i }));
}

export const hasRoles = (turns: Turn[]) => turns.some((t) => t.role === 'agent') && turns.some((t) => t.role === 'caller');

/**
 * Compact, numbered transcript for the AI reviewer. The platform guardrail
 * truncates one message at 4000 chars, so we budget below that and always keep
 * the opening and the closing turns.
 */
export function buildReviewTranscript(turns: Turn[], budget = 3600): string {
  const fmt = (t: Turn, cap: number) => `[${t.index}] ${t.role === 'agent' ? 'AGENT' : t.role === 'caller' ? 'CALLER' : 'SPEAKER'}: ${t.text.slice(0, cap)}`;
  let cap = 320;
  let lines = turns.map((t) => fmt(t, cap));
  while (lines.join('\n').length > budget && cap > 60) {
    cap -= 40;
    lines = turns.map((t) => fmt(t, cap));
  }
  if (lines.join('\n').length > budget) {
    const head = lines.slice(0, 4);
    const tail: string[] = [];
    let used = head.join('\n').length;
    for (let i = lines.length - 1; i >= 4; i--) {
      if (used + lines[i].length + 1 > budget - 20) break;
      tail.unshift(lines[i]);
      used += lines[i].length + 1;
    }
    return [...head, '[…]', ...tail].join('\n');
  }
  return lines.join('\n');
}

/** True when `quote` really appears (normalised) inside the given turns' text. */
export function verifyEvidence(turns: Turn[], quote: string | null | undefined, roles: TurnRole[] = ['agent', 'caller', 'unknown']): boolean {
  const q = normalizeText(quote ?? '');
  if (q.length < FIX_LIMITS.minQuote) return false;
  return turns.some((t) => roles.includes(t.role) && normalizeText(t.text).includes(q));
}

export function turnIndexOfQuote(turns: Turn[], quote: string | null | undefined): number | null {
  const q = normalizeText(quote ?? '');
  if (!q) return null;
  const hit = turns.find((t) => normalizeText(t.text).includes(q));
  return hit ? hit.index : null;
}

// ---------------------------------------------------------------------------
// Compliance phrase checks
// ---------------------------------------------------------------------------

export type RuleType = 'required' | 'forbidden';
export type AppliesWhen = 'always' | 'emergency' | 'booking' | 'pricing';

export interface ComplianceRule {
  id: string;
  label: string;
  rule_type: RuleType;
  patterns: string[];
  applies_when: AppliesWhen;
  severity: Severity;
  script_instruction: string | null;
  enabled: boolean;
}

export interface CallContext { isEmergency: boolean; bookingDiscussed: boolean; pricingDiscussed: boolean }

export interface ComplianceResult {
  rule_id: string;
  label: string;
  status: 'pass' | 'fail' | 'na' | 'unknown';
  severity: Severity;
  turn_index: number | null;
  quote: string | null;
}

const PRICING_RX = /\$\s?\d|\b(price|prices|pricing|cost|costs|how much|estimate|quote|rate|rates|fee|fees|charge)\b/i;
const BOOKING_RX = /\b(book|booking|schedule|appointment|come out|send someone|technician|available|availability|slot)\b/i;

export function detectContext(turns: Turn[], facts: { is_emergency: boolean; booking_outcome: string | null; status: string | null }): CallContext {
  const all = turns.map((t) => t.text).join(' ');
  return {
    isEmergency: !!facts.is_emergency,
    bookingDiscussed: facts.booking_outcome === 'booked' || facts.status === 'booked' || BOOKING_RX.test(all),
    pricingDiscussed: PRICING_RX.test(all),
  };
}

/** Plain phrase list → safe: no regex is built from owner input. */
export function cleanPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  const out: string[] = [];
  for (const p of patterns) {
    const n = normalizeText(typeof p === 'string' ? p : '');
    if (n.length >= 3 && n.length <= 120 && !out.includes(n)) out.push(n);
    if (out.length >= 12) break;
  }
  return out;
}

function findPhrase(turns: Turn[], patterns: string[]): { turn: Turn; pattern: string } | null {
  const pats = cleanPatterns(patterns);
  for (const t of turns) {
    const padded = ` ${normalizeText(t.text)} `;
    for (const p of pats) if (padded.includes(` ${p} `)) return { turn: t, pattern: p };
  }
  return null;
}

function applies(when: AppliesWhen, ctx: CallContext): boolean {
  if (when === 'always') return true;
  if (when === 'emergency') return ctx.isEmergency;
  if (when === 'booking') return ctx.bookingDiscussed;
  return ctx.pricingDiscussed;
}

export function evaluateCompliance(turns: Turn[], ctx: CallContext, rules: ComplianceRule[]): ComplianceResult[] {
  const assessable = hasRoles(turns);
  const agentTurns = turns.filter((t) => t.role === 'agent');
  const results: ComplianceResult[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const base = { rule_id: r.id, label: r.label, severity: r.severity, turn_index: null, quote: null };
    if (!applies(r.applies_when, ctx)) { results.push({ ...base, status: 'na' }); continue; }
    if (!assessable) { results.push({ ...base, status: 'unknown' }); continue; }
    const hit = findPhrase(agentTurns, r.patterns);
    if (r.rule_type === 'required') {
      results.push(hit ? { ...base, status: 'pass', turn_index: hit.turn.index } : { ...base, status: 'fail' });
    } else {
      results.push(hit ? { ...base, status: 'fail', turn_index: hit.turn.index, quote: hit.turn.text.slice(0, FIX_LIMITS.quoteMax) } : { ...base, status: 'pass' });
    }
  }
  return results;
}

/** Defaults seeded per account (editable). Generic wording, not legal advice. */
export const DEFAULT_RULES: Omit<ComplianceRule, 'id' | 'enabled'>[] = [
  { label: 'Call recording notice', rule_type: 'required', patterns: ['may be recorded', 'being recorded', 'is recorded', 'recorded for quality'], applies_when: 'always', severity: 'medium', script_instruction: 'Early in every call, say that the call may be recorded for quality purposes.' },
  { label: 'AI disclosure', rule_type: 'required', patterns: ['ai assistant', 'virtual assistant', 'automated assistant', 'ai receptionist', 'digital assistant'], applies_when: 'always', severity: 'medium', script_instruction: 'Introduce yourself as the business\'s AI assistant at the start of the call.' },
  { label: 'Emergency safety advice', rule_type: 'required', patterns: ['911', 'emergency services', 'fire department', 'leave the house', 'leave the home', 'evacuate'], applies_when: 'emergency', severity: 'critical', script_instruction: 'For a gas smell, smoke, fire, sparking or carbon monoxide: tell the caller to leave the building and call 911 or emergency services BEFORE anything else.' },
  { label: 'No claiming to be human', rule_type: 'forbidden', patterns: ['i am a real person', 'im a real person', 'i am human', 'im a human', 'i am not a robot', 'im not a robot'], applies_when: 'always', severity: 'high', script_instruction: 'Never claim to be a human. If asked, say you are the business\'s AI assistant.' },
  { label: 'No guarantees', rule_type: 'forbidden', patterns: ['100 guaranteed', 'guaranteed to fix', 'i guarantee', 'we guarantee', 'no risk'], applies_when: 'always', severity: 'medium', script_instruction: 'Never promise guaranteed outcomes. Say the technician will assess and confirm on site.' },
];

// ---------------------------------------------------------------------------
// Findings (deterministic)
// ---------------------------------------------------------------------------

export interface FixProposal {
  type: FixType;
  /** kb_article */
  title?: string;
  question?: string;
  keywords?: string[];
  requires_answer?: boolean;
  target_article_id?: string | null;
  /** script_patch */
  scenario?: ScenarioKey;
  addition?: string;
  rationale?: string;
}

export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  evidence_quote: string | null;
  turn_index: number | null;
  fingerprint: string;
  rule_id?: string | null;
  fix?: FixProposal | null;
}

export interface CallFactsForQuality {
  is_emergency: boolean;
  status: string | null;
  intent: string | null;
  sentiment: string | null;
  call_score: number | null;
  lead_score: number | null;
  booking_outcome: string | null;
  missed_opportunity_reason: string | null;
  upsell_opportunities: string[] | null;
  price_accuracy_status: string | null;
  price_accuracy_details: unknown;
  feedback_rating: number | null;
}

const cents = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;

export function buildDeterministicFindings(
  facts: CallFactsForQuality,
  compliance: ComplianceResult[],
  rules: ComplianceRule[],
  scenario: ScenarioKey,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const byId = new Map(rules.map((r) => [r.id, r]));

  for (const c of compliance) {
    if (c.status !== 'fail') continue;
    const rule = byId.get(c.rule_id);
    const instr = sanitizeScriptText(rule?.script_instruction ?? '', FIX_LIMITS.additionMax);
    out.push({
      kind: 'compliance_miss',
      severity: c.severity,
      title: `${c.label}: ${rule?.rule_type === 'forbidden' ? 'forbidden phrase used' : 'required phrase missing'}`,
      detail: rule?.rule_type === 'forbidden' ? 'The assistant said something your rules forbid.' : 'None of the approved phrases were said by the assistant on this call.',
      evidence_quote: c.quote,
      turn_index: c.turn_index,
      fingerprint: `compliance:${c.rule_id}`,
      rule_id: c.rule_id,
      fix: instr.length >= 10 ? { type: 'script_patch', scenario, addition: instr, rationale: `Compliance rule "${c.label}" failed on a real call.` } : null,
    });
  }

  const details = Array.isArray(facts.price_accuracy_details) ? (facts.price_accuracy_details as Record<string, unknown>[]) : [];
  if (facts.price_accuracy_status === 'mismatch') {
    for (const d of details.slice(0, 3)) {
      const stated = typeof d.stated_cents === 'number' ? d.stated_cents : null;
      const match = d.closest_catalog_match as { service_name?: string; price_cents?: number } | null;
      out.push({
        kind: 'price_error',
        severity: 'high',
        title: stated !== null ? `Quoted ${cents(stated)} — not in your price book` : 'Quoted a price that is not in your price book',
        detail: match?.service_name && typeof match.price_cents === 'number' ? `Closest catalog item: ${match.service_name} at ${cents(match.price_cents)}.` : 'No catalog item matches the quoted amount.',
        evidence_quote: typeof d.context_snippet === 'string' ? d.context_snippet.slice(0, FIX_LIMITS.quoteMax) : null,
        turn_index: null,
        fingerprint: `price:${stated ?? 'x'}`,
        fix: { type: 'script_patch', scenario: 'price_quote', addition: 'Only quote prices that exist in the price book or knowledge base. If unsure, say the team will confirm the exact price.', rationale: 'The assistant stated a price that does not match the price book.' },
      });
    }
  }

  if (facts.booking_outcome === 'not_booked' && (facts.missed_opportunity_reason ?? '').trim()) {
    out.push({
      kind: 'missed_booking',
      severity: (facts.lead_score ?? 0) >= 70 ? 'high' : 'medium',
      title: 'Booking chance missed',
      detail: String(facts.missed_opportunity_reason).slice(0, FIX_LIMITS.detailMax),
      evidence_quote: null,
      turn_index: null,
      fingerprint: 'booking:missed',
      fix: { type: 'script_patch', scenario, addition: 'Before ending any call with a prospective customer, offer the next available appointment and ask if they would like it booked now.', rationale: 'The assistant ended a qualified call without securing a booking.' },
    });
  }

  for (const opp of (facts.upsell_opportunities ?? []).slice(0, 2)) {
    const o = String(opp).trim().slice(0, 80);
    if (!o) continue;
    out.push({
      kind: 'missed_upsell',
      severity: 'low',
      title: `Not offered: ${o}`,
      detail: 'The caller fit this add-on but it was never mentioned.',
      evidence_quote: null,
      turn_index: null,
      fingerprint: `upsell:${slug(o)}`,
      fix: { type: 'script_patch', scenario, addition: `When it fits the caller's need, briefly mention ${o} and ask if they would like it included.`, rationale: 'A relevant add-on was not offered on a real call.' },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI output validation
// ---------------------------------------------------------------------------

export interface AiReview {
  summary: string;
  findings: FindingDraft[];
  dropped: number;
}

const AI_KINDS: FindingKind[] = ['hallucination', 'knowledge_gap', 'missed_booking', 'missed_upsell'];
const MONEY_RX = /\$\s?\d|\d\s?(dollars|usd)\b/i;

function extractJson(text: string): unknown {
  const t = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } }
  return null;
}

/** Validates the reviewer's JSON. Anything unverifiable is dropped, never trusted. */
export function parseAiReview(text: string, turns: Turn[], fallbackScenario: ScenarioKey): AiReview | null {
  const raw = extractJson(text) as { summary?: unknown; findings?: unknown } | null;
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.findings) ? raw.findings.slice(0, FIX_LIMITS.maxFindings) : [];
  const findings: FindingDraft[] = [];
  let dropped = 0;

  for (const f of list as Record<string, unknown>[]) {
    const kind = f?.kind as FindingKind;
    const severity = (SEVERITIES as string[]).includes(String(f?.severity)) ? (f.severity as Severity) : 'medium';
    const title = sanitizeScriptText(String(f?.title ?? ''), FIX_LIMITS.titleMax);
    const detail = sanitizeScriptText(String(f?.detail ?? ''), FIX_LIMITS.detailMax);
    const quote = sanitizeScriptText(String(f?.evidence_quote ?? ''), FIX_LIMITS.quoteMax);
    if (!AI_KINDS.includes(kind) || !title) { dropped++; continue; }

    const needsEvidence = kind === 'hallucination' || kind === 'knowledge_gap';
    const roles: TurnRole[] = kind === 'knowledge_gap' ? ['caller', 'unknown'] : ['agent', 'unknown'];
    if (needsEvidence && !verifyEvidence(turns, quote, roles)) { dropped++; continue; }

    const fixRaw = (f.fix ?? null) as Record<string, unknown> | null;
    let fix: FixProposal | null = null;
    if (fixRaw && fixRaw.type === 'kb_article') {
      const ft = sanitizeScriptText(String(fixRaw.title ?? ''), FIX_LIMITS.titleMax);
      const question = sanitizeScriptText(String(fixRaw.question ?? ''), 200);
      if (ft && question) {
        const target = typeof fixRaw.target_article_id === 'string' && /^[0-9a-f-]{36}$/i.test(fixRaw.target_article_id) ? fixRaw.target_article_id : null;
        fix = {
          type: 'kb_article',
          title: ft,
          question,
          keywords: (Array.isArray(fixRaw.keywords) ? fixRaw.keywords : []).map((k) => sanitizeScriptText(String(k), 40)).filter(Boolean).slice(0, 8),
          requires_answer: true, // the AI never writes the fact itself
          target_article_id: target,
          rationale: sanitizeScriptText(String(fixRaw.rationale ?? ''), 200),
        };
      }
    } else if (fixRaw && fixRaw.type === 'script_patch') {
      const addition = sanitizeScriptText(String(fixRaw.addition ?? ''), FIX_LIMITS.additionMax);
      if (addition.length >= 10 && !MONEY_RX.test(addition)) {
        fix = {
          type: 'script_patch',
          scenario: isScenarioKey(fixRaw.scenario) ? fixRaw.scenario : fallbackScenario,
          addition,
          rationale: sanitizeScriptText(String(fixRaw.rationale ?? ''), 200),
        };
      }
    }

    findings.push({
      kind,
      severity,
      title,
      detail,
      evidence_quote: quote || null,
      turn_index: turnIndexOfQuote(turns, quote),
      fingerprint: kind === 'missed_booking' ? 'booking:missed' : `${kind}:${slug(kind === 'missed_upsell' ? title : quote || title)}`,
      fix,
    });
  }
  return { summary: sanitizeScriptText(String(raw.summary ?? ''), 300), findings, dropped };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export type Scores = Record<DimensionKey, number | null> & { overall: number | null };

const SEV_PENALTY: Record<Severity, number> = { low: 10, medium: 20, high: 35, critical: 50 };
const SEV_WEIGHT: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function computeScores(input: {
  facts: CallFactsForQuality;
  findings: Pick<FindingDraft, 'kind' | 'severity'>[];
  compliance: ComplianceResult[];
  aiOk: boolean;
}): Scores {
  const { facts, findings, compliance, aiOk } = input;

  const accuracyAssessed = aiOk || facts.price_accuracy_status === 'verified' || facts.price_accuracy_status === 'mismatch';
  let accuracy: number | null = null;
  if (accuracyAssessed) {
    const pen = findings.filter((f) => f.kind === 'hallucination' || f.kind === 'price_error').reduce((n, f) => n + SEV_PENALTY[f.severity], 0);
    accuracy = clamp(100 - pen, 0, 100);
  }

  const scored = compliance.filter((c) => c.status === 'pass' || c.status === 'fail');
  let compliance_: number | null = null;
  if (scored.length) {
    const total = scored.reduce((n, c) => n + SEV_WEIGHT[c.severity], 0);
    const failed = scored.filter((c) => c.status === 'fail').reduce((n, c) => n + SEV_WEIGHT[c.severity], 0);
    compliance_ = Math.round(100 * (1 - failed / total));
  }

  let booking: number | null = null;
  switch (facts.booking_outcome) {
    case 'booked': booking = 100; break;
    case 'already_scheduled': booking = 90; break;
    case 'not_booked': booking = (facts.missed_opportunity_reason ?? '').trim() ? 25 : 60; break;
    default: booking = null;
  }

  const opps = (facts.upsell_opportunities ?? []).length;
  let upsell: number | null = null;
  if (opps > 0) upsell = Math.max(20, 100 - 30 * opps);
  else if (facts.booking_outcome === 'booked') upsell = 100;

  const sentimentScore = facts.sentiment === 'positive' ? 90 : facts.sentiment === 'neutral' ? 65 : facts.sentiment === 'negative' ? 30 : null;
  const ratingScore = facts.feedback_rating && facts.feedback_rating >= 1 && facts.feedback_rating <= 5 ? ((facts.feedback_rating - 1) / 4) * 100 : null;
  let experience: number | null = null;
  if (ratingScore !== null) experience = Math.round(0.6 * ratingScore + 0.4 * (sentimentScore ?? ratingScore));
  else if (sentimentScore !== null) experience = facts.call_score !== null ? Math.round(0.5 * sentimentScore + 0.5 * facts.call_score) : sentimentScore;
  else if (facts.call_score !== null) experience = facts.call_score;

  const dims: Record<DimensionKey, number | null> = { accuracy, compliance: compliance_, booking, upsell, experience };
  let wSum = 0;
  let acc = 0;
  for (const k of DIMENSIONS) {
    const v = dims[k];
    if (v === null) continue;
    wSum += DIMENSION_WEIGHTS[k];
    acc += DIMENSION_WEIGHTS[k] * v;
  }
  return { ...dims, overall: wSum > 0 ? Math.round(acc / wSum) : null };
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export function gradeOf(score: number | null): Grade | null {
  if (score === null || !Number.isFinite(score)) return null;
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

/** Which calls the reviewer should look at: has a real transcript with both sides. */
export function isReviewable(transcript: string | null | undefined): boolean {
  const t = String(transcript ?? '');
  return t.trim().length >= 200 && hasRoles(splitTurns(t));
}

// ---------------------------------------------------------------------------
// Trend vs baseline
// ---------------------------------------------------------------------------

export interface ScoredPoint { at: string; overall: number | null; accuracy: number | null; compliance: number | null; booking: number | null; experience: number | null; upsell: number | null }
export interface TrendStat { current: number | null; baseline: number | null; delta: number | null; nCurrent: number; nBaseline: number; reliable: boolean; direction: 'up' | 'down' | 'flat' | null }
export type TrendKey = DimensionKey | 'overall';
export type Trend = Record<TrendKey, TrendStat>;

const DAY = 86_400_000;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Current window vs the baseline window right before it. A delta is only trusted when both have enough reviews. */
export function computeTrend(points: ScoredPoint[], now: number, windowDays = 14, baselineDays = 60): Trend {
  const curFrom = now - windowDays * DAY;
  const baseFrom = curFrom - baselineDays * DAY;
  const keys: TrendKey[] = ['overall', ...DIMENSIONS];
  const out = {} as Trend;
  for (const k of keys) {
    const cur: number[] = [];
    const base: number[] = [];
    for (const p of points) {
      const t = Date.parse(p.at);
      const v = p[k];
      if (Number.isNaN(t) || v === null || v === undefined) continue;
      if (t >= curFrom && t <= now) cur.push(v);
      else if (t >= baseFrom && t < curFrom) base.push(v);
    }
    const current = avg(cur);
    const baseline = avg(base);
    const reliable = cur.length >= MIN_TREND_SAMPLE && base.length >= MIN_TREND_SAMPLE;
    const delta = reliable && current !== null && baseline !== null ? Math.round((current - baseline) * 10) / 10 : null;
    out[k] = { current, baseline, delta, nCurrent: cur.length, nBaseline: base.length, reliable, direction: delta === null ? null : delta >= 2 ? 'up' : delta <= -2 ? 'down' : 'flat' };
  }
  return out;
}

export interface WeekPoint { start: number; avg: number | null; n: number }

/** Weekly (Monday, UTC) average of the overall score for the last `weeks` weeks; empty weeks stay as gaps. */
export function weeklySeries(points: ScoredPoint[], now: number, weeks = 12): WeekPoint[] {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const out: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = monday - i * 7 * DAY;
    const vals = points.filter((p) => p.overall !== null && Date.parse(p.at) >= start && Date.parse(p.at) < start + 7 * DAY).map((p) => p.overall as number);
    out.push({ start, avg: avg(vals), n: vals.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fix helpers
// ---------------------------------------------------------------------------

/** Mirrors apply_ai_quality_fix(): append guidance to the live script body within the 2500-char cap. */
export function mergeScriptAddition(currentBody: string, addition: string): { ok: true; body: string; changed: boolean } | { ok: false; error: string } {
  const add = sanitizeScriptText(addition, FIX_LIMITS.additionMax);
  if (add.length < 10) return { ok: false, error: 'The instruction is too short.' };
  const base = sanitizeScriptText(currentBody, SCRIPT_LIMITS.bodyMax);
  if (normalizeText(base).includes(normalizeText(add))) return { ok: true, body: base, changed: false };
  const body = base ? `${base}\n\n${add}` : add;
  if (body.length > SCRIPT_LIMITS.bodyMax) return { ok: false, error: `This script is full (${SCRIPT_LIMITS.bodyMax} characters). Shorten it in Call Scripts, then apply the fix.` };
  return { ok: true, body, changed: true };
}

/** Owner's answer for a KB fix → article fields. The answer is the only source of facts. */
export function buildKbArticle(proposal: Pick<FixProposal, 'title' | 'question' | 'keywords'>, answer: string): { ok: true; title: string; summary: string; body: string; keywords: string[] } | { ok: false; error: string } {
  const clean = sanitizeScriptText(answer, 1200);
  if (clean.length < 10) return { ok: false, error: 'Write the correct answer first (at least 10 characters).' };
  const title = sanitizeScriptText(proposal.title ?? proposal.question ?? '', FIX_LIMITS.titleMax);
  if (!title) return { ok: false, error: 'The article needs a title.' };
  const summary = clean.length <= 300 ? clean : `${clean.slice(0, 297).trimEnd()}…`;
  return { ok: true, title, summary, body: clean, keywords: (proposal.keywords ?? []).slice(0, 8) };
}

export const FIX_STATUS_LABELS = { proposed: 'Ready to apply', applied: 'Applied', rejected: 'Dismissed' } as const;
