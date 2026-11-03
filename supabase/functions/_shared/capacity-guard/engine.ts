// supabase/functions/_shared/capacity-guard/engine.ts
//
// Pure, dependency-free decision logic for Capacity Guard (no Deno / Supabase imports, so Vitest runs it directly).
// Everything here is deterministic given its inputs; randomness only exists in simulate*() and is seeded.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ types
export interface TradeRule { trade: string; hold_share_pct: number; skill?: string }

export interface FreeSlot {
  technicianId: string;
  start: number;
  end: number;
  dayKey: string;
  /** Higher = better fit (taken from the capacity engine's slot score). */
  score: number;
  /** Trade this slot was generated for (a slot can appear under several trades; first rule wins). */
  trade: string;
}

export interface HoldDraft { technicianId: string; start: number; end: number; trade: string; dayKey: string; demandProbability: number }

export interface ActiveHold {
  id: string;
  kind: 'value' | 'campaign';
  technicianId: string;
  trade: string | null;
  start: number;
  end: number;
  dayKey: string;
  reservationId: string | null;
}

// ------------------------------------------------------------------ math
/** P(N >= k) for N ~ Poisson(lambda). k <= 0 => 1. */
export function poissonTail(lambda: number, k: number): number {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) { term *= lambda / i; cdf += term; }
  return Math.min(1, Math.max(0, 1 - cdf));
}

export function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

// ------------------------------------------------------------------ high-value classification
export interface HighValueInput { serviceType: string | null; isEmergency: boolean; isVip: boolean; hasAgreement: boolean }

/** Replacement / emergency / VIP / agreement work may consume value holds; everything else may not. */
export function isHighValueRequest(req: HighValueInput, rules: TradeRule[]): boolean {
  if (req.isEmergency || req.isVip || req.hasAgreement) return true;
  const s = (req.serviceType ?? '').toLowerCase();
  if (!s) return false;
  return rules.some((r) => {
    const t = r.trade.trim().toLowerCase();
    return t.length > 0 && (s.includes(t) || s.includes(t.replace(/_/g, ' ')));
  });
}

// ------------------------------------------------------------------ value holds
export interface PlanInput {
  freeSlots: FreeSlot[];
  rules: TradeRule[];
  globalSharePct: number;
  /** Expected high-value requests per day, per trade key (from history), already weather/surge adjusted. */
  demandPerDay: Record<string, number>;
  now: number;
  minReleaseProbability: number;
  /** Never hold more than (free - this) slots on a day, so the public board never goes dark by our hand. */
  minPublicSlotsPerDay?: number;
  /** Slots already held (active) so the plan is idempotent. */
  existing: ActiveHold[];
}

/** Which holds to place now. Never overlaps an existing hold or another draft on the same technician. */
export function planValueHolds(input: PlanInput): HoldDraft[] {
  const minPublic = input.minPublicSlotsPerDay ?? 1;
  const byDay = new Map<string, FreeSlot[]>();
  for (const s of input.freeSlots) {
    if (s.start <= input.now) continue;
    const arr = byDay.get(s.dayKey) ?? [];
    arr.push(s);
    byDay.set(s.dayKey, arr);
  }
  const taken: { tech: string; start: number; end: number }[] = input.existing.map((h) => ({ tech: h.technicianId, start: h.start, end: h.end }));
  const overlaps = (t: string, a: number, b: number) => taken.some((x) => x.tech === t && a < x.end && b > x.start);
  const out: HoldDraft[] = [];

  for (const [dayKey, daySlots] of [...byDay.entries()].sort()) {
    // Capacity unit = distinct non-overlapping technician slots; use the greedy count per technician.
    const freeUnits = countUnits(daySlots);
    const alreadyHeld = input.existing.filter((h) => h.kind === 'value' && h.dayKey === dayKey).length;
    const tradeKeys = [...new Set(daySlots.map((s) => s.trade))];
    for (const trade of tradeKeys) {
      const rule = input.rules.find((r) => r.trade === trade);
      const share = (rule ? rule.hold_share_pct : input.globalSharePct) / 100;
      const target = Math.round(freeUnits * share);
      const have = input.existing.filter((h) => h.kind === 'value' && h.dayKey === dayKey && h.trade === trade).length;
      let need = target - have;
      need = Math.min(need, freeUnits - alreadyHeld - out.filter((d) => d.dayKey === dayKey).length - minPublic);
      if (need <= 0) continue;
      const lambdaDay = input.demandPerDay[trade] ?? 0;
      const candidates = daySlots.filter((s) => s.trade === trade).sort((a, b) => b.score - a.score || a.start - b.start);
      for (const s of candidates) {
        if (need <= 0) break;
        if (overlaps(s.technicianId, s.start, s.end)) continue;
        const k = have + out.filter((d) => d.dayKey === dayKey && d.trade === trade).length + 1;
        const p = poissonTail(remainingLambda(lambdaDay, s.start - input.now), k);
        if (p < input.minReleaseProbability) continue; // would be released immediately: do not place it at all
        out.push({ technicianId: s.technicianId, start: s.start, end: s.end, trade, dayKey, demandProbability: round4(p) });
        taken.push({ tech: s.technicianId, start: s.start, end: s.end });
        need -= 1;
      }
    }
  }
  return out;
}

