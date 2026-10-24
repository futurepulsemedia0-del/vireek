import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  SLI_THRESHOLDS,
  VERIFY_GRACE_MS,
  buildProbeScript,
  classifyEndedReason,
  computeAsrAccuracy,
  evaluateRun,
  extractAnswerTiming,
  isCallHung,
  isVerificationFinal,
  splitTranscriptByRole,
  tokenize,
  type EvaluateInput,
  type ProbeCallReport,
} from './metrics';

const T0 = Date.parse('2027-11-02T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const scenario = SCENARIOS.book_hvac_repair;
const perfectCallerText = scenario.utterances.join('. ');

function goodCall(over: Partial<ProbeCallReport> = {}): ProbeCallReport {
  return {
    id: 'probe-1',
    endedReason: 'assistant-ended-call',
    createdAt: iso(0),
    startedAt: iso(1000),
    endedAt: iso(60_000),
    messages: [{ role: 'user', message: 'Thanks for calling, how can I help?', secondsFromStart: 1.2 }],
    ...over,
  };
}

function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    scenarioKey: 'book_hvac_repair',
    call: goodCall(),
    targetCall: { id: 'call-1', transcript: `AI: Thanks for calling\nUser: ${perfectCallerText}` },
    job: { id: 'job-1', created_at: iso(50_000) },
    receipts: [
      { event: 'call.created', record_id: 'call-1', received_at: iso(4_000) },
      { event: 'job.created', record_id: 'job-1', received_at: iso(52_000) },
    ],
    targetCallCreatedAt: iso(2_500),
    now: T0 + 300_000,
    final: false,
    ...over,
  };
}

describe('tokenize', () => {
  it('lowercases, strips punctuation and maps spoken digits', () => {
    expect(tokenize('Hello, Alex! Room Two.')).toEqual(['hello', 'alex', 'room', '2']);
  });
});

describe('computeAsrAccuracy', () => {
  it('is 1 for a perfect transcription, even with extra surrounding words', () => {
    const r = computeAsrAccuracy(scenario.utterances, `well ${perfectCallerText} okay then`);
    expect(r.accuracy).toBe(1);
  });
  it('penalises substituted and missing words', () => {
    const r = computeAsrAccuracy(['my air conditioner stopped cooling'], 'my air conditioning stopped');
    // 1 substitution + 1 deletion over 5 expected words
    expect(r.accuracy).toBeCloseTo(0.6, 4);
  });
  it('is 0 when nothing was heard', () => {
    expect(computeAsrAccuracy(scenario.utterances, '').accuracy).toBe(0);
  });
  it('never goes below 0 or above 1', () => {
    const r = computeAsrAccuracy(['a b c'], 'x y z q w e r');
    expect(r.accuracy).toBeGreaterThanOrEqual(0);
    expect(r.accuracy).toBeLessThanOrEqual(1);
  });
});

describe('splitTranscriptByRole', () => {
  it('separates labelled speakers and keeps continuation lines', () => {
    const r = splitTranscriptByRole('AI: Hello\nhow can I help\nUser: my name is Alex\nCustomer: and my AC broke');
    expect(r.separated).toBe(true);
    expect(r.agentText).toBe('Hello how can I help');
    expect(r.callerText).toBe('my name is Alex and my AC broke');
  });
  it('falls back to the whole text when there are no labels', () => {
    const r = splitTranscriptByRole('just a flat transcript');
    expect(r.separated).toBe(false);
    expect(r.callerText).toBe('just a flat transcript');
  });
});

describe('classifyEndedReason', () => {
  it('separates probe faults from product faults', () => {
    expect(classifyEndedReason('customer-did-not-answer')).toBe('not_answered');
    expect(classifyEndedReason('voicemail')).toBe('not_answered');
    expect(classifyEndedReason('assistant-not-found')).toBe('probe_error');
    expect(classifyEndedReason('pipeline-error-openai-llm-failed')).toBe('probe_error');
    expect(classifyEndedReason('assistant-ended-call')).toBe('answered');
    expect(classifyEndedReason('customer-ended-call')).toBe('answered');
    expect(classifyEndedReason(undefined)).toBe('unknown');
  });
});

describe('extractAnswerTiming', () => {
  it('uses secondsFromStart relative to startedAt', () => {
    const t = extractAnswerTiming(goodCall());
    expect(t.pickupMs).toBe(1000);
    expect(t.firstWordMs).toBe(2200);
    expect(t.latencyMs).toBe(2200);
  });
  it('prefers an absolute epoch time when present', () => {
    const t = extractAnswerTiming(goodCall({ messages: [{ role: 'user', message: 'hi', time: T0 + 1800 }] }));
    expect(t.firstWordMs).toBe(1800);
  });
  it('falls back to pickup time and null when nothing was heard', () => {
    const t = extractAnswerTiming(goodCall({ messages: [] }));
    expect(t.firstWordMs).toBeNull();
    expect(t.latencyMs).toBe(1000);
  });
  it('ignores bot-side messages', () => {
    const t = extractAnswerTiming(goodCall({ messages: [{ role: 'bot', message: 'probe speaking', secondsFromStart: 0.1 }] }));
    expect(t.firstWordMs).toBeNull();
  });
});

