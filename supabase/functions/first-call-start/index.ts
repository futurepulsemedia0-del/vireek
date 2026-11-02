// supabase/functions/first-call-start/index.ts
//
// "Call Sarah now": rings the OWNER's phone with their own Sarah assistant via Vapi.
//   Owner (Authorization: Bearer <jwt>)
//     {action:"start", phone?:string, channel?:"phone"|"browser", notify_when_ready?:boolean}
//     {action:"cancel", session_id}
//   Cron  (header X-Cron-Secret = FIRST_CALL_CRON_SECRET), body {action:"sweep"}
//     texts owners who opted in ("text me when ready") once their number is live.
//
// Security: the caller's identity comes from the JWT; the tenant is the ACCOUNT OWNER id resolved server-side
// (a team member can never ring a number on another account). The destination is validated, allow-listed,
// premium-rate-blocked and rate-limited (3/hour, 8/day) BEFORE Vapi is called, and is never stored or logged
// in full. One in-flight session per account (unique index) makes a double click idempotent.
//
// Progress (ringing / answered / transcript / booking) is NOT written here: DB triggers advance the session from
// the live_calls / calls / jobs rows the existing vapi-webhook already writes (see the migration).
//
// Secrets: VAPI_PRIVATE_KEY (already used by outbound-dialer), FIRST_CALL_CRON_SECRET (sweep only),
//          FIRST_CALL_ALLOWED_CODES (optional, comma list of calling codes without +).
// NOT LIVE-VERIFIED against Vapi: confirm one real ring-back before release (see the verification checklist).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";
import { DEFAULT_ALLOWED_CODES, parseDestination, rateDecision, type FailureCode } from "../_shared/first-call/logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_COLS =
  "id,channel,status,failure_code,phone_calling_code,phone_last4,notify_when_ready,signup_at,requested_at,ringing_at,answered_at,first_transcript_at,booking_at,completed_at,call_id,job_id";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const allowedCodes = () => {
  const extra = (Deno.env.get("FIRST_CALL_ALLOWED_CODES") ?? "").split(",").map((s) => s.trim().replace(/\D/g, "")).filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_CODES, ...extra])];
};

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function resolveOwner(admin: SupabaseClient, userId: string): Promise<{ ownerId: string; created: string | null } | null> {
  const { data: p } = await admin.from("profiles").select("id,created_at,role").eq("id", userId).maybeSingle();
  if (!p) return null;
  if (p.role === "owner" || !p.role) return { ownerId: p.id, created: p.created_at ?? null };
  const { data: tm } = await admin.from("team_members").select("account_owner_id").eq("member_email", (await admin.auth.admin.getUserById(userId)).data.user?.email ?? "").maybeSingle();
  if (!tm?.account_owner_id) return null;
  const { data: o } = await admin.from("profiles").select("id,created_at").eq("id", tm.account_owner_id).maybeSingle();
  return o ? { ownerId: o.id, created: o.created_at ?? null } : null;
}

