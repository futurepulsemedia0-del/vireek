/**
 * Synthetic monitoring — pure measurement logic (no I/O, no Deno/React APIs).
 * Used by the `synthetic-probe` edge function and by unit tests.
 *
 * A probe run dials a target number through the REAL AI path and then verifies, from the
 * product's own database rows, what actually happened. This module turns the raw evidence into
 * SLI results. Rules:
 *   - Probe-side faults (our caller assistant / telephony origin broke) are status "error" and
 *     NEVER count against an SLO.
 *   - Downstream SLIs are only recorded when their upstream stage was reachable, so one outage
 *     does not get counted five times.
 */

export type SliKey = 'availability' | 'answer_latency' | 'asr_accuracy' | 'booking_success' | 'webhook_delivery';
export type RunStatus = 'passed' | 'failed' | 'error';
export type FailureStage = 'dial' | 'answer' | 'speech' | 'booking' | 'webhook' | 'probe';

export const SLI_THRESHOLDS = {
  /** Time from dial to the first AI speech heard by the probe. */
  answerLatencyMs: 3000,
  /** 1 - word error rate over the scripted utterances. */
  asrAccuracy: 0.85,
  /** Row insert -> receipt at the webhook sink. */
  webhookLatencyMs: 30_000,
} as const;

/** How long after the call ended we keep waiting for end-of-call report + webhooks. */
export const VERIFY_GRACE_MS = 180_000;
/** A probe call that has not ended after this long is treated as hung. */
export const MAX_CALL_AGE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export interface ProbeScenario {
  key: string;
  description: string;
  /** Exact phrases the probe caller is told to say, in order. Words are chosen to be digit-free. */
  utterances: string[];
}

export const SCENARIOS: Record<string, ProbeScenario> = {
  book_hvac_repair: {
    key: 'book_hvac_repair',
    description: 'New customer reports a failed air conditioner and books an appointment for tomorrow morning.',
    utterances: [
      'Hello my name is Alex Probe',
      'my air conditioner stopped cooling',
      'the address is Synthetic Avenue in Springfield',
      'I would like an appointment tomorrow morning',
      'yes please confirm that booking',
    ],
  },
};

export function getScenario(key: string): ProbeScenario {
  return SCENARIOS[key] ?? SCENARIOS.book_hvac_repair;
}

/** Text injected into the probe assistant through the {{probe_script}} variable. */
export function buildProbeScript(s: ProbeScenario): string {
  const steps = s.utterances.map((u, i) => `${i + 1}. Say exactly: "${u}"`).join('\n');
  return [
    'You are an automated test caller. Wait for the receptionist to speak first.',
    'Answer each question briefly. When there is nothing to answer, say the next line below, one line at a time,',
    'pronouncing every word clearly. Do not add extra words. When the booking is confirmed, say "thank you goodbye" and end the call.',
    steps,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Text normalisation + ASR accuracy
// ---------------------------------------------------------------------------

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => DIGIT_WORDS[w] ?? w);
}

