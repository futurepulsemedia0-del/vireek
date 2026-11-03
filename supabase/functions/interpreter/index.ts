// supabase/functions/interpreter/index.ts
//
// Control plane for live interpretation. One function, four actions:
//
//   translate     (signed-in staff)  translate one line with glossary + critical-field
//                                    verification — dashboard captions and /dev playground
//   start_bridge  (signed-in staff)  create an interpreter session and move the live call
//                                    to the bridge number; the staff destination is resolved
//                                    HERE, never taken from the browser
//   set_session   (signed-in staff)  change mode (e.g. force captions) or caller language
//   ingest        (bridge worker)    persist turns / status; authenticated by an HMAC session
//                                    token, so the worker holds no database credential
//
// verify_jwt = false (see config.toml) because `ingest` is not a Supabase JWT; every other
// action validates the caller's JWT itself and checks can_view_live_calls(), exactly like
// live-call-control.
//
// Secrets: GEMINI_API_KEY (+ optional GEMINI_MODEL), INTERPRETER_BRIDGE_SECRET (>= 32 chars),
//          VAPI_PRIVATE_KEY (start_bridge), SUPABASE_URL / ANON / SERVICE_ROLE (auto).
// NOT LIVE-VERIFIED against Vapi/Twilio: see docs/INTERPRETER.md "Verification status".

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isValidE164, maskNumber } from "../_shared/live-calls/logic.ts";
import { verifyClaims } from "../_shared/interpreter/bridgeToken.ts";
import { geminiTranslate } from "../_shared/interpreter/gemini.ts";
import { normalizeInterpLang } from "../_shared/interpreter/languages.ts";
import { verifyTranslation } from "../_shared/interpreter/mt.ts";
import { detectEmergency } from "../_shared/interpreter/safety.ts";
import { identifyLanguage } from "../_shared/interpreter/langid.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODES = ["assistant", "bridge_consecutive", "bridge_simultaneous", "captions"] as const;
type Mode = (typeof MODES)[number];
const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
const VAPI_CALL_URL = "https://api.vapi.ai/call";

// Best-effort per-user limiter (per isolate): protects the translation budget from a runaway client.
const hits = new Map<string, number[]>();
function limited(userId: string, max = 40, windowMs = 60_000): boolean {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(userId, list);
  return list.length > max;
}

