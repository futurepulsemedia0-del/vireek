// supabase/functions/voice-reconcile/index.ts
//
// Cron (suggested every 15 min). Compares the engine's call log (Vapi) with `calls`, and recovers missing calls by
// replaying a rebuilt end-of-call-report through the NORMAL vapi-webhook (so ledger idempotency, tenant resolution,
// PCI redaction and all downstream automations apply). Also recovers carrier-only inbound calls on front-door numbers
// as callback-needed records. Pages (SLO channel) when anything stays unrecovered.
//
// Secrets: VAPI_PRIVATE_KEY, VAPI_SERVER_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SLO_ALERT_WEBHOOK_URL (optional).
// Body (optional): { "hours": 6, "maxRecover": 25 }.  Deploy: --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import { twilioCarrier, vapiEngine } from "../_shared/voice-resilience/adapters.ts";
import { diffCalls, gapSeverity, toEndOfCallReport } from "../_shared/voice-resilience/reconcile.ts";

type Admin = ReturnType<typeof createClient>;
const GRACE_MS = 10 * 60_000;

async function replayThroughWebhook(message: Record<string, unknown>): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL"), secret = Deno.env.get("VAPI_SERVER_SECRET");
  if (!base || !secret) return false;
  const res = await fetch(`${base}/functions/v1/vapi-webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-vapi-secret": secret, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}` },
    body: JSON.stringify({ message }), signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  return !!res && res.ok;
}

async function reconcileEngine(admin: Admin, hours: number, maxRecover: number) {
  const key = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!key) return { skipped: "VAPI_PRIVATE_KEY missing" };
  const engine = vapiEngine({ privateKey: key });
  const now = Date.now();
  const since = new Date(now - hours * 3_600_000), until = new Date(now);
  const provider = await engine.listCalls({ since, until, limit: 1000 });
  const ids = provider.map((p) => p.providerCallId);
  const internal: { providerCallId: string; durationSeconds: number | null }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("calls").select("vapi_call_id, duration_seconds").in("vapi_call_id", ids.slice(i, i + 200));
    for (const r of data ?? []) internal.push({ providerCallId: String(r.vapi_call_id), durationSeconds: r.duration_seconds ?? null });
  }
  const diff = diffCalls(provider, internal, { graceMs: GRACE_MS, now, minDurationSeconds: 0 });

  let recovered = 0, unrecovered = 0;
  for (const m of diff.missing.slice(0, maxRecover)) {
    let ok = false;
    try {
      const call = await engine.getCall(m.providerCallId);
      if (call) ok = await replayThroughWebhook(toEndOfCallReport(call));
    } catch { ok = false; }
    // Confirm the row exists now (the webhook answers 200 even for calls it cannot attribute to a tenant).
    if (ok) {
      const { data } = await admin.from("calls").select("id").eq("vapi_call_id", m.providerCallId).maybeSingle();
      ok = !!data;
    }
    ok ? (recovered += 1) : (unrecovered += 1);
  }
  unrecovered += Math.max(0, diff.missing.length - maxRecover);
  return { compared: provider.length, missing: diff.missing.length, recovered, unrecovered, orphaned: diff.orphaned.length, durationMismatch: diff.durationMismatch.length };
}