function countUnits(slots: FreeSlot[]): number {
  const byTech = new Map<string, FreeSlot[]>();
  for (const s of slots) { const a = byTech.get(s.technicianId) ?? []; a.push(s); byTech.set(s.technicianId, a); }
  let n = 0;
  for (const arr of byTech.values()) {
    arr.sort((a, b) => a.end - b.end);
    let cursor = -Infinity;
    for (const s of arr) if (s.start >= cursor) { n += 1; cursor = s.end; }
  }
  return n;
}

/** Demand that can still arrive before the slot starts. Requests for a day arrive over the ~72h before it. */
export function remainingLambda(lambdaPerDay: number, msUntil: number, lookaheadMs = 3 * DAY_MS): number {
  if (msUntil <= 0 || !(lambdaPerDay > 0)) return 0;
  return lambdaPerDay * Math.min(1, msUntil / lookaheadMs);
}

export interface ReleaseDecision { id: string; reason: 'slot_passed' | 'demand_fell' | 'weather_surge_cleared' | 'campaign_shortfall' | 'campaign_window_over' }

/**
 * Value holds on a (day, trade) are ranked by start time; the k-th hold survives only while
 * P(at least k high-value requests still arrive before it) >= minReleaseProbability.
 */
export function valueHoldsToRelease(holds: ActiveHold[], demandPerDay: Record<string, number>, now: number, minP: number): ReleaseDecision[] {
  const out: ReleaseDecision[] = [];
  const groups = new Map<string, ActiveHold[]>();
  for (const h of holds) {
    if (h.kind !== 'value') continue;
    if (h.start <= now) { out.push({ id: h.id, reason: 'slot_passed' }); continue; }
    const key = `${h.dayKey}|${h.trade ?? ''}`;
    const arr = groups.get(key) ?? [];
    arr.push(h);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.start - b.start);
    // Evaluate from the latest hold backwards: the latest hold needs the most demand (k = count).
    arr.forEach((h, idx) => {
      const k = idx + 1;
      const lambda = remainingLambda(demandPerDay[h.trade ?? ''] ?? 0, arr[0].start - now);
      if (poissonTail(lambda, k) < minP) out.push({ id: h.id, reason: 'demand_fell' });
    });
  }
  return out;
}

// ------------------------------------------------------------------ weather / surge
export interface DemandAdjust { weatherSurge: boolean; regionalSurgeFactor: number | null }
/** Multiplier on expected high-value demand. Bounded so one noisy input can never starve or flood the board. */
export function demandMultiplier(a: DemandAdjust): number {
  let m = 1;
  if (a.weatherSurge) m *= 1.5;
  if (a.regionalSurgeFactor != null && Number.isFinite(a.regionalSurgeFactor)) m *= clamp(a.regionalSurgeFactor, 0.5, 2);
  return clamp(m, 0.5, 3);
}

// ------------------------------------------------------------------ campaign reservations
export interface ResponseCurve { shares: number[]; responseRate: number; source: 'history' | 'default' }

export const DEFAULT_CURVE_SHARES = [0.3, 0.25, 0.15, 0.1, 0.08, 0.06, 0.06]; // day 0..6, sums to 1.00

