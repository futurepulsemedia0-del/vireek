// Chaos: provider 5xx / timeout / network / auth failure => caller is NEVER met with silence,
// a missed-call record is ALWAYS created, the owner is alerted.
import { MockProvider, type MockFault } from "../../supabase/functions/_shared/voice/mockProvider.ts";
import { DEFAULT_BREAKER, INITIAL_BREAKER, evaluateBreaker, type Outcome } from "../../supabase/functions/_shared/voice-resilience/circuitBreaker.ts";
import { componentsFromScores, DEFAULT_LADDER, degradeFrom, initialLadder, stepLadder, targetLevel, ALL_HEALTHY } from "../../supabase/functions/_shared/voice-resilience/ladder.ts";
import { twimlForLevel, type FallbackCtx } from "../../supabase/functions/_shared/voice-resilience/twimlFallback.ts";
import { ensureMissedCallRecord, type MissedCallPorts, type MissedCallRow } from "../../supabase/functions/_shared/voice-resilience/missedCallGuard.ts";
import { Recorder, type ScenarioResult } from "./lib/harness.ts";

const CTX = { tenantId: "44444444-4444-4444-4444-444444444444" };
const fb: FallbackCtx = { businessName: "Acme Plumbing", forwardTargets: ["+15550009999"], language: "en", hook: (a) => `https://x.test/f?action=${a}` };

const hasSpeechOrRecord = (xml: string) => /<Say[ >]/.test(xml) && (/<Record /.test(xml) || /<Dial /.test(xml) || /<Hangup\/>/.test(xml));

export function guardPorts(): { ports: MissedCallPorts; rows: Map<string, MissedCallRow>; alerts: string[]; smsDown: boolean; set(v: boolean): void } {
  const rows = new Map<string, MissedCallRow>(); const alerts: string[] = []; let smsDown = false;
  return {
    rows, alerts, get smsDown() { return smsDown; }, set(v: boolean) { smsDown = v; },
    ports: {
      async insertCallIfAbsent(row) { if (!rows.has(row.vapi_call_id)) rows.set(row.vapi_call_id, row); },
      // mirrors voice-front-door: SMS first, in-app as the fallback; true if ANY channel took it
      async alertOwner(_o, title, body) { if (!smsDown) { alerts.push(`sms:${title}`); return true; } alerts.push(`inapp:${title}:${body.length > 0}`); return true; },
    },
  };
}

export async function run(): Promise<ScenarioResult> {
  const r = new Recorder("provider 5xx / timeout / network / auth");

  for (const fault of ["5xx", "timeout", "network", "auth", "rate_limited"] as MockFault[]) {
    const m = new MockProvider(); m.injectFault(fault);
    const res = await m.startOutboundCall(CTX, { assistantId: "a", phoneNumberId: "p", customerNumber: "+15551112222", variableValues: {} });
    r.check(`${fault}: operation fails with a typed error (no throw)`, !res.ok);
    r.eq(`${fault}: retryable flag`, !res.ok && res.error.retryable, fault !== "auth");
  }

  // Sustained 5xx on the engine => breaker opens => ladder escalates to L2 within the drill => TwiML never silent.
  let snap = INITIAL_BREAKER; let ladder = initialLadder(0); const hist: Outcome[] = [];
  let reached = -1;
  for (let min = 1; min <= 6; min++) {
    const now = min * 60_000;
    for (let i = 0; i < 6; i++) hist.push({ at: now - i * 5000, ok: false, latencyMs: 40 });
    const eng = evaluateBreaker(snap, hist, now, DEFAULT_BREAKER); snap = eng.snapshot;
    const comp = componentsFromScores({ "vapi|voice_engine": eng.score, "twilio|carrier": 100, "twilio|sms": 100 });
    ladder = stepLadder(ladder, targetLevel(comp), now, DEFAULT_LADDER).state;
    if (reached < 0 && ladder.level >= 2) reached = min;
  }
  r.check("sustained engine 5xx escalates to >= L2 within 6 simulated minutes", reached > 0 && reached <= 6, `reached=${reached}`);
  const xml = twimlForLevel(Math.max(ladder.level, 2) as 2 | 3 | 4, fb);
  r.check("degraded TwiML always speaks to the caller and offers capture/forward (never silence)", hasSpeechOrRecord(xml), xml.slice(0, 120));

  // Per-call failure (engine did not answer THIS call): degrade just this call.
  const next = degradeFrom(1, ALL_HEALTHY);
  r.eq("per-call degrade from L1 goes to L2 (voicemail)", next, 2);
  r.check("L2 TwiML contains <Record> (voicemail capture)", /<Record /.test(twimlForLevel(2, fb)));

  // Every level L2..L4 yields audible TwiML, even with no forwarding targets.
  for (const lvl of [2, 3, 4] as const) {
    r.check(`L${lvl} TwiML is audible with no forward targets`, hasSpeechOrRecord(twimlForLevel(lvl, { ...fb, forwardTargets: [] })));
  }

  // Missed-call record + owner alert regardless of whether SMS works.
  const g = guardPorts();
  const a = await ensureMissedCallRecord(g.ports, { ownerId: CTX.tenantId, callSid: "CA-5xx-1", callerPhone: "+15551112222", reason: "engine_unavailable" });
  r.eq("missed-call row created + owner alerted (SMS healthy)", a, { recorded: true, alerted: true });
  g.set(true);
  const b = await ensureMissedCallRecord(g.ports, { ownerId: CTX.tenantId, callSid: "CA-5xx-2", callerPhone: null, reason: "engine_no_answer" });
  r.eq("missed-call row created + owner alerted via in-app when SMS is down", b, { recorded: true, alerted: true });
  r.check("one row per call", g.rows.size === 2);
  return r.result();
}
