// supabase/functions/_shared/audit/scoring.ts
//
// Deterministic 0-100 score with five sub-scores, plain-language findings and a fix path.
// Every number is a pure function of the observed test calls, so the report can show its work and the unit
// tests (scoring.test.ts) pin the arithmetic.
//
// A sub-score with nothing to measure is NULL and its weight is dropped (never scored as a made-up zero).
// Calls that failed on OUR side (provider/network, unknown outcome) are INCONCLUSIVE and excluded, so the
// owner is never penalised for our outage.
//
//   Weights: answer rate 30, speed to answer 20, voicemail quality 10, after-hours coverage 25, booking readiness 15.

import type {
  AnswerKind, Band, CallObservations, Confidence, Finding, FixStep, ScoreResult, ScoredCall, SubScore, SubScoreKey,
} from "./types.ts";

export const WEIGHTS: Record<SubScoreKey, number> = {
  answer_rate: 30,
  speed_to_answer: 20,
  voicemail_quality: 10,
  after_hours_coverage: 25,
  booking_readiness: 15,
};

/** North-American ring cadence: 2 s of ringing + 4 s of silence = about 6 s per ring. Stated in the report. */
export const SECONDS_PER_RING = 6;

const CONCLUSIVE: ReadonlySet<AnswerKind> = new Set(["live_person", "live_ai", "ivr", "voicemail", "no_answer", "busy"]);
const LIVE: ReadonlySet<AnswerKind> = new Set(["live_person", "live_ai"]);

export const isConclusive = (c: ScoredCall): boolean => c.status === "completed" && c.answer_kind !== null && CONCLUSIVE.has(c.answer_kind);
const round = (n: number) => Math.round(n);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 100 up to 12 s (about 2 rings), falling to 60 at 24 s and 0 at 36 s. */
export function speedPoints(ringSeconds: number): number {
  if (ringSeconds <= 12) return 100;
  if (ringSeconds <= 24) return 100 - (ringSeconds - 12) * (40 / 12);
  if (ringSeconds <= 36) return 60 - (ringSeconds - 24) * 5;
  return 0;
}

/** Voicemail greeting quality 0-100: greeting 30, business name 25, callback/next step 25, alternative 10, concise 10. */
export function voicemailPoints(o: CallObservations): number {
  return (
    (o.greeting_present ? 30 : 0) +
    (o.business_name_stated ? 25 : 0) +
    (o.callback_promised ? 25 : 0) +
    (o.alternate_option_offered ? 10 : 0) +
    (typeof o.greeting_seconds === "number" && o.greeting_seconds <= 25 ? 10 : 0)
  );
}

const answerCredit = (k: AnswerKind): number => (LIVE.has(k) ? 1 : k === "ivr" ? 0.5 : 0);

const sub = (key: SubScoreKey, score: number | null, basis: string, calls: number[]): SubScore => ({
  score: score === null ? null : round(clamp(score, 0, 100)),
  weight: WEIGHTS[key],
  basis,
  calls,
});

export const bandFor = (total: number): Band => (total >= 85 ? "strong" : total >= 65 ? "fair" : total >= 40 ? "leaking" : "critical");
export const BAND_LABEL: Record<Band, string> = { strong: "Strong", fair: "Needs work", leaking: "Leaking calls", critical: "Critical" };