async function start(admin: SupabaseClient, userId: string, body: Row): Promise<Response> {
  const owner = await resolveOwner(admin, userId);
  if (!owner) return json({ error: "not_allowed" }, 403);
  const ownerId = owner.ownerId;
  const channel = body.channel === "browser" ? "browser" : "phone";

  // Idempotent: an in-flight session is returned as-is.
  const active = await admin.from("first_call_sessions").select(SESSION_COLS).eq("user_id", ownerId).in("status", ["created", "ringing", "in_call"]).maybeSingle();
  if (active.data) return json({ session: active.data, reused: true });

  const record = async (patch: Row) => {
    const { data, error } = await admin.from("first_call_sessions").insert({ user_id: ownerId, channel, signup_at: owner.created, ...patch }).select(SESSION_COLS).single();
    if (error) {
      // Lost a race with a concurrent start: hand back the winner.
      const again = await admin.from("first_call_sessions").select(SESSION_COLS).eq("user_id", ownerId).in("status", ["created", "ringing", "in_call"]).maybeSingle();
      if (again.data) return again.data;
      throw new Error("session_insert_failed");
    }
    return data;
  };
  const fail = async (code: FailureCode, status: "failed" | "waiting_for_number" = "failed", extra: Row = {}) =>
    json({ session: await record({ status, failure_code: code, completed_at: status === "failed" ? new Date().toISOString() : null, ...extra }) });

  // Browser path: the browser talks to Vapi directly; the server only records the attempt for the KPI.
  if (channel === "browser") return json({ session: await record({ status: "created" }) });

  const dest = parseDestination(String(body.phone ?? ""), allowedCodes());
  if (!dest.ok) return json({ error: dest.code, hint: dest.hint }, 422);

  const now = Date.now();
  const since = (ms: number) => new Date(now - ms).toISOString();
  const count = async (iso: string) =>
    (await admin.from("first_call_sessions").select("id", { count: "exact", head: true }).eq("user_id", ownerId).eq("channel", "phone").gte("requested_at", iso).not("status", "in", "(waiting_for_number)")).count ?? 0;
  const rate = rateDecision(await count(since(3_600_000)), await count(since(86_400_000)));
  if (!rate.allowed) return json({ error: "rate_limited", retry_after_seconds: rate.retryAfterSeconds }, 429);

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!vapiKey) return fail("not_configured");

  const { data: bp } = await admin.from("business_profile").select("vapi_assistant_id,vapi_phone_number_id,assistant_name,primary_industry").eq("user_id", ownerId).maybeSingle();
  const { data: prof } = await admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
  if (!bp?.vapi_assistant_id || !bp?.vapi_phone_number_id) {
    // Number/assistant not provisioned yet (A2P review, number activation, or manual setup pending): park the session.
    const optIn = body.notify_when_ready === true;
    return fail("number_pending", "waiting_for_number", {
      phone_calling_code: dest.callingCode,
      phone_last4: dest.last4,
      notify_when_ready: optIn,
      notify_phone_e164: optIn ? dest.e164 : null,
    });
  }

  const created = await record({ status: "created", phone_calling_code: dest.callingCode, phone_last4: dest.last4 });
  try {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: bp.vapi_assistant_id,
        phoneNumberId: bp.vapi_phone_number_id,
        customer: { number: dest.e164 },
        assistantOverrides: { variableValues: {
          customer_name: "you", call_purpose: "first_call_demo",
          company_name: prof?.company_name || "your business", assistant_name: bp.assistant_name || "Sarah", industry: bp.primary_industry || "home services",
        } },
      }),
    });
    if (!res.ok) {
      await admin.from("first_call_sessions").update({ status: "failed", failure_code: res.status === 429 ? "rate_limited" : "provider_error", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", created.id);
      const out = await admin.from("first_call_sessions").select(SESSION_COLS).eq("id", created.id).single();
      return json({ session: out.data });
    }
    const v = await res.json();
    const upd = await admin.from("first_call_sessions").update({ vapi_call_id: v.id ?? null, updated_at: new Date().toISOString() }).eq("id", created.id).select(SESSION_COLS).single();
    return json({ session: upd.data });
  } catch (_e) {
    await admin.from("first_call_sessions").update({ status: "failed", failure_code: "carrier_error", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", created.id);
    const out = await admin.from("first_call_sessions").select(SESSION_COLS).eq("id", created.id).single();
    return json({ session: out.data });
  }
}

async function cancel(admin: SupabaseClient, userId: string, body: Row): Promise<Response> {
  const owner = await resolveOwner(admin, userId);
  if (!owner) return json({ error: "not_allowed" }, 403);
  if (!UUID.test(String(body.session_id ?? ""))) return json({ error: "bad_request" }, 400);
  const { data, error } = await admin.from("first_call_sessions").update({ status: "canceled", failure_code: "canceled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", body.session_id).eq("user_id", owner.ownerId).in("status", ["created", "ringing", "waiting_for_number"]).select(SESSION_COLS).maybeSingle();
  if (error) return json({ error: "cancel_failed" }, 500);
  return json({ session: data }); // null when it had already finished: a harmless no-op
}

/** Cron: text opted-in owners whose number went live. The stored number is erased as soon as the SMS is sent. */
async function sweep(admin: SupabaseClient): Promise<Response> {
  const { data: rows } = await admin.from("first_call_sessions").select("id,user_id,notify_phone_e164").eq("status", "waiting_for_number").eq("notify_when_ready", true).not("notify_phone_e164", "is", null).is("notified_at", null).limit(50);
  let sent = 0;
  for (const r of rows ?? []) {
    const { data: bp } = await admin.from("business_profile").select("vapi_assistant_id,vapi_phone_number_id").eq("user_id", r.user_id).maybeSingle();
    if (!bp?.vapi_assistant_id || !bp?.vapi_phone_number_id) continue;
    // Claim first, send second: two overlapping sweeps can never text the same person twice.
    const claim = await admin.from("first_call_sessions").update({ notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", r.id).is("notified_at", null).select("id");
    if (!claim.data?.length) continue;
    const base = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const res = await sendSms(r.notify_phone_e164, `Vireek: your Sarah number is ready. Hear her answer your phone: ${base}/onboarding/first-call`);
    if (res.ok) {
      sent++;
      await admin.from("first_call_sessions").update({ notify_phone_e164: null, notify_when_ready: false, status: "canceled", failure_code: "number_pending", completed_at: new Date().toISOString() }).eq("id", r.id);
    } else {
      await admin.from("first_call_sessions").update({ notified_at: null }).eq("id", r.id); // retry next sweep
    }
  }
  return json({ sent });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  // deno-lint-ignore no-explicit-any
  let body: Row = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  if (body.action === "sweep") {
    const secret = Deno.env.get("FIRST_CALL_CRON_SECRET") ?? "";
    const got = req.headers.get("X-Cron-Secret") ?? "";
    if (!secret || !safeEqual(secret, got)) return json({ error: "unauthorized" }, 401);
    return await sweep(admin);
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!u.user) return json({ error: "not_authenticated" }, 401);
  try {
    if (body.action === "start") return await start(admin, u.user.id, body);
    if (body.action === "cancel") return await cancel(admin, u.user.id, body);
    return json({ error: "bad_request" }, 400);
  } catch {
    return json({ error: "server_error" }, 500);
  }
});
