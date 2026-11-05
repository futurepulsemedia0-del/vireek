// supabase/functions/csr-call-qa/index.ts
//
// Human CSR QA scorer (rubric "rules_v1": deterministic, evidence-backed, no model call, no extra cost).
// Runs AS the signed-in user for the permission check (can_view_csr_qa) and writes with the service role because
// csr_qa_reviews is SELECT-only for browsers (scores can't be forged client-side).
//
// Privacy: does nothing unless the OWNER switched QA on (csr_qa_settings.enabled, default false). Only calls that a
// person handled (calls.assigned_to is set, or a successful csr_call_actions "transfer") are scored.
// POLICY: scores are coaching input; discipline requires status = 'human_reviewed' (csr_qa_mark_reviewed).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyCallScenario } from "../_shared/call-scripts/logic.ts";
import { buildRecordingConsentNotice } from "../_shared/compliance/recordingConsent.ts";
import { scoreHumanCall } from "../_shared/csr-qa/qa.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CALLS = 10;

interface CallRow {
  id: string; call_datetime: string; transcript: string | null; caller_phone: string | null; assigned_to: string | null;
  is_emergency: boolean | null; intent: string | null; status: string | null; is_voicemail: boolean | null; booking_outcome: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u.user) return json({ error: "Unauthorized" }, 401);
  const [can, ownerRes] = await Promise.all([userClient.rpc("can_view_csr_qa"), userClient.rpc("get_account_owner_id")]);
  if (can.error || can.data !== true || ownerRes.error || typeof ownerRes.data !== "string") return json({ error: "Forbidden" }, 403);
  const owner = ownerRes.data as string;

  const { data: settings } = await admin.from("csr_qa_settings").select("enabled").eq("user_id", owner).maybeSingle();
  if (!(settings as { enabled?: boolean } | null)?.enabled) return json({ error: "CSR QA is turned off for this account." }, 409);

  let body: { call_ids?: unknown } = {};
  try { body = await req.json(); } catch { /* optional body */ }
  const requested = Array.isArray(body.call_ids) ? body.call_ids.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, MAX_CALLS) : [];

  const cols = "id, call_datetime, transcript, caller_phone, assigned_to, is_emergency, intent, status, is_voicemail, booking_outcome";
  let calls: CallRow[] = [];
  if (requested.length) {
    // RLS-scoped read: another account's call ids simply return nothing.
    const { data, error } = await userClient.from("calls").select(cols).in("id", requested);
    if (error) return json({ error: "Could not load calls" }, 500);
    calls = (data ?? []) as CallRow[];
  } else {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const { data: transfers } = await admin.from("csr_call_actions").select("call_id").eq("user_id", owner).eq("action", "transfer").eq("status", "success").gte("created_at", since).limit(200);
    const transferred = ((transfers ?? []) as { call_id: string | null }[]).map((t) => t.call_id).filter((x): x is string => !!x);
    const { data: assigned } = await userClient.from("calls").select(cols).not("assigned_to", "is", null).gte("call_datetime", since).not("transcript", "is", null).order("call_datetime", { ascending: false }).limit(60);
    const { data: viaTransfer } = transferred.length ? await userClient.from("calls").select(cols).in("id", transferred.slice(0, 60)).not("transcript", "is", null) : { data: [] };
    const merged = new Map<string, CallRow>();
    for (const c of [...((assigned ?? []) as CallRow[]), ...((viaTransfer ?? []) as CallRow[])]) merged.set(c.id, c);
    const existing = await admin.from("csr_qa_reviews").select("call_id").in("call_id", [...merged.keys()]);
    const done = new Set(((existing.data ?? []) as { call_id: string }[]).map((r) => r.call_id));
    calls = [...merged.values()].filter((c) => !done.has(c.id)).slice(0, MAX_CALLS);
  }

  let scored = 0, skipped = 0;
  for (const c of calls) {
    const res = scoreHumanCall(c.transcript, { recordingNoticeRequired: buildRecordingConsentNotice(c.caller_phone).length > 0 });
    if (!res.reviewable) { skipped++; continue; }
    const scenario = classifyCallScenario({ is_emergency: !!c.is_emergency, intent: c.intent, status: c.status ?? "", is_voicemail: !!c.is_voicemail, booking_outcome: c.booking_outcome }, false);
    const { error } = await admin.from("csr_qa_reviews").upsert({
      user_id: owner, call_id: c.id, agent_id: c.assigned_to, call_at: c.call_datetime, scenario, after_hours: false, language: null,
      rubric: res.rubric, scores: res.scores, overall: res.overall, clips: res.clips, coaching: res.coaching,
    }, { onConflict: "call_id", ignoreDuplicates: true }); // never overwrites a review a human already confirmed
    if (error) { console.error("[csr-call-qa] upsert failed", c.id, error.message); skipped++; } else scored++;
  }
  return json({ scored, skipped });
});
