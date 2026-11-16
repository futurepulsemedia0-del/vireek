// Chaos: Twilio failures. SMS failover (twilio -> telnyx -> in-app), carrier down, and the honest limit:
// when Twilio itself is down no TwiML we serve can reach the caller (see report: carrier-side forwarding).
import { sendWithFailover, twilioSms, telnyxSms } from "../../supabase/functions/_shared/voice-resilience/adapters.ts";
import { componentsFromScores, targetLevel } from "../../supabase/functions/_shared/voice-resilience/ladder.ts";
import { twimlForLevel } from "../../supabase/functions/_shared/voice-resilience/twimlFallback.ts";
import { ensureMissedCallRecord } from "../../supabase/functions/_shared/voice-resilience/missedCallGuard.ts";
import { Recorder, type ScenarioResult } from "./lib/harness.ts";
import { guardPorts } from "./voice-provider-5xx.ts";

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

export async function run(): Promise<ScenarioResult> {
  const r = new Recorder("Twilio failure");

  // twilio 5xx -> telnyx
  const urls: string[] = [];
  const f = async (u: string) => { urls.push(u); return u.includes("twilio.com") ? res(503) : res(200, { data: { id: "tx1" } }); };
  const tw = twilioSms({ accountSid: "AC1", authToken: "t", from: "+15550000000", fetch: f });
  const tx = telnyxSms({ apiKey: "k", from: "+15550000001", fetch: f });
  const out = await sendWithFailover([tw, tx], { to: "+15551234567", body: "alert" });
  r.eq("Twilio SMS 503 fails over to Telnyx", [out.ok, out.providerId], [true, "telnyx"]);

  // both down -> reported as not sent, guard falls back to in-app and still alerts
  const fDown = async () => res(500);
  const both = await sendWithFailover([twilioSms({ accountSid: "AC1", authToken: "t", from: "+1", fetch: fDown }), telnyxSms({ apiKey: "k", from: "+1", fetch: fDown })], { to: "+1", body: "x" });
  r.eq("both SMS providers down is reported (not silent)", both.ok, false);
  const g = guardPorts(); g.set(true);
  const a = await ensureMissedCallRecord(g.ports, { ownerId: "66666666-6666-6666-6666-666666666666", callSid: "CA-tw-1", callerPhone: "+15557778888", reason: "forward_failed" });
  r.eq("owner still alerted (in-app) and lead recorded", a, { recorded: true, alerted: true });
  r.check("alert went through the in-app fallback", g.alerts.some((x) => x.startsWith("inapp:")));

  // thrown network error / timeout from Twilio is handled like a failure
  const fThrow = async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  const th = await sendWithFailover([twilioSms({ accountSid: "AC1", authToken: "t", from: "+1", fetch: fThrow })], { to: "+1", body: "x" });
  r.eq("Twilio timeout is a handled failure", th.ok, false);

  // engine + carrier both down => L4 static; TwiML is still audible if Twilio can serve it.
  const comp = componentsFromScores({ "vapi|voice_engine": 0, "twilio|carrier": 0 });
  const lvl = targetLevel(comp);
  r.eq("engine + carrier down => L4 (static message)", lvl, 4);
  r.check("L4 TwiML speaks and hangs up cleanly", /<Say[ >]/.test(twimlForLevel(4, { businessName: "Acme", forwardTargets: [], language: "en", hook: (a) => a })));
  return r.result();
}