/** Minimum edit distance between `expected` and ANY contiguous run of `heard` (Sellers algorithm). */
export function bestSubstringDistance(expected: string[], heard: string[]): number {
  const n = expected.length;
  const m = heard.length;
  if (n === 0) return 0;
  if (m === 0) return n;
  let prev = new Array<number>(m + 1).fill(0); // row 0 is free: match may start anywhere
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = expected[i - 1] === heard[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return Math.min(...prev);
}

export interface AsrResult {
  accuracy: number;
  perUtterance: { text: string; wer: number }[];
}

/** accuracy = 1 - (total word errors / total expected words), clamped to [0, 1]. */
export function computeAsrAccuracy(expectedUtterances: string[], heardText: string): AsrResult {
  const heard = tokenize(heardText);
  let errors = 0;
  let words = 0;
  const perUtterance: AsrResult['perUtterance'] = [];
  for (const u of expectedUtterances) {
    const exp = tokenize(u);
    if (exp.length === 0) continue;
    const d = bestSubstringDistance(exp, heard);
    errors += d;
    words += exp.length;
    perUtterance.push({ text: u, wer: Number((d / exp.length).toFixed(4)) });
  }
  const accuracy = words === 0 ? 0 : Math.max(0, Math.min(1, 1 - errors / words));
  return { accuracy: Number(accuracy.toFixed(4)), perUtterance };
}

const CALLER_ROLES = new Set(['user', 'customer', 'caller', 'human']);
const AGENT_ROLES = new Set(['ai', 'assistant', 'bot', 'agent']);

/**
 * Split a stored transcript ("AI: ...\nUser: ...") into caller and agent text.
 * If no speaker labels are found the whole text is treated as caller text and `separated` is false
 * (the score is then an upper bound; the run details record that fact).
 */
export function splitTranscriptByRole(transcript: string): { callerText: string; agentText: string; separated: boolean } {
  const caller: string[] = [];
  const agent: string[] = [];
  let current: 'caller' | 'agent' | null = null;
  let labelled = false;
  for (const raw of transcript.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z]{2,10})\s*:\s*(.*)$/.exec(line);
    if (m) {
      const role = m[1].toLowerCase();
      if (CALLER_ROLES.has(role)) {
        current = 'caller';
        labelled = true;
        caller.push(m[2]);
        continue;
      }
      if (AGENT_ROLES.has(role)) {
        current = 'agent';
        labelled = true;
        agent.push(m[2]);
        continue;
      }
    }
    if (current === 'caller') caller.push(line);
    else if (current === 'agent') agent.push(line);
  }
  if (!labelled) return { callerText: transcript, agentText: '', separated: false };
  return { callerText: caller.join(' '), agentText: agent.join(' '), separated: true };
}

// ---------------------------------------------------------------------------
// Probe-side call report (Vapi GET /call/{id}) -> answer latency
// ---------------------------------------------------------------------------

export interface ProbeCallMessage {
  role?: string;
  message?: string;
  time?: number;
  secondsFromStart?: number;
}

export interface ProbeCallReport {
  id?: string;
  status?: string;
  endedReason?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  messages?: ProbeCallMessage[] | null;
  artifact?: { messages?: ProbeCallMessage[] | null } | null;
}

export type EndedClass = 'answered' | 'not_answered' | 'probe_error' | 'unknown';

const NOT_ANSWERED = new Set([
  'customer-did-not-answer',
  'customer-busy',
  'voicemail',
  'twilio-failed-to-connect-call',
  'vonage-failed-to-connect-call',
  'phone-call-provider-closed-websocket',
]);
const PROBE_ERROR = /^(assistant-(not-found|not-valid|request-failed|request-returned-(error|invalid-assistant|unspeakable-error)|error)|pipeline-error-|unknown-error|call\.start\.error|assistant-.*-failed)/;

