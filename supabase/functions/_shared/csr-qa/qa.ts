// supabase/functions/_shared/csr-qa/qa.ts
//
// Human CSR QA — pure, deterministic rubric ("rules_v1"). It is a HEURISTIC first pass: every score carries the
// evidence turn(s) it came from so a reviewer can verify it, and nothing here is a verdict on a person.
// POLICY: scores are coaching input. They must not be used for discipline unless a human has reviewed the call
// (enforced in the database: csr_qa_reviews.status = 'human_reviewed').

import { splitTurns, hasRoles, computeTrend, type Turn, type ScoredPoint } from "../call-quality/logic.ts";

export const QA_RUBRIC_VERSION = "rules_v1";
export const QA_DIMENSIONS = ["greeting", "discovery", "booking_ask", "price_handling", "empathy", "compliance"] as const;
export type QaDimension = (typeof QA_DIMENSIONS)[number];
export const QA_WEIGHTS: Record<QaDimension, number> = { greeting: 0.1, discovery: 0.2, booking_ask: 0.2, price_handling: 0.15, empathy: 0.15, compliance: 0.2 };
export const MIN_AGENT_SAMPLE = 5; // below this no per-agent number is shown

const RX = {
  greeting: /\b(thanks? for calling|thank you for calling|good (morning|afternoon|evening)|hello|hi there|this is \w+)/i,
  intro: /\b(this is|my name is|you'?re speaking with|i'?m)\s+\w+/i,
  booking: /\b(schedule|book(ed|ing)?|appointment|come out|send (someone|a tech\w*)|available (at|on|tomorrow|today)|next (available|opening)|what time works)\b/i,
  priceAsk: /\b(how much|price|pricing|cost|quote|estimate|rate|fee|charge)\b/i,
  moneyFigure: /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i,
  estimateLanguage: /\b(estimate|depends|after (we|the tech)|inspect|diagnos|price book|starting at|on[- ]site|visit)\b/i,
  distress: /\b(frustrat\w*|angry|upset|worried|scared|emergency|no (heat|water|power|ac)|flood\w*|stressful|terrible|awful|can'?t believe|third time)\b/i,
  empathy: /\b(sorry|understand|that (sounds|must be)|i hear you|appreciate your patience|let'?s get (this|that) (sorted|fixed)|i can imagine)\b/i,
  consent: /\b(call (is|may be|will be) (being )?recorded|recording|recorded (for|line)|consent to (the )?record)/i,
  forbiddenClaim: /\b(i guarantee|we guarantee|i promise|100% (sure|guaranteed)|definitely (cost|be))\b/i,
};

export interface QaEvidence { startTurn: number; endTurn: number; note: "strength" | "improve" }
export interface QaDimensionScore { dimension: QaDimension; score: number | null; evidence: QaEvidence[] }
export interface QaResult {
  rubric: string;
  scores: Record<QaDimension, number | null>;
  overall: number | null;
  clips: (QaEvidence & { dimension: QaDimension })[];
  coaching: QaCoachKey[];
  reviewable: boolean;
}
export type QaCoachKey =
  | "greet_with_name" | "ask_more_discovery_questions" | "ask_for_the_booking" | "route_price_to_estimate" | "acknowledge_feelings" | "state_recording_notice" | "avoid_guarantees";

export interface QaContext { recordingNoticeRequired: boolean }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const agentTurns = (t: Turn[]) => t.filter((x) => x.role === "agent");

function scoreGreeting(turns: Turn[]): QaDimensionScore {
  const first = agentTurns(turns)[0];
  if (!first) return { dimension: "greeting", score: null, evidence: [] };
  const hasGreet = RX.greeting.test(first.text);
  const hasName = RX.intro.test(first.text);
  const score = (hasGreet ? 60 : 20) + (hasName ? 40 : 0);
  return { dimension: "greeting", score, evidence: [{ startTurn: first.index, endTurn: first.index, note: score >= 80 ? "strength" : "improve" }] };
}
function scoreDiscovery(turns: Turn[]): QaDimensionScore {
  const qs = agentTurns(turns).filter((t) => t.text.includes("?"));
  if (!agentTurns(turns).length) return { dimension: "discovery", score: null, evidence: [] };
  const score = clamp(Math.min(qs.length, 4) * 25);
  const ev = qs.length ? [{ startTurn: qs[0].index, endTurn: qs[Math.min(qs.length, 4) - 1].index, note: (score >= 75 ? "strength" : "improve") as QaEvidence["note"] }] : [];
  return { dimension: "discovery", score, evidence: ev };
}
function scoreBooking(turns: Turn[]): QaDimensionScore {
  const hit = agentTurns(turns).find((t) => RX.booking.test(t.text));
  return { dimension: "booking_ask", score: hit ? 100 : 25, evidence: hit ? [{ startTurn: hit.index, endTurn: hit.index, note: "strength" }] : [] };
}
function scorePrice(turns: Turn[]): QaDimensionScore {
  const ask = turns.find((t) => t.role === "caller" && RX.priceAsk.test(t.text));
  if (!ask) return { dimension: "price_handling", score: null, evidence: [] }; // not applicable
  const reply = turns.find((t) => t.role === "agent" && t.index > ask.index);
  if (!reply) return { dimension: "price_handling", score: 30, evidence: [{ startTurn: ask.index, endTurn: ask.index, note: "improve" }] };
  const bare = RX.moneyFigure.test(reply.text) && !RX.estimateLanguage.test(reply.text);
  const score = bare ? 55 : RX.estimateLanguage.test(reply.text) || RX.moneyFigure.test(reply.text) ? 100 : 60;
  return { dimension: "price_handling", score, evidence: [{ startTurn: ask.index, endTurn: reply.index, note: score >= 80 ? "strength" : "improve" }] };
}
function scoreEmpathy(turns: Turn[]): QaDimensionScore {
  const d = turns.find((t) => t.role === "caller" && RX.distress.test(t.text));
  if (!d) return { dimension: "empathy", score: null, evidence: [] };
  const resp = turns.find((t) => t.role === "agent" && t.index > d.index && t.index <= d.index + 2 && RX.empathy.test(t.text));
  return { dimension: "empathy", score: resp ? 100 : 30, evidence: [{ startTurn: d.index, endTurn: resp?.index ?? d.index, note: resp ? "strength" : "improve" }] };
}
function scoreCompliance(turns: Turn[], ctx: QaContext): QaDimensionScore {
  let score = 100;
  const ev: QaEvidence[] = [];
  if (ctx.recordingNoticeRequired) {
    const c = agentTurns(turns).find((t) => RX.consent.test(t.text));
    if (c) ev.push({ startTurn: c.index, endTurn: c.index, note: "strength" });
    else score -= 60;
  }
  const g = agentTurns(turns).find((t) => RX.forbiddenClaim.test(t.text));
  if (g) { score -= 40; ev.push({ startTurn: g.index, endTurn: g.index, note: "improve" }); }
  return { dimension: "compliance", score: clamp(score), evidence: ev };
}

export function scoreHumanCall(transcript: string | null | undefined, ctx: QaContext): QaResult {
  const turns = splitTurns(transcript);
  const reviewable = hasRoles(turns);
  const empty: QaResult = { rubric: QA_RUBRIC_VERSION, scores: { greeting: null, discovery: null, booking_ask: null, price_handling: null, empathy: null, compliance: null }, overall: null, clips: [], coaching: [], reviewable: false };
  if (!reviewable) return empty;
  const dims = [scoreGreeting(turns), scoreDiscovery(turns), scoreBooking(turns), scorePrice(turns), scoreEmpathy(turns), scoreCompliance(turns, ctx)];
  const scores = Object.fromEntries(dims.map((d) => [d.dimension, d.score])) as Record<QaDimension, number | null>;
  let wsum = 0, tot = 0;
  for (const d of dims) if (d.score !== null) { wsum += QA_WEIGHTS[d.dimension]; tot += d.score * QA_WEIGHTS[d.dimension]; }
  const overall = wsum > 0 ? clamp(tot / wsum) : null; // not-applicable dimensions are excluded, never counted as zero
  const clips = dims.flatMap((d) => d.evidence.map((e) => ({ ...e, dimension: d.dimension })));
  const coaching: QaCoachKey[] = [];
  const low = (k: QaDimension) => scores[k] !== null && (scores[k] as number) < 70;
  if (low("greeting")) coaching.push("greet_with_name");
  if (low("discovery")) coaching.push("ask_more_discovery_questions");
  if (low("booking_ask")) coaching.push("ask_for_the_booking");
  if (low("price_handling")) coaching.push("route_price_to_estimate");
  if (low("empathy")) coaching.push("acknowledge_feelings");
  if (ctx.recordingNoticeRequired && !agentTurns(turns).some((t) => RX.consent.test(t.text))) coaching.push("state_recording_notice");
  if (agentTurns(turns).some((t) => RX.forbiddenClaim.test(t.text))) coaching.push("avoid_guarantees");
  return { rubric: QA_RUBRIC_VERSION, scores, overall, clips, coaching, reviewable: true };
}

// ---------- per-agent trends + fairness ----------
export interface AgentReview { agentId: string; at: string; overall: number | null; scenario: string; afterHours: boolean; language: string | null }

export interface AgentSummary {
  agentId: string; n: number; rawMean: number | null; adjustedMean: number | null; suppressed: boolean;
  trend: ReturnType<typeof computeTrend>["overall"] | null;
}
export interface FairnessReport {
  agents: AgentSummary[];
  /** Agents whose rank changes by >= 2 places once call-mix is accounted for: the raw ranking should NOT be trusted for them. */
  mixSensitive: string[];
  /** Language groups with a large score gap on enough calls: the rubric itself may be biased. */
  languageGapFlags: { a: string; b: string; gap: number }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Case-mix adjustment: agent score minus what the AVERAGE agent scores on the same scenario/after-hours mix. */
export function fairnessReport(reviews: AgentReview[], now: number): FairnessReport {
  const scored = reviews.filter((r) => r.overall !== null) as (AgentReview & { overall: number })[];
  const cell = (r: AgentReview) => `${r.scenario}|${r.afterHours ? 1 : 0}`;
  const cellMeans = new Map<string, number>();
  const byCell = new Map<string, number[]>();
  for (const r of scored) byCell.set(cell(r), [...(byCell.get(cell(r)) ?? []), r.overall]);
  for (const [k, v] of byCell) cellMeans.set(k, mean(v) as number);
  const overallMean = mean(scored.map((r) => r.overall)) ?? 0;

  const byAgent = new Map<string, typeof scored>();
  for (const r of scored) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);

  const agents: AgentSummary[] = [...byAgent].map(([agentId, rs]) => {
    const suppressed = rs.length < MIN_AGENT_SAMPLE;
    const raw = mean(rs.map((r) => r.overall));
    const adj = mean(rs.map((r) => r.overall - (cellMeans.get(cell(r)) ?? overallMean))) ;
    const points: ScoredPoint[] = rs.map((r) => ({ at: r.at, overall: r.overall, accuracy: null, compliance: null, booking: null, experience: null, upsell: null }));
    return { agentId, n: rs.length, rawMean: suppressed ? null : raw, adjustedMean: suppressed || adj === null ? null : overallMean + adj, suppressed, trend: suppressed ? null : computeTrend(points, now).overall };
  });

  const ranked = (key: "rawMean" | "adjustedMean") => agents.filter((a) => a[key] !== null).sort((a, b) => (b[key] as number) - (a[key] as number)).map((a) => a.agentId);
  const rawRank = ranked("rawMean");
  const adjRank = ranked("adjustedMean");
  const mixSensitive = rawRank.filter((id) => Math.abs(rawRank.indexOf(id) - adjRank.indexOf(id)) >= 2);

  const byLang = new Map<string, number[]>();
  for (const r of scored) if (r.language) byLang.set(r.language, [...(byLang.get(r.language) ?? []), r.overall]);
  const langs = [...byLang].filter(([, v]) => v.length >= 20).map(([k, v]) => ({ k, m: mean(v) as number }));
  const languageGapFlags: FairnessReport["languageGapFlags"] = [];
  for (let i = 0; i < langs.length; i++) for (let j = i + 1; j < langs.length; j++) {
    const gap = Math.abs(langs[i].m - langs[j].m);
    if (gap >= 8) languageGapFlags.push({ a: langs[i].k, b: langs[j].k, gap: Math.round(gap * 10) / 10 });
  }
  return { agents, mixSensitive, languageGapFlags };
}
