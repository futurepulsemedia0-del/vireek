// Pure sampling logic for human review of AI calls. No I/O: shared by the edge function and tests.
// Deterministic: the same call + version always yields the same draw, so cron re-runs never change picks.

export const SAMPLING_VERSION = 'v1';

export type RiskFlag = 'emergency' | 'price_mismatch' | 'complaint' | 'price_quote' | 'human_transfer';
export const RISK_FLAGS: readonly RiskFlag[] = ['emergency', 'price_mismatch', 'complaint', 'price_quote', 'human_transfer'];

export const FLAG_PRIORITY: Record<RiskFlag, number> = {
  emergency: 100, price_mismatch: 100, complaint: 60, price_quote: 40, human_transfer: 30,
};
export const RANDOM_PRIORITY = 10;

export type RiskRates = Record<RiskFlag, number>;
export const DEFAULT_RISK_RATES: RiskRates = { emergency: 1, price_mismatch: 1, complaint: 0.5, price_quote: 0.25, human_transfer: 0.25 };

export interface CandidateCall {
  id: string;
  call_datetime: string;
  is_emergency: boolean | null;
  sentiment: string | null;
  tags: string[] | null;
  intent: string | null;
  price_lookups_performed: number | null;
  price_accuracy_status: string | null;
  human_transfer_requested: boolean | null;
}

export interface SamplingOptions { randomRate: number; riskRates: Partial<RiskRates>; remainingCap: number }
export interface Pick { callId: string; callAt: string; stratum: 'random' | 'risk'; riskFlags: RiskFlag[]; priority: number }

const NEGATIVE_SENTIMENT = new Set(['negative', 'frustrated', 'angry']);

export function classifyRisk(c: CandidateCall): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (c.is_emergency === true) flags.push('emergency');
  const status = c.price_accuracy_status ?? '';
  if (status === 'mismatch') flags.push('price_mismatch');
  if ((c.price_lookups_performed ?? 0) > 0 || status === 'verified' || status === 'unverified' || status === 'mismatch') flags.push('price_quote');
  const tags = (c.tags ?? []).map((t) => t.toLowerCase());
  if (NEGATIVE_SENTIMENT.has((c.sentiment ?? '').toLowerCase()) || tags.includes('complaint') || /complain/i.test(c.intent ?? '')) flags.push('complaint');
  if (c.human_transfer_requested === true) flags.push('human_transfer');
  return flags;
}

/** FNV-1a + murmur3 finalizer -> uniform-ish number in [0, 1). */
export function unitHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function clampRate(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Two independent draws per call:
 *  - random draw over ALL calls (rate = randomRate): unbiased baseline, stratum 'random'.
 *  - risk draw over flagged calls (rate = max rate among its flags): stratum 'risk'.
 * A call hit by both is 'random' so the random stratum stays an unbiased estimate of overall quality.
 * Picks are ranked by priority then by hash and cut to remainingCap.
 */
export function sampleCalls(calls: CandidateCall[], opts: SamplingOptions): Pick[] {
  const randomRate = clampRate(opts.randomRate, 0);
  const cap = Math.max(0, Math.floor(opts.remainingCap));
  if (cap === 0) return [];
  const picks: (Pick & { u: number })[] = [];
  for (const c of calls) {
    const flags = classifyRisk(c);
    const uRandom = unitHash(`${c.id}|r|${SAMPLING_VERSION}`);
    const uRisk = unitHash(`${c.id}|k|${SAMPLING_VERSION}`);
    const riskRate = flags.reduce((m, f) => Math.max(m, clampRate(opts.riskRates[f], DEFAULT_RISK_RATES[f])), 0);
    const hitRandom = uRandom < randomRate;
    const hitRisk = flags.length > 0 && uRisk < riskRate;
    if (!hitRandom && !hitRisk) continue;
    const priority = flags.length ? Math.max(...flags.map((f) => FLAG_PRIORITY[f])) : RANDOM_PRIORITY;
    picks.push({ callId: c.id, callAt: c.call_datetime, stratum: hitRandom ? 'random' : 'risk', riskFlags: flags, priority, u: hitRandom ? uRandom : uRisk });
  }
  picks.sort((a, b) => b.priority - a.priority || a.u - b.u || a.callId.localeCompare(b.callId));
  return picks.slice(0, cap).map(({ u: _u, ...p }) => p);
}
