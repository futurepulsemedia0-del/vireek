/**
 * Customer outcome proof kit - the documented ROI method. Pure: no network, no React, no Intl, no path aliases.
 * Documentation: docs/proof/roi-method.md   Server: supabase/migrations/20290309000000_outcome_proof_kit.sql
 *
 * The database selects which ledger events belong to a case (and why others are excluded) and freezes them with a hash.
 * This file does the arithmetic, re-verifies the hash, and decides whether a case may be shown as publishable.
 */

export const METHOD_VERSION = 'roi-method-v1';

/** Same threshold as supabase/functions/_shared/economics/roi.ts DEFAULT_ROI.minOutcomes. Kept in step by method.test.ts. */
export const MIN_MEASURED_EVENTS = 5;
/** A shorter window is too easy to cherry-pick. */
export const MIN_PERIOD_DAYS = 28;

export const NOT_AUDITED_NOTICE = 'Not independently audited.';

export type EventType = 'recovered_revenue' | 'saved_hours' | 'avoided_cost';
export type Confidence = 'measured' | 'estimated';
export type Exclusion = 'owner_review_not_due_to_vireek' | 'superseded_by_measured' | 'other_currency';
export type CostBasis = 'subscription_override' | 'owner_entered' | 'none';
export type VerificationLevel = 'not_independently_audited' | 'independently_verified';

export interface ProofSource {
  valueEventId: string;
  type: EventType;
  amount: number; // integer cents for money, integer minutes for saved_hours
  unit: 'cents' | 'minutes';
  currency: string | null;
  confidence: Confidence;
  evidenceRef: string;
  occurredMs: number;
  included: boolean;
  exclusion: Exclusion | null;
}

export interface ProofCase {
  id: string;
  title: string;
  periodStart: string; // YYYY-MM-DD, inclusive, UTC
  periodEnd: string; // YYYY-MM-DD, inclusive, UTC
  currency: string;
  costCents: number | null;
  costBasis: CostBasis;
  methodVersion: string;
  snapshotSha256: string;
  verificationLevel: VerificationLevel;
  verifierName: string | null;
  verificationEvidenceUrl: string | null;
  verifiedAt: string | null;
}

export interface ProofConsent {
  id: string;
  decision: 'granted' | 'revoked';
  allowBusinessName: boolean;
  allowPersonName: boolean;
  allowQuote: boolean;
  quoteText: string | null;
  signerName: string;
  signerRole: string | null;
  consentTextVersion: string;
  caseSha256: string;
  decidedAt: string;
}

/* ----------------------------------------------------------------------------------------------- sha256 (no WebCrypto) */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const d = input.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** SHA-256 of a UTF-8 string, lowercase hex. Synchronous and environment-independent (browser, Node, jsdom). */
export function sha256Hex(input: string): string {
  const msg = utf8(input);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6));
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/* ----------------------------------------------------------------------------------------------- canonical string + integrity */

const escapeRef = (s: string) => s.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/\n/g, '%0A').replace(/\r/g, '%0D');

/** Must produce exactly what public.outcome_case_canonical() produces. Sources are ordered by event id (plain string order). */
export function canonicalString(c: Pick<ProofCase, 'methodVersion' | 'periodStart' | 'periodEnd' | 'currency' | 'costCents' | 'costBasis'>, sources: readonly ProofSource[]): string {
  const sorted = [...sources].sort((a, b) => (a.valueEventId < b.valueEventId ? -1 : a.valueEventId > b.valueEventId ? 1 : 0));
  const lines = [
    c.methodVersion,
    `period|${c.periodStart}|${c.periodEnd}|${c.currency}`,
    `cost|${c.costCents === null ? '-' : String(c.costCents)}|${c.costBasis}`,
    ...sorted.map((s) =>
      `src|${s.valueEventId}|${s.type}|${s.amount}|${s.unit}|${s.currency ?? '-'}|${s.confidence}|${escapeRef(s.evidenceRef)}|${s.occurredMs}|${s.included ? '1' : '0'}|${s.exclusion ?? '-'}`),
  ];
  return lines.join('\n');
}

export const computeSnapshotHash = (c: Parameters<typeof canonicalString>[0], sources: readonly ProofSource[]): string => sha256Hex(canonicalString(c, sources));

export function verifyIntegrity(c: ProofCase, sources: readonly ProofSource[]): boolean {
  return computeSnapshotHash(c, sources) === c.snapshotSha256;
}

/* ----------------------------------------------------------------------------------------------- the arithmetic */

export interface Totals { count: number; measuredCents: number; estimatedCents: number; savedMinutes: number; measuredCount: number }
export interface ExcludedCounts { owner_review_not_due_to_vireek: number; superseded_by_measured: number; other_currency: number }

export type OutcomeResult =
  | { status: 'not_enough_data'; reasons: string[]; totals: Totals; excluded: ExcludedCounts; periodDays: number }
  | {
      status: 'ok'; totals: Totals; excluded: ExcludedCounts; periodDays: number;
      /** Measured value only. */ valueLowCents: number;
      /** Measured plus estimated value. */ valueHighCents: number;
      costCents: number;
      /** (valueLow - cost) / cost, as a ratio. Can be negative. */ roiLow: number;
      roiHigh: number;
    };