const clamp = (n: unknown, lo: number, hi: number): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null);
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (Number(req.headers.get("content-length") ?? 0) > 200_000) return json({ error: "Payload too large." }, 413);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    if (body.action === "ingest") return await ingest(admin, req, body);

    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const { data: allowed, error: permErr } = await authClient.rpc("can_view_live_calls");
    if (permErr) throw permErr;
    if (allowed !== true) return json({ error: "You don't have permission to manage live calls." }, 403);
    if (limited(user.id)) return json({ error: "Too many requests. Please slow down." }, 429);

    switch (body.action) {
      case "translate": return await translate(body);
      case "start_bridge": return await startBridge(admin, authClient, user, body);
      case "set_session": return await setSession(admin, authClient, user, body);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error("interpreter failed", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

// ------------------------------------------------------------------ translate
async function translate(body: Record<string, unknown>): Promise<Response> {
  const text = str(body.text, 1500)?.trim();
  const from = normalizeInterpLang(body.from);
  const to = normalizeInterpLang(body.to);
  if (!text || !from || !to || from === to) return json({ error: "text, from and to are required, and must differ." }, 400);
  const speaker = body.speaker === "staff" ? "staff" : "caller";
  const port = geminiTranslate({ apiKey: Deno.env.get("GEMINI_API_KEY") ?? "", model: Deno.env.get("GEMINI_MODEL") || undefined });
  const t0 = Date.now();
  const result = await port({ text, from, to, speaker });
  if (!result) return json({ error: "Translation is unavailable right now." }, 502);
  const v = verifyTranslation(text, from, result.text, to);
  return json({
    translated: result.text,
    confidence: result.confidence,
    latency_ms: Date.now() - t0,
    verification: {
      critical_ok: v.criticalOk,
      missing: v.diff.missing.map((e) => `${e.kind}:${e.value}`),
      extra: v.diff.extra.map((e) => `${e.kind}:${e.value}`),
      glossary_misses: v.glossaryMisses.map((h) => h.id),
      length_ok: v.lengthOk,
    },
    emergency: detectEmergency(text),
    detected: identifyLanguage(text),
  });
}

// --------------------------------------------------------------- start_bridge
interface Row { [k: string]: unknown }

async function loadSettings(admin: SupabaseClient, userId: string): Promise<Row | null> {
  const { data } = await admin.from("interpreter_settings").select("*").eq("user_id", userId).maybeSingle();
  return (data as Row | null) ?? null;
}

function pairingCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

async function vapiTransfer(vapiKey: string, vapiCallId: string, number: string, extension: string): Promise<void> {
  const callRes = await fetch(`${VAPI_CALL_URL}/${encodeURIComponent(vapiCallId)}`, { headers: { Authorization: `Bearer ${vapiKey}` }, signal: AbortSignal.timeout(8000) });
  if (!callRes.ok) throw new Error(`Vapi call lookup failed (${callRes.status})`);
  const controlUrl = ((await callRes.json()) as { monitor?: { controlUrl?: string } }).monitor?.controlUrl;
  if (!controlUrl) throw new Error("This call has no live control channel (it may have just ended).");
  const url = new URL(controlUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vapi.ai")) throw new Error("Unexpected control URL.");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "transfer", destination: { type: "number", number, extension }, content: "One moment please. I will stay on the line to interpret." }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Vapi transfer failed (${res.status})`);
}

async function startBridge(admin: SupabaseClient, authClient: SupabaseClient, user: { id: string; email?: string | null }, body: Record<string, unknown>): Promise<Response> {
  const vapiCallId = str(body.vapi_call_id, 200);
  const callerLang = normalizeInterpLang(body.caller_language);
  if (!vapiCallId || !callerLang || callerLang === "en") return json({ error: "vapi_call_id and a non-English caller_language are required." }, 400);

  // RLS-scoped read proves the call belongs to this account.
  const { data: live, error } = await authClient.from("live_calls").select("id, user_id, status").eq("vapi_call_id", vapiCallId).maybeSingle();
  if (error) throw error;
  if (!live) return json({ error: "Call not found." }, 404);
  if (live.status !== "in_progress") return json({ error: "That call is not in progress any more." }, 409);

  const settings = await loadSettings(admin, live.user_id as string);
  const enabled = (settings?.enabled_languages as string[] | undefined) ?? [];
  if (!settings?.enabled) return json({ error: "Live interpretation is not turned on for this business." }, 409);
  if (!enabled.includes(callerLang)) return json({ error: "That language is not enabled in interpreter settings." }, 422);
  const bridgeNumber = settings.bridge_number as string | null;
  if (!isValidE164(bridgeNumber)) return json({ error: "Set the interpreter bridge number in settings first." }, 422);

  const requested = isMode(body.mode) ? body.mode : (settings.default_mode as string);
  const mode: Mode = requested === "bridge_simultaneous" ? "bridge_simultaneous" : requested === "captions" ? "captions" : "bridge_consecutive";

  const [{ data: owner }, { data: bp }] = await Promise.all([
    admin.from("profiles").select("forwarding_number").eq("id", live.user_id).maybeSingle(),
    admin.from("business_profile").select("escalation_rules").eq("user_id", live.user_id).maybeSingle(),
  ]);
  const rules = (bp?.escalation_rules ?? []) as { trigger?: string; action?: string; target?: string }[];
  const rule = rules.find((r) => r.trigger === "human_request" && r.action === "transfer" && isValidE164(r.target));
  const staffDestination = rule?.target ?? (owner?.forwarding_number as string | null) ?? null;
  if (!isValidE164(staffDestination)) return json({ error: "No team transfer number is set. Add a forwarding number in your business settings." }, 422);

  const { data: callRow } = await admin.from("calls").select("id").eq("vapi_call_id", vapiCallId).eq("user_id", live.user_id).maybeSingle();

  let session: Row | null = null;
  for (let i = 0; i < 5 && !session; i++) {
    const ins = await admin.from("interpreter_sessions").insert({
      user_id: live.user_id, call_id: callRow?.id ?? null, vapi_call_id: vapiCallId, mode, caller_language: callerLang,
      status: "pending", pairing_code: pairingCode(), staff_destination: staffDestination, training_consent: false,
    }).select("id, pairing_code").maybeSingle();
    if (!ins.error) { session = ins.data as Row; break; }
    if (ins.error.code === "23505" && String(ins.error.message).includes("vapi_call")) return json({ error: "Interpretation is already set up for this call." }, 409);
    if (ins.error.code !== "23505") throw ins.error;
  }
  if (!session) return json({ error: "Could not allocate a session. Please try again." }, 503);

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!vapiKey) return json({ error: "Live call control is not configured on the server." }, 500);
  try {
    await vapiTransfer(vapiKey, vapiCallId, bridgeNumber as string, session.pairing_code as string);
  } catch (e) {
    await admin.from("interpreter_sessions").update({ status: "failed", handoff_reason: (e instanceof Error ? e.message : "transfer failed").slice(0, 200), ended_at: new Date().toISOString() }).eq("id", session.id);
    console.error("interpreter_transfer_failed", e instanceof Error ? e.message : e);
    return json({ error: "Could not connect the interpreter. The call may have just ended." }, 502);
  }
  await admin.from("audit_log").insert({
    user_id: live.user_id, actor_id: user.id, actor_email: user.email ?? null, action: "interpreter.start_bridge",
    target_table: "interpreter_sessions", target_id: session.id as string,
  });
  return json({ ok: true, session_id: session.id, mode, staff_hint: maskNumber(staffDestination as string) });
}

// ---------------------------------------------------------------- set_session
async function setSession(admin: SupabaseClient, authClient: SupabaseClient, user: { id: string; email?: string | null }, body: Record<string, unknown>): Promise<Response> {
  const id = str(body.session_id, 64);
  if (!id) return json({ error: "session_id is required." }, 400);
  const { data: s, error } = await authClient.from("interpreter_sessions").select("id, user_id, status").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!s) return json({ error: "Session not found." }, 404);
  if (s.status === "ended" || s.status === "failed") return json({ error: "That session has ended." }, 409);
  const patch: Row = {};
  if (body.mode !== undefined) {
    if (!isMode(body.mode)) return json({ error: "Unknown mode." }, 400);
    patch.mode = body.mode;
  }
  if (body.caller_language !== undefined) {
    const l = normalizeInterpLang(body.caller_language);
    const settings = await loadSettings(admin, s.user_id as string);
    if (!l || (l !== "en" && !((settings?.enabled_languages as string[] | undefined) ?? []).includes(l))) return json({ error: "That language is not enabled." }, 422);
    patch.caller_language = l;
  }
  if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);
  const { error: upErr } = await admin.from("interpreter_sessions").update(patch).eq("id", id).eq("user_id", s.user_id);
  if (upErr) throw upErr;
  await admin.from("audit_log").insert({ user_id: s.user_id, actor_id: user.id, actor_email: user.email ?? null, action: "interpreter.set_session", target_table: "interpreter_sessions", target_id: id });
  return json({ ok: true, ...patch });
}

