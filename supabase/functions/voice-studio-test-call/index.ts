// "Call my phone with this voice". Dials ONLY the owner's own profiles.escalation_phone.
// NOT LIVE-VERIFIED: confirm Vapi POST /call accepts assistantOverrides.{voice,firstMessage,maxDurationSeconds}.
// Caveat: vapi-webhook will see this as a normal call for the tenant; verify it creates no lead/booking.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { prepareSpeechText, sanitizeTuning } from "../_shared/voice-studio/logic.ts";
import { buildVapiVoice } from "../_shared/voice-studio/vapi.ts";
import { isValidE164 } from "../_shared/voice-hardening/escalation.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const VOICE_KEYS = new Set([
  "sarah-warm-f-us", "aria-friendly-f-us", "maya-calm-f-uk",
  "miles-confident-m-us", "jay-easygoing-m-us", "oliver-polished-m-uk",
]);
const DAILY_LIMIT = 5;
// Fixed, non-user-editable text: keeps the AI disclosure and blocks abuse of the caller ID.
const TEST_LINE = "Hi, this is a test call from your AI voice assistant. This is how I sound on a phone line. You can hang up at any time.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const { data: allowed, error: pe } = await authClient.rpc("can_edit_call_scripts");
    if (pe) throw pe;
    if (allowed !== true) return json({ error: "You don't have permission to place test calls." }, 403);
    const { data: owner, error: oe } = await authClient.rpc("get_account_owner_id");
    if (oe || typeof owner !== "string") throw oe ?? new Error("owner_not_resolved");

    let body: { voiceKey?: unknown; tuning?: unknown };
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
    const voiceKey = String(body?.voiceKey ?? "");
    if (!VOICE_KEYS.has(voiceKey)) return json({ error: "Unknown voice." }, 400);

    const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY") ?? "";
    let map: Record<string, string> = {};
    try { map = JSON.parse(Deno.env.get("VOICE_STUDIO_VOICE_MAP") ?? "{}"); } catch { /* unconfigured */ }
    if (!vapiKey || !map[voiceKey]) return json({ error: "Test calls aren't configured yet.", code: "unconfigured" }, 503);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: prof } = await admin.from("profiles").select("escalation_phone").eq("id", owner).maybeSingle();
    if (!isValidE164(prof?.escalation_phone)) {
      return json({ error: "Add a valid escalation phone number in your settings first.", code: "no_phone" }, 409);
    }
    const { data: bp } = await admin.from("business_profile").select("vapi_assistant_id,vapi_phone_number_id").eq("user_id", owner).maybeSingle();
    if (!bp?.vapi_assistant_id || !bp?.vapi_phone_number_id) return json({ error: "Your phone line isn't linked yet.", code: "no_line" }, 409);

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count, error: ce } = await admin.from("voice_test_calls").select("id", { count: "exact", head: true }).eq("user_id", owner).gte("created_at", since);
    if (ce) throw ce;
    if ((count ?? 0) >= DAILY_LIMIT) return json({ error: "Daily test-call limit reached.", code: "rate_limited" }, 429);

    const tuning = sanitizeTuning(body?.tuning);
    const r = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: bp.vapi_assistant_id,
        phoneNumberId: bp.vapi_phone_number_id,
        customer: { number: prof!.escalation_phone },
        assistantOverrides: {
          voice: buildVapiVoice(map[voiceKey], tuning),
          firstMessage: prepareSpeechText(TEST_LINE, tuning),
          maxDurationSeconds: 45,
        },
      }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);

    const ok = !!r && r.ok;
    await admin.from("voice_test_calls").insert({ user_id: owner, ok });
    if (!ok) return json({ error: "The call could not be placed. Try again shortly.", code: "vapi_failed" }, 502);
    return json({ ok: true });
  } catch (e) {
    console.error("voice-studio-test-call error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