/** Inclusive day count between two YYYY-MM-DD dates (UTC). */
export function periodDays(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`), b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * roi-method-v1
 *  - Only sources the database marked `included` count. Nothing is re-selected here.
 *  - Money = recovered_revenue + avoided_cost, integer cents. Saved time is reported in minutes and is NOT converted to money.
 *  - Low = measured money only. High = measured + estimated money. A range, never a point estimate.
 *  - ROI = (value - cost) / cost, with cost = the period's subscription cost recorded on the case.
 *  - No number is produced if: cost is unknown, fewer than MIN_MEASURED_EVENTS measured money events, or period < MIN_PERIOD_DAYS.
 *  - No annualising, no extrapolation, no averaging across customers.
 */
export function computeOutcome(c: Pick<ProofCase, 'periodStart' | 'periodEnd' | 'costCents' | 'currency'>, sources: readonly ProofSource[]): OutcomeResult {
  const excluded: ExcludedCounts = { owner_review_not_due_to_vireek: 0, superseded_by_measured: 0, other_currency: 0 };
  const totals: Totals = { count: 0, measuredCents: 0, estimatedCents: 0, savedMinutes: 0, measuredCount: 0 };
  for (const s of sources) {
    if (!s.included) { if (s.exclusion) excluded[s.exclusion]++; continue; }
    if (!Number.isSafeInteger(s.amount) || s.amount <= 0) continue; // defensive: the DB CHECK already forbids this
    totals.count++;
    if (s.type === 'saved_hours') { totals.savedMinutes += s.amount; continue; }
    if (s.unit !== 'cents' || s.currency !== c.currency) continue; // defensive: the DB excludes other currencies
    if (s.confidence === 'measured') { totals.measuredCents += s.amount; totals.measuredCount++; } else totals.estimatedCents += s.amount;
  }
  const days = periodDays(c.periodStart, c.periodEnd);
  const reasons: string[] = [];
  if (c.costCents === null || !(c.costCents > 0)) reasons.push('cost_unknown');
  if (totals.measuredCount < MIN_MEASURED_EVENTS) reasons.push(`measured_events_below_${MIN_MEASURED_EVENTS}`);
  if (days < MIN_PERIOD_DAYS) reasons.push(`period_below_${MIN_PERIOD_DAYS}_days`);
  if (reasons.length > 0 || c.costCents === null) return { status: 'not_enough_data', reasons, totals, excluded, periodDays: days };
  const low = totals.measuredCents, high = totals.measuredCents + totals.estimatedCents, cost = c.costCents;
  return { status: 'ok', totals, excluded, periodDays: days, valueLowCents: low, valueHighCents: high, costCents: cost, roiLow: (low - cost) / cost, roiHigh: (high - cost) / cost };
}

/* ----------------------------------------------------------------------------------------------- consent and publication gate */

/** The newest decision wins. Ties on timestamp fall back to the later array position (callers pass rows in insertion order). */
export function currentConsent(consents: readonly ProofConsent[]): ProofConsent | null {
  let best: ProofConsent | null = null;
  for (const c of consents) {
    if (best === null || Date.parse(c.decidedAt) >= Date.parse(best.decidedAt)) best = c;
  }
  return best;
}

export type PublicationBlock = 'no_consent' | 'consent_revoked' | 'consent_for_other_snapshot' | 'integrity_check_failed' | 'not_enough_data';
export interface PublicationGate { mayPublish: boolean; blocks: PublicationBlock[]; consent: ProofConsent | null }

/**
 * A case may be shown outside the account only when ALL hold: the newest consent is "granted", it was given for this exact
 * snapshot hash, the sources still hash to that snapshot, and the method produced a number.
 * This is a process control for exports made from this app. It is not a technical barrier against copying numbers by hand.
 */
export function publicationGate(c: ProofCase, sources: readonly ProofSource[], consents: readonly ProofConsent[], outcome: OutcomeResult): PublicationGate {
  const consent = currentConsent(consents);
  const blocks: PublicationBlock[] = [];
  if (consent === null) blocks.push('no_consent');
  else if (consent.decision === 'revoked') blocks.push('consent_revoked');
  else if (consent.caseSha256 !== c.snapshotSha256) blocks.push('consent_for_other_snapshot');
  if (!verifyIntegrity(c, sources)) blocks.push('integrity_check_failed');
  if (outcome.status !== 'ok') blocks.push('not_enough_data');
  return { mayPublish: blocks.length === 0, blocks, consent };
}

/** The sentence every output must carry. Only a recorded verifier (name + evidence link + date) changes it. */
export function verificationNotice(c: Pick<ProofCase, 'verificationLevel' | 'verifierName' | 'verificationEvidenceUrl' | 'verifiedAt'>): string {
  if (c.verificationLevel === 'independently_verified' && c.verifierName && c.verificationEvidenceUrl && c.verifiedAt) {
    return `Independently verified by ${c.verifierName} on ${c.verifiedAt.slice(0, 10)}. Evidence: ${c.verificationEvidenceUrl}`;
  }
  return NOT_AUDITED_NOTICE;
}