// --------------------------------------------------------------------- ingest
async function ingest(admin: SupabaseClient, req: Request, body: Record<string, unknown>): Promise<Response> {
  const secret = Deno.env.get("INTERPRETER_BRIDGE_SECRET") ?? "";
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claims = await verifyClaims(token, secret);
  if (!claims || claims.role !== "worker") return json({ error: "Unauthorized." }, 401);

  const { data: session } = await admin.from("interpreter_sessions").select("id, user_id, call_id, caller_language, mode, status").eq("id", claims.sid).eq("user_id", claims.uid).maybeSingle();
  if (!session) return json({ error: "Session not found." }, 404);

  const turnsIn = Array.isArray(body.turns) ? (body.turns as Record<string, unknown>[]).slice(0, 50) : [];
  const rows = [];
  let emergency = false;
  for (const t of turnsIn) {
    const from = normalizeInterpLang(t.from), to = normalizeInterpLang(t.to);
    const seq = typeof t.seq === "number" && Number.isInteger(t.seq) && t.seq >= 0 && t.seq < 100_000 ? t.seq : null;
    const original = str(t.original, 4000);
    if (!from || !to || seq === null || original === null || (t.speaker !== "caller" && t.speaker !== "staff")) continue;
    const kinds = Array.isArray(t.emergency) ? (t.emergency as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 8) : [];
    if (kinds.length) emergency = true;
    rows.push({
      session_id: claims.sid, user_id: claims.uid, seq, speaker: t.speaker, from_lang: from, to_lang: to, original,
      translated: str(t.translated, 8000), asr_confidence: clamp(t.asrConfidence, 0, 1), mt_confidence: clamp(t.mtConfidence, 0, 1),
      action: str(t.action, 40) ?? "relay", reason: str(t.reason, 80), critical: typeof t.critical === "object" && t.critical ? t.critical : {},
      emergency: kinds, added_ms: (() => { const v = clamp(t.addedMs, 0, 600_000); return v === null ? null : Math.round(v); })(),
      flags: Array.isArray(t.flags) ? (t.flags as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 12) : [],
    });
  }
  if (rows.length) {
    const { error } = await admin.from("interpreter_turns").upsert(rows, { onConflict: "session_id,seq", ignoreDuplicates: true });
    if (error) throw error;
  }

  const s = (typeof body.session === "object" && body.session ? body.session : {}) as Record<string, unknown>;
  const patch: Row = {};
  if (s.started === true && session.status === "pending") { patch.status = "active"; patch.started_at = new Date().toISOString(); }
  if (s.disclosure_played === true) patch.disclosure_played_at = new Date().toISOString();
  const p50 = clamp(s.p50, 0, 600_000), p95 = clamp(s.p95, 0, 600_000);
  if (p50 !== null) patch.p50_added_ms = Math.round(p50);
  if (p95 !== null) patch.p95_added_ms = Math.round(p95);
  if (typeof s.degraded === "boolean") patch.degraded = s.degraded;
  if (typeof s.handoff_reason === "string") patch.handoff_reason = s.handoff_reason.slice(0, 200);
  if (s.ended === true) { patch.status = "ended"; patch.ended_at = new Date().toISOString(); }
  if (Object.keys(patch).length) await admin.from("interpreter_sessions").update(patch).eq("id", claims.sid);

  if (session.call_id) {
    if (emergency) await admin.from("calls").update({ is_emergency: true }).eq("id", session.call_id).eq("user_id", claims.uid);
    if (s.ended === true) {
      await admin.from("calls").update({ interpreter_language: session.caller_language, interpretation_mode: session.mode }).eq("id", session.call_id).eq("user_id", claims.uid);
      const { data: call } = await admin.from("calls").select("caller_phone").eq("id", session.call_id).maybeSingle();
      const lang = normalizeInterpLang(session.caller_language);
      if (call?.caller_phone && lang && lang !== "en") await admin.rpc("record_spoken_language", { p_user_id: claims.uid, p_phone: call.caller_phone, p_language: lang });
    }
  }
  // Staff overrides (force captions, switch language) flow back to the worker here.
  const { data: now } = await admin.from("interpreter_sessions").select("mode, caller_language, status").eq("id", claims.sid).maybeSingle();
  return json({ ok: true, mode: now?.mode, caller_language: now?.caller_language, status: now?.status });
}