/** history[i] = observed responses per day-offset for one finished campaign with `audience` recipients. */
export function learnResponseCurve(history: { audience: number; perDay: number[] }[], fallbackRate: number): ResponseCurve {
  const usable = history.filter((h) => h.audience > 0 && h.perDay.reduce((a, b) => a + b, 0) > 0);
  if (usable.length < 2) return { shares: DEFAULT_CURVE_SHARES, responseRate: fallbackRate, source: 'default' };
  const len = Math.min(14, Math.max(...usable.map((h) => h.perDay.length)));
  const sums = new Array<number>(len).fill(0);
  let responses = 0, audience = 0;
  for (const h of usable) {
    audience += h.audience;
    for (let i = 0; i < len; i++) { const v = h.perDay[i] ?? 0; sums[i] += v; responses += v; }
  }
  return { shares: sums.map((s) => s / responses), responseRate: responses / audience, source: 'history' };
}

export interface CampaignSizingInput {
  audience: number;
  curve: ResponseCurve;
  /** Share of responses that end up wanting a booking in the window (conservative default: 0.4). */
  bookingConversion: number;
  freeUnitsByDay: { dayKey: string; units: number; alreadyHeld: number }[];
  maxSharePct: number;
}
export interface CampaignDayHold { dayKey: string; holds: number; expectedBookings: number }

/** Holds per day = ceil(expected bookings that day), capped at maxSharePct of that day's free units. */
export function sizeCampaignHolds(i: CampaignSizingInput): { expectedResponses: number; perDay: CampaignDayHold[] } {
  const expectedResponses = i.audience * i.curve.responseRate;
  const perDay = i.freeUnitsByDay.map((d, idx) => {
    const share = i.curve.shares[idx] ?? 0;
    const expectedBookings = expectedResponses * share * i.bookingConversion;
    const cap = Math.floor((i.maxSharePct / 100) * d.units) - d.alreadyHeld;
    return { dayKey: d.dayKey, expectedBookings: round4(expectedBookings), holds: Math.max(0, Math.min(Math.ceil(expectedBookings - 1e-9), cap)) };
  });
  return { expectedResponses: round4(expectedResponses), perDay };
}

export interface CampaignProgress { expectedResponses: number; shares: number[]; windowStart: number; windowEnd: number; observed: number; graceMs: number }

/** Fraction (0..1) of the remaining campaign holds to KEEP. 0 once the window is over. */
export function campaignKeepFraction(p: CampaignProgress, now: number): { keep: number; reason: ReleaseDecision['reason'] | null } {
  if (now >= p.windowEnd + p.graceMs) return { keep: 0, reason: 'campaign_window_over' };
  const elapsedDays = (now - p.windowStart) / DAY_MS;
  if (elapsedDays < 1) return { keep: 1, reason: null }; // too early to judge
  let expectedSoFar = 0;
  for (let d = 0; d < Math.floor(elapsedDays); d++) expectedSoFar += p.expectedResponses * (p.shares[d] ?? 0);
  if (expectedSoFar < 3) return { keep: 1, reason: null }; // too few expected responses to judge a shortfall
  const ratio = clamp(p.observed / expectedSoFar, 0, 1);
  return ratio >= 0.5 ? { keep: 1, reason: null } : { keep: ratio * 2, reason: 'campaign_shortfall' };
}

/** Pick which campaign holds to release: latest slots first, so the nearest ones stay protected the longest. */
export function campaignHoldsToRelease(holds: ActiveHold[], keepFraction: number, reason: ReleaseDecision['reason'], now: number): ReleaseDecision[] {
  const mine = holds.filter((h) => h.kind === 'campaign').sort((a, b) => a.start - b.start);
  const out: ReleaseDecision[] = [];
  const stale = mine.filter((h) => h.start <= now);
  for (const h of stale) out.push({ id: h.id, reason: 'slot_passed' });
  const live = mine.filter((h) => h.start > now);
  const keepN = Math.ceil(live.length * clamp(keepFraction, 0, 1));
  for (const h of live.slice(keepN)) out.push({ id: h.id, reason });
  return out;
}

// ------------------------------------------------------------------ backfill candidates
export type CandidateType = 'waitlist' | 'open_estimate' | 'same_area' | 'agreement_due' | 'missed_call';