describe('evaluateRun', () => {
  it('passes with every SLI good', () => {
    const e = evaluateRun(input());
    expect(e.complete).toBe(true);
    expect(e.status).toBe('passed');
    expect(e.failureStage).toBeNull();
    expect(e.slis.map((s) => s.sli).sort()).toEqual(['answer_latency', 'asr_accuracy', 'availability', 'booking_success', 'webhook_delivery']);
    expect(e.slis.every((s) => s.good)).toBe(true);
    expect(e.webhookLatencyMs).toBe(2000);
  });

  it('excludes probe-side faults from SLIs', () => {
    const e = evaluateRun(input({ call: goodCall({ endedReason: 'assistant-not-found' }) }));
    expect(e.status).toBe('error');
    expect(e.failureStage).toBe('probe');
    expect(e.slis).toEqual([]);
  });

  it('records only availability when the call is not answered', () => {
    const e = evaluateRun(input({ call: goodCall({ endedReason: 'customer-did-not-answer', messages: [] }), targetCall: null, job: null, receipts: [] }));
    expect(e.status).toBe('failed');
    expect(e.failureStage).toBe('answer');
    expect(e.slis).toEqual([{ sli: 'availability', good: false, value: 0 }]);
  });

  it('flags a slow answer as a latency failure without failing availability', () => {
    const slow = goodCall({ messages: [{ role: 'user', message: 'hello', secondsFromStart: 5 }] });
    const e = evaluateRun(input({ call: slow }));
    const lat = e.slis.find((s) => s.sli === 'answer_latency');
    expect(lat?.good).toBe(false);
    expect(lat?.value).toBeGreaterThan(SLI_THRESHOLDS.answerLatencyMs);
    expect(e.slis.find((s) => s.sli === 'availability')?.good).toBe(true);
    expect(e.status).toBe('failed');
    expect(e.failureStage).toBe('answer');
  });

  it('fails speech when accuracy is under the threshold', () => {
    const e = evaluateRun(input({ targetCall: { id: 'call-1', transcript: 'User: hello banana\nAI: ok' } }));
    expect(e.slis.find((s) => s.sli === 'asr_accuracy')?.good).toBe(false);
    expect(e.failureStage).toBe('speech');
  });

  it('keeps waiting while evidence is missing and not final', () => {
    const e = evaluateRun(input({ job: null, receipts: [] }));
    expect(e.complete).toBe(false);
    expect((e.details.waiting_for as string[]).sort()).toEqual(['job', 'webhook_receipt']);
  });

  it('turns missing booking into a booking failure once final', () => {
    const e = evaluateRun(input({ job: null, final: true }));
    expect(e.complete).toBe(true);
    expect(e.bookingOk).toBe(false);
    expect(e.failureStage).toBe('booking');
    expect(e.slis.find((s) => s.sli === 'booking_success')?.good).toBe(false);
  });

  it('fails webhook delivery when the receipt is missing or late', () => {
    const missing = evaluateRun(input({ receipts: [], final: true }));
    expect(missing.webhookOk).toBe(false);
    expect(missing.failureStage).toBe('webhook');
    const late = evaluateRun(input({ receipts: [
      { event: 'call.created', record_id: 'call-1', received_at: iso(2_500 + SLI_THRESHOLDS.webhookLatencyMs + 1) },
      { event: 'job.created', record_id: 'job-1', received_at: iso(52_000) },
    ] }));
    expect(late.webhookOk).toBe(false);
    expect(late.webhookLatencyMs).toBeGreaterThan(SLI_THRESHOLDS.webhookLatencyMs);
  });

  it('counts a missing call row as a speech failure but never double counts booking/webhook', () => {
    const e = evaluateRun(input({ targetCall: null, job: null, receipts: [], final: true }));
    expect(e.status).toBe('failed');
    expect(e.failureStage).toBe('speech');
    const keys = e.slis.map((s) => s.sli).sort();
    expect(keys).toEqual(['answer_latency', 'asr_accuracy', 'availability']);
  });
});

describe('verification timing', () => {
  it('is final only after the grace window', () => {
    expect(isVerificationFinal(goodCall(), T0 + 60_000 + VERIFY_GRACE_MS - 1)).toBe(false);
    expect(isVerificationFinal(goodCall(), T0 + 60_000 + VERIFY_GRACE_MS)).toBe(true);
    expect(isVerificationFinal(goodCall({ endedAt: null }), T0 + 9e9)).toBe(false);
  });
  it('detects hung calls', () => {
    expect(isCallHung(iso(0), T0 + 9 * 60_000)).toBe(false);
    expect(isCallHung(iso(0), T0 + 11 * 60_000)).toBe(true);
  });
});

describe('buildProbeScript', () => {
  it('contains every utterance verbatim and in order', () => {
    const script = buildProbeScript(scenario);
    let last = -1;
    for (const u of scenario.utterances) {
      const idx = script.indexOf(u);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });
});