/** Single place that decides which Vapi end reasons are our probe's fault vs the product's. */
export function classifyEndedReason(reason: string | null | undefined): EndedClass {
  if (!reason) return 'unknown';
  if (NOT_ANSWERED.has(reason)) return 'not_answered';
  if (PROBE_ERROR.test(reason)) return 'probe_error';
  return 'answered';
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export interface AnswerTiming {
  pickupMs: number | null;
  firstWordMs: number | null;
  /** What a caller experiences: dial -> first AI speech (falls back to pickup time). */
  latencyMs: number | null;
}

export function extractAnswerTiming(call: ProbeCallReport): AnswerTiming {
  const created = ms(call.createdAt);
  const started = ms(call.startedAt);
  const pickupMs = created !== null && started !== null ? Math.max(0, started - created) : null;
  const messages = (call.artifact?.messages ?? call.messages ?? []).filter(Boolean);
  // From the probe's point of view the receptionist AI is the "user" side of the conversation.
  const heard = messages.find((m) => (m.role === 'user' || m.role === 'customer') && (m.message ?? '').trim().length > 0);
  let firstWordMs: number | null = null;
  if (heard && created !== null) {
    if (typeof heard.time === 'number' && Number.isFinite(heard.time) && heard.time > 1e11) {
      firstWordMs = Math.max(0, heard.time - created);
    } else if (typeof heard.secondsFromStart === 'number' && started !== null) {
      firstWordMs = Math.max(0, started + Math.round(heard.secondsFromStart * 1000) - created);
    }
  }
  return { pickupMs, firstWordMs, latencyMs: firstWordMs ?? pickupMs };
}

// ---------------------------------------------------------------------------
// Run evaluation
// ---------------------------------------------------------------------------

export interface TargetCallEvidence {
  id: string;
  transcript: string | null;
}
export interface JobEvidence {
  id: string;
  created_at: string;
}
export interface ReceiptEvidence {
  event: string;
  record_id: string | null;
  received_at: string;
}

export interface EvaluateInput {
  scenarioKey: string;
  call: ProbeCallReport;
  /** Row created by vapi-webhook in the probe tenant for the call we placed. */
  targetCall: TargetCallEvidence | null;
  /** Row created by the book_appointment tool. */
  job: JobEvidence | null;
  /** Receipts recorded by synthetic-webhook-sink for this target since the run started. */
  receipts: ReceiptEvidence[];
  /** Timestamp of the targetCall row insert (calls.created_at). */
  targetCallCreatedAt: string | null;
  now: number;
  /** When true, missing evidence is final (grace period over); otherwise the run stays open. */
  final: boolean;
}

export interface SliResult {
  sli: SliKey;
  good: boolean;
  value: number | null;
}

export interface Evaluation {
  complete: boolean;
  status: RunStatus;
  failureStage: FailureStage | null;
  error: string | null;
  slis: SliResult[];
  answered: boolean;
  answerLatencyMs: number | null;
  asrAccuracy: number | null;
  bookingOk: boolean | null;
  webhookOk: boolean | null;
  webhookLatencyMs: number | null;
  details: Record<string, unknown>;
}

function receiptLatency(
  receipts: ReceiptEvidence[],
  event: string,
  recordId: string,
  recordCreatedAt: string | null,
): { received: boolean; latencyMs: number | null } {
  const r = receipts.find((x) => x.event === event && x.record_id === recordId);
  if (!r) return { received: false, latencyMs: null };
  const a = ms(r.received_at);
  const b = ms(recordCreatedAt);
  return { received: true, latencyMs: a !== null && b !== null ? Math.max(0, a - b) : null };
}

function empty(overrides: Partial<Evaluation>): Evaluation {
  return {
    complete: true,
    status: 'failed',
    failureStage: null,
    error: null,
    slis: [],
    answered: false,
    answerLatencyMs: null,
    asrAccuracy: null,
    bookingOk: null,
    webhookOk: null,
    webhookLatencyMs: null,
    details: {},
    ...overrides,
  };
}

export function evaluateRun(input: EvaluateInput): Evaluation {
  const { call, now } = input;
  const scenario = getScenario(input.scenarioKey);
  const klass = classifyEndedReason(call.endedReason);
  const details: Record<string, unknown> = { ended_reason: call.endedReason ?? null, ended_class: klass };

  // 1) Probe-side fault: excluded from every SLO.
  if (klass === 'probe_error') {
    return empty({ status: 'error', failureStage: 'probe', error: `Probe-side failure: ${call.endedReason}`, details });
  }

  // 2) Availability + latency
  const timing = extractAnswerTiming(call);
  details.pickup_ms = timing.pickupMs;
  details.first_word_ms = timing.firstWordMs;
  const answered = klass !== 'not_answered' && timing.firstWordMs !== null;
  if (!answered) {
    return empty({
      status: 'failed',
      failureStage: 'answer',
      error: klass === 'not_answered' ? `Call not answered (${call.endedReason})` : 'Call connected but no AI speech was heard',
      slis: [{ sli: 'availability', good: false, value: 0 }],
      details,
    });
  }

  const slis: SliResult[] = [{ sli: 'availability', good: true, value: 1 }];
  const latency = timing.latencyMs as number;
  const latencyGood = latency <= SLI_THRESHOLDS.answerLatencyMs;
  slis.push({ sli: 'answer_latency', good: latencyGood, value: latency });

  let stage: FailureStage | null = latencyGood ? null : 'answer';
  const missing: string[] = [];

  // 3) Speech recognition accuracy, from the transcript the product itself stored.
  let asrAccuracy: number | null = null;
  const transcript = input.targetCall?.transcript?.trim() ?? '';
  if (!input.targetCall || !transcript) {
    missing.push(input.targetCall ? 'transcript' : 'target_call_row');
  } else {
    const split = splitTranscriptByRole(transcript);
    const asr = computeAsrAccuracy(scenario.utterances, split.callerText);
    asrAccuracy = asr.accuracy;
    details.asr_per_utterance = asr.perUtterance;
    details.transcript_speakers_separated = split.separated;
    const good = asr.accuracy >= SLI_THRESHOLDS.asrAccuracy;
    slis.push({ sli: 'asr_accuracy', good, value: asr.accuracy });
    if (!good) stage = stage ?? 'speech';
  }

  // 4) Booking
  let bookingOk: boolean | null = null;
  if (input.job) {
    bookingOk = true;
    slis.push({ sli: 'booking_success', good: true, value: 1 });
  } else if (input.targetCall) {
    missing.push('job');
  }

  // 5) Webhook delivery (call.created always; job.created when a job exists)
  let webhookOk: boolean | null = null;
  let webhookLatencyMs: number | null = null;
  if (input.targetCall) {
    const callRx = receiptLatency(input.receipts, 'call.created', input.targetCall.id, input.targetCallCreatedAt);
    const jobRx = input.job ? receiptLatency(input.receipts, 'job.created', input.job.id, input.job.created_at) : null;
    const required = [callRx, ...(jobRx ? [jobRx] : [])];
    if (required.every((r) => r.received)) {
      const worst = Math.max(...required.map((r) => r.latencyMs ?? 0));
      webhookLatencyMs = worst;
      webhookOk = worst <= SLI_THRESHOLDS.webhookLatencyMs;
      slis.push({ sli: 'webhook_delivery', good: webhookOk, value: worst });
      if (!webhookOk) stage = stage ?? 'webhook';
    } else {
      missing.push('webhook_receipt');
    }
  }

  // 6) Still waiting for evidence?
  if (missing.length > 0 && !input.final) {
    return { ...empty({}), complete: false, status: 'failed', answered: true, answerLatencyMs: latency, details: { ...details, waiting_for: missing } };
  }

  // 7) Grace period over: remaining gaps are product failures.
  if (missing.includes('target_call_row') || missing.includes('transcript')) {
    slis.push({ sli: 'asr_accuracy', good: false, value: 0 });
    asrAccuracy = 0;
    stage = stage ?? 'speech';
  }
  if (missing.includes('job')) {
    bookingOk = false;
    slis.push({ sli: 'booking_success', good: false, value: 0 });
    stage = stage ?? 'booking';
  }
  if (missing.includes('webhook_receipt')) {
    webhookOk = false;
    slis.push({ sli: 'webhook_delivery', good: false, value: null });
    stage = stage ?? 'webhook';
  }
  if (missing.length > 0) details.missing = missing;

  const allGood = slis.every((s) => s.good);
  return {
    complete: true,
    status: allGood ? 'passed' : 'failed',
    failureStage: allGood ? null : stage,
    error: allGood ? null : `Failed at stage: ${stage ?? 'unknown'}`,
    slis,
    answered: true,
    answerLatencyMs: latency,
    asrAccuracy,
    bookingOk,
    webhookOk,
    webhookLatencyMs,
    details: { ...details, evaluated_at: new Date(now).toISOString() },
  };
}

/** Decide whether verification should treat missing evidence as final. */
export function isVerificationFinal(call: ProbeCallReport, now: number): boolean {
  const ended = ms(call.endedAt);
  if (ended === null) return false;
  return now - ended >= VERIFY_GRACE_MS;
}

/** A call that never reached "ended" within the max age is hung (a probe-side or telephony fault). */
export function isCallHung(startedAtIso: string, now: number): boolean {
  const s = ms(startedAtIso);
  return s !== null && now - s > MAX_CALL_AGE_MS;
}