export interface Candidate {
  type: CandidateType;
  ref: string;
  customerId: string | null;
  name: string;
  phoneNorm: string | null;
  estValueCents: number;
  /** km from the gap's technician/previous job; null = unknown. */
  distanceKm: number | null;
  ageDays: number;
  waitlistPriority?: number;
  marketingOptIn: boolean;
  prefsAllowSms: boolean;
  prefsAllowMarketing: boolean;
  prefsAllowReminders: boolean;
  sentLast24h: number;
  sentLast7d: number;
}

const TYPE_WEIGHT: Record<CandidateType, number> = { waitlist: 100, open_estimate: 80, agreement_due: 70, missed_call: 55, same_area: 40 };

export function scoreCandidate(c: Candidate): number {
  let s = TYPE_WEIGHT[c.type];
  s += Math.log1p(Math.max(0, c.estValueCents) / 100) * 4;
  if (c.distanceKm != null) s += clamp(15 - c.distanceKm, 0, 15) * 0.8;
  s -= Math.min(c.ageDays, 60) * 0.15; // stale intent decays
  if (c.type === 'waitlist') s += (c.waitlistPriority ?? 0) * 2;
  return round3(s);
}

/** Rank, one candidate per phone (best score wins), stable order. */
export function rankCandidates(cs: Candidate[]): (Candidate & { score: number; rank: number })[] {
  const best = new Map<string, Candidate & { score: number }>();
  for (const c of cs) {
    if (!c.phoneNorm) continue;
    const scored = { ...c, score: scoreCandidate(c) };
    const prev = best.get(c.phoneNorm);
    if (!prev || scored.score > prev.score) best.set(c.phoneNorm, scored);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).map((c, i) => ({ ...c, rank: i + 1 }));
}

export type Purpose = 'service' | 'marketing';
export function purposeFor(t: CandidateType): Purpose { return t === 'waitlist' || t === 'agreement_due' ? 'service' : 'marketing'; }

export interface Caps { max24h: number; max7d: number }
export type Eligibility = { ok: true; purpose: Purpose } | { ok: false; reason: 'no_phone' | 'sms_opted_out' | 'marketing_not_consented' | 'category_opted_out' | 'cap_24h' | 'cap_7d' };

/**
 * Pre-send gate for the parts we own. DNC list, A2P approval and quiet hours are enforced afterwards by the
 * existing sendCompliantSms() — this function never replaces them.
 * Marketing-purpose offers (open estimate, same-area, missed-call) need explicit marketing opt-in; an inbound call
 * or an old estimate is NOT consent to promotional texts.
 */
export function checkEligibility(c: Candidate, caps: Caps): Eligibility {
  if (!c.phoneNorm) return { ok: false, reason: 'no_phone' };
  if (!c.prefsAllowSms) return { ok: false, reason: 'sms_opted_out' };
  const purpose = purposeFor(c.type);
  if (purpose === 'marketing') {
    if (!c.marketingOptIn) return { ok: false, reason: 'marketing_not_consented' };
    if (!c.prefsAllowMarketing) return { ok: false, reason: 'category_opted_out' };
  } else if (c.type === 'agreement_due' && !c.prefsAllowReminders) {
    return { ok: false, reason: 'category_opted_out' };
  }
  if (c.sentLast24h >= caps.max24h) return { ok: false, reason: 'cap_24h' };
  if (c.sentLast7d >= caps.max7d) return { ok: false, reason: 'cap_7d' };
  return { ok: true, purpose };
}

// ------------------------------------------------------------------ simulation (always labelled SIMULATED)
export interface SimGap { id: string; valueCents: number; leadMinutes: number; pool: Candidate[] }
export interface SimOptions { caps: Caps; ttlMinutes: number; batchSize: number; claimRate: Record<CandidateType, number>; seed: number }

export const DEFAULT_CLAIM_RATE: Record<CandidateType, number> = { waitlist: 0.35, open_estimate: 0.12, agreement_due: 0.15, missed_call: 0.08, same_area: 0.04 };

export interface SimResult {
  simulated: true;
  gaps: number;
  filled: number;
  winRate: number;
  recoveredCents: number;
  blocked: Record<string, number>;
  assumptions: string;
}

