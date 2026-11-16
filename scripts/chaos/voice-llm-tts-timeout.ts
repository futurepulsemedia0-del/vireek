// Chaos: LLM timeout / TTS failure inside the voice engine. These are NOT directly observable from our side:
// they surface (a) as an end-of-call-report whose endedReason is a pipeline error and (b) as latency/failure in
// the engine health signal. Both paths are asserted.
import { VapiProvider } from "../../supabase/functions/_shared/voice/vapiProvider.ts";
import { DEFAULT_BREAKER, INITIAL_BREAKER, evaluateBreaker, type Outcome } from "../../supabase/functions/_shared/voice-resilience/circuitBreaker.ts";
import { componentsFromScores, targetLevel } from "../../supabase/functions/_shared/voice-resilience/ladder.ts";
import { ensureMissedCallRecord } from "../../supabase/functions/_shared/voice-resilience/missedCallGuard.ts";
import { Recorder, type ScenarioResult } from "./lib/harness.ts";
import { guardPorts } from "./voice-provider-5xx.ts";

const vapi = new VapiProvider({ apiKey: "k", webhookSecret: "s" });

export async function run(): Promise<ScenarioResult> {
  const r = new Recorder("LLM timeout / TTS failure");
  for (const reason of ["pipeline-error-openai-llm-failed", "pipeline-error-eleven-labs-failed", "pipeline-error-azure-voice-failed", "assistant-error"]) {
    const p = vapi.parseWebhook(JSON.stringify({ message: { type: "end-of-call-report", endedReason: reason, call: { id: `c-${reason}` }, durationSeconds: 3 } }));
    const ok = p.ok && p.event.type === "call.ended";
    r.check(`${reason}: parsed as call.ended`, ok);
    if (!p.ok || p.event.type !== "call.ended") continue;
    r.check(`${reason}: flagged providerFailure (not a normal hang-up)`, p.event.providerFailure);
    // A provider-failed call with no transcript must still become a lead + alert.
    const g = guardPorts();
    const res = await ensureMissedCallRecord(g.ports, { ownerId: "55555555-5555-5555-5555-555555555555", callSid: p.event.providerCallId!, callerPhone: null, reason: "engine_unavailable" });
    r.eq(`${reason}: lead row + alert`, res, { recorded: true, alerted: true });
  }
  const normal = vapi.parseWebhook(JSON.stringify({ message: { type: "end-of-call-report", endedReason: "customer-ended-call", call: { id: "ok" } } }));
  r.check("normal hang-up is not flagged as provider failure", normal.ok && normal.event.type === "call.ended" && !normal.event.providerFailure);

  // LLM timeout seen as engine latency: p95 of 9s must degrade health (L1 at least), without being "down".
  let snap = INITIAL_BREAKER; const hist: Outcome[] = [];
  let score = 100;
  for (let m = 1; m <= 5; m++) {
    for (let i = 0; i < 6; i++) hist.push({ at: m * 60_000 - i * 5000, ok: true, latencyMs: 9000 });
    const e = evaluateBreaker(snap, hist, m * 60_000, DEFAULT_BREAKER); snap = e.snapshot; score = e.score;
  }
  r.check("9 s engine latency lowers the health score", score < 100, `score=${score}`);
  r.check("ladder target is >= L1 for the latency spike", targetLevel(componentsFromScores({ "vapi|voice_engine": score })) >= 1, `score=${score}`);
  return r.result();
}