export function scoreAudit(calls: ScoredCall[]): ScoreResult {
  const good = calls.filter(isConclusive);
  const inconclusive = calls.filter((c) => c.status === "completed" || c.status === "failed").length - good.length;
  const kindOf = (c: ScoredCall) => c.answer_kind as AnswerKind;

  const expected = good.filter((c) => c.condition !== "after_hours");
  const answerRate = expected.length
    ? sub("answer_rate", mean(expected.map((c) => answerCredit(kindOf(c)))) * 100,
        `${expected.length} call${expected.length > 1 ? "s" : ""} during open hours; a live answer counts fully, a phone menu counts half.`, expected.map((c) => c.slot))
    : sub("answer_rate", null, "No conclusive call during open hours.", []);

  const answered = good.filter((c) => (LIVE.has(kindOf(c)) || kindOf(c) === "ivr") && c.ring_seconds !== null);
  const speed = answered.length
    ? sub("speed_to_answer", mean(answered.map((c) => {
        const hold = c.observations.hold_seconds ?? 0;
        const penalty = clamp((hold - 20) / 40, 0, 1) * 30;
        return clamp(speedPoints(c.ring_seconds as number) - penalty, 0, 100);
      })), `Measured on ${answered.length} answered call${answered.length > 1 ? "s" : ""}: full marks within about 2 rings, none past about 6 rings.`, answered.map((c) => c.slot))
    : sub("speed_to_answer", null, "No call was answered live, so speed could not be measured.", []);

  const vmCalls = good.filter((c) => kindOf(c) === "voicemail" || kindOf(c) === "no_answer");
  const vm = vmCalls.length
    ? sub("voicemail_quality", mean(vmCalls.map((c) => (kindOf(c) === "voicemail" ? voicemailPoints(c.observations) : 0))),
        `${vmCalls.length} call${vmCalls.length > 1 ? "s" : ""} reached voicemail or rang out. A line that rings out with no voicemail scores 0.`, vmCalls.map((c) => c.slot))
    : sub("voicemail_quality", null, "No call reached voicemail, so there was no greeting to judge.", []);

  const ah = good.find((c) => c.condition === "after_hours");
  let ahScore: number | null = null;
  if (ah) {
    const k = kindOf(ah);
    ahScore = LIVE.has(k) ? 100 : k === "ivr" ? 80 : k === "voicemail" ? 35 + 0.2 * voicemailPoints(ah.observations) : 0;
  }
  const after = ah
    ? sub("after_hours_coverage", ahScore, "One call outside your stated hours: answered live = 100, phone menu = 80, voicemail = 35-55, rang out or busy = 0.", [ah.slot])
    : sub("after_hours_coverage", null, "No after-hours call could be tested (see the notes for why).", []);

  const liveCalls = good.filter((c) => LIVE.has(kindOf(c)));
  const booking = liveCalls.length
    ? sub("booking_readiness", mean(liveCalls.map((c) => (c.observations.offered_to_book ? 100 : c.observations.message_only ? 35 : 50))),
        `${liveCalls.length} live answer${liveCalls.length > 1 ? "s" : ""}: able to book or take details = 100, message only = 35, unclear = 50.`, liveCalls.map((c) => c.slot))
    : sub("booking_readiness", null, "No live answer, so booking readiness could not be tested.", []);

  const parts: Record<SubScoreKey, SubScore> = {
    answer_rate: answerRate, speed_to_answer: speed, voicemail_quality: vm, after_hours_coverage: after, booking_readiness: booking,
  };
  const scored = Object.values(parts).filter((p) => p.score !== null);
  const wsum = scored.reduce((a, p) => a + p.weight, 0);
  const total = good.length === 0 || wsum === 0 ? null : round(scored.reduce((a, p) => a + (p.score as number) * p.weight, 0) / wsum);
  const confidence: Confidence = good.length >= 3 ? "ok" : good.length === 2 ? "limited" : "low";

  const result: ScoreResult = {
    total, band: total === null ? null : bandFor(total), confidence,
    conclusive_calls: good.length, inconclusive_calls: Math.max(0, inconclusive), sub: parts, findings: [], fix_path: [],
  };
  result.findings = buildFindings(calls, result);
  result.fix_path = buildFixPath(calls, result);
  return result;
}

const ev = (cs: ScoredCall[]) => cs.map((c) => ({ slot: c.slot, condition: c.condition }));
const cond = (c: ScoredCall) => (c.condition === "business_hours" ? "business-hours" : c.condition === "lunch" ? "lunch-time" : "after-hours");

