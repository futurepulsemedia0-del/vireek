// Chaos: webhook duplicates / delay / out-of-order / replay / missing final webhook / ledger down.
// Uses the REAL ledger state machine (claimEvent/completeEvent/failEvent), VapiProvider.parseWebhook and the
// REAL reconcile functions. The 3-step protocol below mirrors vapi-webhook's end-of-call-report path.
import { claimEvent, completeEvent, failEvent, MAX_ATTEMPTS } from "../../supabase/functions/_shared/voice-hardening/ledger.ts";
import { VapiProvider } from "../../supabase/functions/_shared/voice/vapiProvider.ts";
import { diffCalls, toEndOfCallReport } from "../../supabase/functions/_shared/voice-resilience/reconcile.ts";
import { FakeWorld, MemoryLedgerStore, Recorder, jitter, type ScenarioResult } from "./lib/harness.ts";

const OWNER = "33333333-3333-3333-3333-333333333333";
const vapi = new VapiProvider({ apiKey: "k", webhookSecret: "s" });
const body = (o: Record<string, unknown>) => JSON.stringify({ message: o });
const report = (id: string, transcript = "I need a plumber") =>
  body({ type: "end-of-call-report", endedReason: "customer-ended-call", call: { id }, artifact: { transcript } });

/** One delivery through parse -> claim -> side effect -> complete/fail. Returns what happened. */
async function deliver(store: MemoryLedgerStore, world: FakeWorld, raw: string) {
  const p = vapi.parseWebhook(raw);
  if (!p.ok || p.event.type !== "call.ended" || !p.event.providerCallId) return "ignored" as const;
  const ev = p.event;
  if (ev.dedupeKey.includes(":status:")) return "thin_event_ignored_by_ledger" as const; // only the report is ledgered (as in prod)
  const claim = await claimEvent(store, { userId: OWNER, vapiCallId: ev.providerCallId!, eventType: "end-of-call-report" });
  if (claim.decision === "duplicate") return "duplicate" as const;
  if (claim.decision === "dead") return "dead" as const;
  try {
    world.writeLead(ev.providerCallId!, ev.transcript);
    await completeEvent(store, claim.id);
    return "processed" as const;
  } catch (e) {
    const { dead } = await failEvent(store, claim.id, claim.attempts, e instanceof Error ? e.message : "err", {});
    return dead ? ("dead" as const) : ("failed" as const);
  }
}

export async function run(): Promise<ScenarioResult> {
  const r = new Recorder("webhook delay / duplicates / out-of-order / replay");

  { // 1. sequential duplicates
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    const out: string[] = [];
    for (let i = 0; i < 5; i++) out.push(await deliver(s, w, report("c1")));
    r.eq("5 sequential duplicates -> exactly 1 lead write", w.leadWrites, 1);
    r.eq("first processed, rest duplicate", out, ["processed", "duplicate", "duplicate", "duplicate", "duplicate"]);
  }
  { // 2. concurrent duplicates with random network delay
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    await Promise.all(Array.from({ length: 25 }, async () => { await jitter(15); await deliver(s, w, report("c2")); }));
    r.eq("25 concurrent duplicates (random delay) -> exactly 1 lead write", w.leadWrites, 1);
  }
  { // 3. out-of-order: thin status-update(ended) BEFORE the rich report must not shadow it
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    const first = await deliver(s, w, body({ type: "status-update", status: "ended", call: { id: "c3" } }));
    const second = await deliver(s, w, report("c3", "burst pipe at 12 Oak St"));
    r.eq("thin ended event does not claim the ledger", first, "thin_event_ignored_by_ledger");
    r.eq("rich report still processed afterwards", second, "processed");
    r.eq("lead keeps the transcript (no data loss)", w.leads.get("c3")?.transcript, "burst pipe at 12 Oak St");
  }
  { // 4. delayed replay long after processing
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    await deliver(s, w, report("c4"));
    s.clock = () => Date.now() + 6 * 3600_000; // 6h later
    r.eq("replay 6h later is a duplicate", await deliver(s, w, report("c4")), "duplicate");
    r.eq("still one lead", w.leadWrites, 1);
  }
  { // 5. DB failure then retry => recovered; and exhaustion => dead (provider told 200 by caller)
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    w.failLeadWrites = 1;
    r.eq("first delivery fails (DB down)", await deliver(s, w, report("c5")), "failed");
    r.eq("no lead yet", w.leadWrites, 0);
    r.eq("provider retry succeeds", await deliver(s, w, report("c5")), "processed");
    r.eq("exactly one lead after recovery", w.leadWrites, 1);
    const s2 = new MemoryLedgerStore(), w2 = new FakeWorld();
    w2.failLeadWrites = 99;
    let last = "";
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) last = await deliver(s2, w2, report("c5b"));
    r.check("exhausted retries end in dead-letter, not an infinite loop", last === "dead" || last === "failed", last);
    r.check("dead-lettered event is retained in the ledger for manual replay", [...s2.rows.values()].some((x) => x.status === "dead"));
  }
  { // 6. missing final webhook -> reconcile recovers through the SAME ledger; late real webhook then dedupes
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    const now = Date.now();
    const providerCalls = [{ providerCallId: "c6", to: "+1", from: "+2", startedAt: new Date(now - 700_000).toISOString(), endedAt: new Date(now - 600_000).toISOString(), status: "ended" as const, durationSeconds: 100 }];
    const diff = diffCalls(providerCalls, [], { graceMs: 300_000, now });
    r.eq("reconcile detects the call with no webhook", diff.missing.map((m) => m.providerCallId), ["c6"]);
    const synthetic = JSON.stringify({ message: toEndOfCallReport({ id: "c6", startedAt: providerCalls[0].startedAt, endedAt: providerCalls[0].endedAt, endedReason: "customer-ended-call", artifact: { transcript: "recovered" } }) });
    r.eq("recovered report is processed once", await deliver(s, w, synthetic), "processed");
    r.eq("late genuine webhook is a duplicate", await deliver(s, w, report("c6")), "duplicate");
    r.eq("exactly one lead, nothing lost", w.leadWrites, 1);
    r.eq("after recovery reconcile no longer reports it missing", diffCalls(providerCalls, [{ providerCallId: "c6", durationSeconds: 100 }], { graceMs: 300_000, now }).missing.length, 0);
  }
  { // 7. ledger unavailable => fails OPEN: lead is still created (duplicates become possible; documented trade-off)
    const s = new MemoryLedgerStore(), w = new FakeWorld();
    s.down = true;
    r.eq("ledger down: event still processed (no lost lead)", await deliver(s, w, report("c7")), "processed");
    r.eq("lead exists", w.leadWrites, 1);
  }
  return r.result();
}