async function reconcileCarrier(admin: Admin, hours: number) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!sid || !tok) return { skipped: "Twilio credentials missing" };
  const { data: orgs } = await admin.from("voice_org_resilience").select("user_id").eq("front_door_enabled", true);
  const owners = (orgs ?? []).map((o: { user_id: string }) => o.user_id);
  if (!owners.length) return { skipped: "no front-door orgs" };
  const { data: nums } = await admin.from("phone_numbers").select("phone_number, account_id").in("account_id", owners);
  const numToOwner = new Map((nums ?? []).map((n: { phone_number: string; account_id: string }) => [n.phone_number, n.account_id]));
  const now = Date.now();
  const all = await twilioCarrier({ accountSid: sid, authToken: tok }).listCalls({ since: new Date(now - hours * 3_600_000), until: new Date(now), limit: 1000 });
  const mine = all.filter((c) => c.to && numToOwner.has(c.to));
  const sids = mine.map((c) => c.providerCallId);
  const known = new Set<string>();
  for (let i = 0; i < sids.length; i += 200) {
    const { data } = await admin.from("voice_fallback_calls").select("call_sid").in("call_sid", sids.slice(i, i + 200));
    for (const r of data ?? []) known.add(String(r.call_sid));
  }
  // Calls handed to the engine are recorded as 'entered' at the door, so any carrier call with no door record never reached us.
  const diff = diffCalls(mine, [...known].map((s) => ({ providerCallId: s, durationSeconds: null })), { graceMs: GRACE_MS, now, minDurationSeconds: 0 });
  let recovered = 0;
  for (const m of diff.missing.slice(0, 50)) {
    const owner = numToOwner.get(m.to ?? "");
    if (!owner) continue;
    await admin.from("calls").upsert({ user_id: owner, vapi_call_id: `twilio:${m.providerCallId}`, caller_phone: m.from, status: "new_lead", source_channel: "carrier_reconcile", summary: "Missed call recovered from the carrier log (no recording or transcript). Please call back." }, { onConflict: "vapi_call_id" });
    await admin.from("voice_fallback_calls").upsert({ user_id: owner, call_sid: m.providerCallId, level: 4, outcome: "abandoned", caller_phone: m.from }, { onConflict: "call_sid" });
    recovered += 1;
  }
  return { compared: mine.length, missing: diff.missing.length, recovered, unrecovered: 0 };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const body = (await req.json().catch(() => ({}))) as { hours?: number; maxRecover?: number };
  const hours = Math.min(48, Math.max(1, Number(body.hours) || 6));
  const maxRecover = Math.min(100, Math.max(1, Number(body.maxRecover) || 25));

  const results: Record<string, unknown> = {};
  let worst: "none" | "warn" | "page" = "none";
  for (const [name, fn] of [["vapi", () => reconcileEngine(admin, hours, maxRecover)], ["twilio", () => reconcileCarrier(admin, hours)]] as const) {
    const t = new Date();
    try {
      const r = (await fn()) as Record<string, number | string>;
      results[name] = r;
      if (typeof r.compared === "number") {
        const sev = gapSeverity({ missingBefore: Number(r.missing), unrecovered: Number(r.unrecovered), compared: Number(r.compared) });
        if (sev === "page" || (sev === "warn" && worst === "none")) worst = sev;
        await admin.from("voice_reconcile_runs").insert({
          provider_id: name, range_start: new Date(t.getTime() - hours * 3_600_000).toISOString(), range_end: t.toISOString(),
          compared: r.compared, missing: r.missing, recovered: r.recovered, unrecovered: r.unrecovered, orphaned: Number(r.orphaned ?? 0), duration_mismatch: Number(r.durationMismatch ?? 0), severity: sev,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[name] = { error: msg };
      worst = "page"; // a reconcile that cannot run is itself a gap in coverage
      await admin.from("voice_reconcile_runs").insert({ provider_id: name, range_start: new Date(t.getTime() - hours * 3_600_000).toISOString(), range_end: t.toISOString(), severity: "page", error: msg.slice(0, 300) });
    }
  }
  // Last resort for ledger rows still dead: minimal rows (no transcript) are better than nothing.
  await admin.rpc("replay_dead_voice_events").then(() => null, () => null);

  const hook = Deno.env.get("SLO_ALERT_WEBHOOK_URL");
  if (worst !== "none" && hook) {
    await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${worst === "page" ? "🚨" : "⚠️"} Voice reconcile found gaps: ${JSON.stringify(results)}` }) }).catch(() => null);
  }
  return json({ severity: worst, results });
});
