// NOT LIVE-VERIFIED: confirm Vapi's assistant `voice` schema (11labs fields incl. speed) before enabling apply.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sanitizeTuning } from "../_shared/voice-studio/logic.ts";
import { buildVapiPatch } from "../_shared/voice-studio/vapi.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const VAPI = "https://api.vapi.ai/assistant";

async function getAssistant(id: string, key: string) {
  const r = await fetch(`${VAPI}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok) return null;
  return (await r.json()) as { voice?: Record<string, unknown>; firstMessage?: string };
}

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
    if (allowed !== true) return json({ error: "You don't have permission to change the live voice." }, 403);
    const { data: owner, error: oe } = await authClient.rpc("get_account_owner_id");
    if (oe || typeof owner !== "string") throw oe ?? new Error("owner_not_resolved");

    let body: { apply?: unknown; useClone?: unknown } = {};
    try { body = await req.json(); } catch { /* empty body = dry run */ }
    const apply = body.apply === true;

    const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY") ?? "";
    let map: Record<string, string> = {};
    try { map = JSON.parse(Deno.env.get("VOICE_STUDIO_VOICE_MAP") ?? "{}"); } catch { /* unconfigured */ }
    if (!vapiKey) return json({ error: "Vapi isn't configured.", code: "vapi_unconfigured" }, 503);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: prof } = await admin.from("voice_studio_profiles").select("voice_key,tuning")
      .eq("user_id", owner).is("location_id", null).eq("scenario", "default").maybeSingle();
    if (!prof) return json({ error: "Save a Standard voice in Voice Studio first." }, 409);
    const { data: bp } = await admin.from("business_profile")
      .select("vapi_assistant_id,custom_voice_id,custom_voice_status").eq("user_id", owner).maybeSingle();
    if (!bp?.vapi_assistant_id) return json({ error: "No Vapi assistant is linked to this business." }, 409);

    let providerVoice = map[prof.voice_key];
    if (body.useClone === true) {
      const { data: ok } = await admin.from("voice_clone_consents").select("id")
        .eq("user_id", owner).eq("status", "approved").eq("provider_voice_id", bp.custom_voice_id ?? "").maybeSingle();
      if (bp.custom_voice_status !== "ready" || !bp.custom_voice_id || !ok) return json({ error: "No consented cloned voice is available." }, 403);
      providerVoice = bp.custom_voice_id;
    }
    if (!providerVoice) return json({ error: "This voice isn't configured yet.", code: "voice_unconfigured" }, 503);

    const patch = buildVapiPatch(providerVoice, sanitizeTuning(prof.tuning));
    const before = await getAssistant(bp.vapi_assistant_id, vapiKey);
    if (!before) return json({ error: "Could not read the live assistant.", code: "vapi_unreachable" }, 502);
    if (!apply) return json({ dryRun: true, current: before.voice ?? null, proposed: patch.voice });

    const log = (ok: boolean, detail: string) =>
      admin.from("voice_sync_log").insert({ user_id: owner, assistant_id: bp.vapi_assistant_id, ok, detail });
    const r = await fetch(`${VAPI}/${encodeURIComponent(bp.vapi_assistant_id)}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r || !r.ok) { await log(false, `patch_http_${r?.status ?? "network"}`); return json({ error: "Vapi rejected the update.", code: "vapi_patch_failed" }, 502); }

    const after = await getAssistant(bp.vapi_assistant_id, vapiKey);
    const verified = after?.voice?.voiceId === providerVoice && after?.firstMessage === before.firstMessage;
    await log(verified, verified ? "applied_verified" : "applied_unverified");
    return json({ applied: true, verified, firstMessageUnchanged: after?.firstMessage === before.firstMessage });
  } catch (e) {
    console.error("voice-studio-sync error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