/** Seeded RNG (mulberry32) so a simulation is reproducible and testable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Replays historical gaps through the same ranking + eligibility rules the live system uses.
 * The claim probabilities are PRIORS, not measured values, and the candidate pools are reconstructed from today's
 * data — so the output is an estimate of lift, never a promise. The caller must label it "simulated".
 */
export function simulateBackfill(gaps: SimGap[], o: SimOptions): SimResult {
  const rand = rng(o.seed);
  const blocked: Record<string, number> = {};
  const used24h = new Map<string, number>();
  let filled = 0, recovered = 0;
  for (const g of gaps) {
    const eligible: ReturnType<typeof rankCandidates> = [];
    for (const c of rankCandidates(g.pool)) {
      const sentInSim = used24h.get(c.phoneNorm ?? '') ?? 0;
      const e = checkEligibility({ ...c, sentLast24h: c.sentLast24h + sentInSim }, o.caps);
      if (!e.ok) { blocked[e.reason] = (blocked[e.reason] ?? 0) + 1; continue; }
      eligible.push(c);
    }
    // Rounds: each round offers `batchSize` candidates for ttlMinutes, until the lead time runs out.
    let t = 0, i = 0, won = false;
    while (!won && i < eligible.length && t + o.ttlMinutes <= g.leadMinutes) {
      const batch = eligible.slice(i, i + o.batchSize);
      i += o.batchSize;
      for (const c of batch) {
        used24h.set(c.phoneNorm ?? '', (used24h.get(c.phoneNorm ?? '') ?? 0) + 1);
        if (rand() < o.claimRate[c.type]) { won = true; recovered += c.estValueCents || g.valueCents; break; }
      }
      t += o.ttlMinutes;
    }
    if (won) filled += 1;
  }
  return {
    simulated: true, gaps: gaps.length, filled, winRate: gaps.length ? round4(filled / gaps.length) : 0, recoveredCents: recovered, blocked,
    assumptions: 'SIMULATED: claim probabilities are configurable priors, candidate pools are rebuilt from current data, one offer round per TTL.',
  };
}

export interface HoldReplayDay { dayKey: string; trade: string; freeUnits: number; highValueArrivals: number; avgValueCents: number }
export interface HoldReplayResult { simulated: true; held: number; used: number; releasedUnused: number; protectedCents: number; assumptions: string }

/** "What would have happened last week": held vs used per day/trade using the REAL high-value arrivals of that week. */
export function simulateHolds(days: HoldReplayDay[], sharePctByTrade: (trade: string) => number): HoldReplayResult {
  let held = 0, used = 0, protectedCents = 0;
  for (const d of days) {
    const h = Math.round(d.freeUnits * sharePctByTrade(d.trade) / 100);
    const u = Math.min(h, d.highValueArrivals);
    held += h; used += u; protectedCents += u * d.avgValueCents;
  }
  return { simulated: true, held, used, releasedUnused: held - used, protectedCents, assumptions: 'SIMULATED: uses real high-value arrivals from the replayed week; ignores the probabilistic early release (conservative for "used").' };
}

// ------------------------------------------------------------------ misc
export function round3(n: number): number { return Math.round(n * 1000) / 1000; }
export function round4(n: number): number { return Math.round(n * 10000) / 10000; }

/** SHA-256 hex of the claim token (the plain token only ever exists in the SMS). */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 192-bit URL-safe token. */
export function newClaimToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ------------------------------------------------------------------ booking-path integration (pure)
export interface HoldRow { id: string; kind: 'value' | 'campaign'; technicianId: string; start: number; end: number; shadow: boolean }
export interface BookingFlags { highValue: boolean; campaignAttributed: boolean }

/**
 * Which active holds make a slot unavailable for THIS request.
 * - shadow holds never block (they only feed the "what would have happened" view)
 * - value holds are usable by high-value requests (emergency / VIP / agreement / replacement trades)
 * - campaign holds are usable by campaign-attributed requests (ref code / campaign landing page / AI receptionist)
 */
export function selectBlockingHolds(holds: HoldRow[], f: BookingFlags): HoldRow[] {
  return holds.filter((h) => !h.shadow && !(h.kind === 'value' && f.highValue) && !(h.kind === 'campaign' && f.campaignAttributed));
}