export function buildFindings(calls: ScoredCall[], r: ScoreResult): Finding[] {
  const out: Finding[] = [];
  const good = calls.filter(isConclusive);
  const k = (c: ScoredCall) => c.answer_kind as AnswerKind;

  const missedOpen = good.filter((c) => c.condition !== "after_hours" && !LIVE.has(k(c)) && k(c) !== "ivr");
  const liveOpen = good.filter((c) => c.condition !== "after_hours" && LIVE.has(k(c)));
  if (missedOpen.length) {
    out.push({ id: "open_hours_missed", severity: missedOpen.length === good.filter((c) => c.condition !== "after_hours").length ? "critical" : "warn",
      title: `${missedOpen.length} ${missedOpen.length > 1 ? "calls" : "call"} during open hours did not reach a person`,
      detail: `Our ${missedOpen.map(cond).join(" and ")} test call${missedOpen.length > 1 ? "s were" : " was"} not answered live. Customers who call while you are open are your hottest leads, and most will try the next company rather than wait.`,
      evidence: ev(missedOpen) });
  } else if (liveOpen.length) {
    out.push({ id: "open_hours_answered", severity: "good", title: "Calls during open hours were answered live",
      detail: "Every call we placed while you were open reached a person or an assistant.", evidence: ev(liveOpen) });
  }

  const slow = r.sub.speed_to_answer.score !== null && r.sub.speed_to_answer.score < 60;
  if (slow) {
    const slowCalls = good.filter((c) => (LIVE.has(k(c)) || k(c) === "ivr") && (c.ring_seconds ?? 0) > 18);
    const avg = slowCalls.length ? Math.round(mean(slowCalls.map((c) => c.ring_seconds as number))) : null;
    out.push({ id: "slow_answer", severity: "warn", title: "The phone rings a long time before anyone answers",
      detail: `${avg !== null ? `Pick-up took about ${avg} seconds (roughly ${Math.round(avg / SECONDS_PER_RING)} rings). ` : ""}Rings are about ${SECONDS_PER_RING} seconds each, and many callers hang up after 4 to 5.`,
      evidence: ev(slowCalls) });
  }

  const ringOut = good.filter((c) => k(c) === "no_answer");
  if (ringOut.length) {
    out.push({ id: "no_voicemail", severity: "critical", title: "Some calls rang out with no voicemail",
      detail: "When nobody answered, the line just kept ringing, so the caller could not leave a message at all. That is a lost lead with no trace.", evidence: ev(ringOut) });
  }
  const vms = good.filter((c) => k(c) === "voicemail");
  const weakVm = vms.filter((c) => !c.observations.business_name_stated || !c.observations.callback_promised);
  if (weakVm.length) {
    const noName = weakVm.some((c) => !c.observations.business_name_stated);
    out.push({ id: "weak_voicemail", severity: "warn", title: noName ? "The voicemail greeting doesn't say who you are" : "The voicemail doesn't say what happens next",
      detail: `${noName ? "A caller can't tell they reached the right business. " : ""}A good greeting names the business, says when they'll get a call back, and offers another way to reach you for urgent jobs.`, evidence: ev(weakVm) });
  } else if (vms.length) {
    out.push({ id: "good_voicemail", severity: "good", title: "Your voicemail greeting names you and sets expectations", detail: "It says who you are and what happens next.", evidence: ev(vms) });
  }

  const ah = good.find((c) => c.condition === "after_hours");
  if (ah) {
    const kind = k(ah);
    if (LIVE.has(kind)) out.push({ id: "after_hours_covered", severity: "good", title: "After-hours calls are answered", detail: "Our call outside your hours still reached a person or an assistant.", evidence: ev([ah]) });
    else if (kind === "voicemail") out.push({ id: "after_hours_voicemail", severity: "warn", title: "After hours, callers only get voicemail", detail: "Emergency and same-day jobs rarely wait for a callback, so many of these callers will already have booked someone else by morning.", evidence: ev([ah]) });
    else out.push({ id: "after_hours_dark", severity: "critical", title: "After hours, the line goes nowhere", detail: "Our after-hours call was not answered and reached no voicemail. Anyone calling at that time has no way to reach you.", evidence: ev([ah]) });
  } else {
    out.push({ id: "after_hours_not_tested", severity: "info", title: "After-hours coverage was not tested",
      detail: "We only place test calls between 8 a.m. and 9 p.m. local time. If your hours run past that, or no safe window was available, we can't call after hours, so this part is not scored.", evidence: [] });
  }

  const liveCalls = good.filter((c) => LIVE.has(k(c)));
  const noBook = liveCalls.filter((c) => !c.observations.offered_to_book);
  if (liveCalls.length && noBook.length) {
    out.push({ id: "booking_unclear", severity: "warn", title: "The person who answered couldn't book on the spot",
      detail: "When we asked whether an appointment could be booked on the call, the answer was a message or an unclear one. Callers who can't book right away are the ones most likely to call a competitor.", evidence: ev(noBook) });
  } else if (liveCalls.length) {
    out.push({ id: "booking_ready", severity: "good", title: "Callers can book straight away", detail: "The answerer said they could book or take details on the call.", evidence: ev(liveCalls) });
  }

  if (r.inconclusive_calls > 0) {
    out.push({ id: "inconclusive", severity: "info", title: `${r.inconclusive_calls} test call${r.inconclusive_calls > 1 ? "s" : ""} couldn't be assessed`,
      detail: "These had a network or provider problem on our side, so they are left out of the score rather than counted against you.", evidence: [] });
  }
  if (r.confidence !== "ok") {
    out.push({ id: "small_sample", severity: "info", title: "Treat this score as a first look",
      detail: `The score rests on ${r.conclusive_calls} conclusive call${r.conclusive_calls === 1 ? "" : "s"}. It shows how your line behaved at those moments, not a long-run average.`, evidence: [] });
  }
  return out;
}

export function buildFixPath(calls: ScoredCall[], r: ScoreResult): FixStep[] {
  const steps: FixStep[] = [];
  const has = (id: string) => r.findings.some((f) => f.id === id);
  if (has("open_hours_missed") || has("slow_answer")) {
    steps.push({ id: "answer_faster", title: "Make sure every call is picked up within two rings",
      detail: "Add a ring group or forward to a second phone, so one busy person doesn't mean a missed lead. An AI receptionist answers instantly and never puts a caller on hold.", vireek_can_help: true });
  }
  if (has("no_voicemail") || has("weak_voicemail")) {
    steps.push({ id: "fix_voicemail", title: "Turn voicemail on and rewrite the greeting",
      detail: "Say your business name, promise a callback time, and give an option for urgent jobs. This takes about ten minutes and costs nothing.", vireek_can_help: false });
  }
  if (has("after_hours_voicemail") || has("after_hours_dark")) {
    steps.push({ id: "cover_after_hours", title: "Cover the hours you're closed",
      detail: "Route after-hours calls to an answering service or an AI receptionist that can take the job details and book the first slot in the morning.", vireek_can_help: true });
  }
  if (has("booking_unclear")) {
    steps.push({ id: "book_on_first_call", title: "Let callers book on the first call",
      detail: "Give whoever answers a shared calendar, or let an assistant book directly into it, so the caller never has to wait for a callback.", vireek_can_help: true });
  }
  if (steps.length === 0) {
    steps.push({ id: "keep_it_up", title: "Keep testing as your call volume changes",
      detail: "Your line handled these test calls well. Re-run the audit after any change to staff, phones or hours.", vireek_can_help: false });
  }
  return steps;
}
