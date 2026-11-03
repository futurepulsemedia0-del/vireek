import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getFeatureGate } from "../_shared/ai-transparency/gate.ts";
import { CONSENT_TEXT_V1, CONSENT_VERSION, RELATIONSHIPS, generateLivenessPhrase, sha256Hex } from "../_shared/voice-studio/consent.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const CLONE_PLANS = ["business", "enterprise"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "Invalid or expired session." }, 401);
    const user = u.user;

    const { data: prof } = await admin.from("profiles").select("role, plan").eq("id", user.id).maybeSingle();
    if (prof?.role !== "owner") return json({ error: "Only the account owner can manage voice cloning." }, 403);
    if (!CLONE_PLANS.includes(prof.plan ?? "")) return json({ error: "Voice cloning requires the Business plan.", code: "plan_required" }, 403);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }

    if (body.action === "start") {
      const gate = await getFeatureGate(admin, user.id, "ai_voice_cloning");
      if (!gate.allowed) return json({ error: "Voice cloning is turned off in AI Transparency settings." }, 403);
      const name = String(body.voiceOwnerName ?? "").trim();
      if (name.length < 2 || name.length > 120) return json({ error: "Enter the voice owner's full name." }, 400);
      if (!(RELATIONSHIPS as readonly string[]).includes(String(body.relationship))) return json({ error: "Invalid relationship." }, 400);
      if (body.attested !== true) return json({ error: "You must accept the consent statement." }, 400);

      const { data: existing } = await admin.from("voice_clone_consents").select("id").eq("user_id", user.id).eq("status", "approved").maybeSingle();
      if (existing) return json({ error: "Revoke the current cloned voice before creating a new one.", code: "already_approved" }, 409);

      const phrase = generateLivenessPhrase((n) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; });
      const { data: row, error } = await admin.from("voice_clone_consents").insert({
        user_id: user.id, signed_by: user.id, voice_owner_name: name, relationship: body.relationship,
        consent_version: CONSENT_VERSION, consent_sha256: await sha256Hex(CONSENT_TEXT_V1),
        attested: true, liveness_phrase: phrase,
      }).select("id").single();
      if (error || !row) throw error ?? new Error("insert_failed");
      return json({ consentId: row.id, phrase, consentText: CONSENT_TEXT_V1, expiresInMinutes: 30 });
    }

    if (body.action === "revoke") {
      const { data: c } = await admin.from("voice_clone_consents")
        .select("id,status,sample_path,provider_voice_id").eq("id", String(body.consentId ?? "")).eq("user_id", user.id).maybeSingle();
      if (!c) return json({ error: "Consent not found." }, 404);

      if (c.status !== "revoked") {
        // Block use first, delete second: revocation takes effect even if the provider call fails.
        await admin.from("voice_clone_consents").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", c.id);
        await admin.from("business_profile").update({ custom_voice_id: null, custom_voice_status: "none", custom_voice_error: null }).eq("user_id", user.id);
      }
      if (c.sample_path) await admin.storage.from("voice-samples").remove([c.sample_path]);
      if (c.provider_voice_id) {
        const key = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
        const r = key
          ? await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(c.provider_voice_id)}`, {
              method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000),
            }).catch(() => null)
          : null;
        if (!r || (!r.ok && r.status !== 404)) {
          await admin.from("voice_clone_consents").update({ failure_reason: "provider_delete_failed" }).eq("id", c.id);
          return json({ error: "Consent revoked, but the provider copy isn't deleted yet. Retry.", code: "provider_delete_pending" }, 502);
        }
      }
      await admin.from("voice_clone_consents").update({ provider_voice_id: null, sample_path: null, failure_reason: null }).eq("id", c.id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("voice-consent error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
