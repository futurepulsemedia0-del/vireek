// supabase/functions/delete-cloned-voice/index.ts
//
// Lets a business owner permanently remove their cloned voice:
//   1. stop using it on calls immediately (use_custom_voice = false),
//   2. delete the voice at ElevenLabs,
//   3. delete the uploaded sample(s) from the private `voice-samples` bucket,
//   4. clear the voice + consent fields on business_profile.
//
// Order matters: the DB record is only cleared AFTER ElevenLabs confirms the deletion
// (or says it no longer exists), so a failed remote delete never leaves an orphaned
// voice we can no longer find. A failed attempt can simply be retried.
//
// Deletion is deliberately NOT blocked by the `ai_voice_cloning` feature gate: an owner
// can always remove their data, even with the feature switched off.
//
// Required secret (same as clone-voice):  ELEVENLABS_API_KEY
// Deploy:  supabase functions deploy delete-cloned-voice

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { deleteElevenLabsVoice } from "../_shared/voice/elevenLabs.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;

    // Always scoped to the caller's own row. No client-supplied ids are accepted.
    const { data: bp, error: readError } = await admin
      .from("business_profile")
      .select("custom_voice_id")
      .eq("user_id", caller.id)
      .maybeSingle();
    if (readError) {
      console.error("delete-cloned-voice read failed:", readError.message);
      return json({ error: "Could not read your voice settings." }, 500);
    }
    if (!bp) return json({ deleted: false, reason: "no_profile" });

    const voiceId = (bp.custom_voice_id as string | null) ?? null;

    // 1. Stop using it on calls right now, whatever happens next.
    await admin.from("business_profile").update({ use_custom_voice: false }).eq("user_id", caller.id);

    // 2. Remove it at ElevenLabs (a 404 means it is already gone).
    if (voiceId) {
      const elevenLabsKey = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
      const result = await deleteElevenLabsVoice(elevenLabsKey, voiceId);
      if (result === "failed") {
        await admin
          .from("business_profile")
          .update({ custom_voice_error: "Could not delete the voice at ElevenLabs. Please try again." })
          .eq("user_id", caller.id);
        return json({ error: "Could not delete the voice right now. Please try again." }, 502);
      }
    }

    // 3. Remove the uploaded sample(s). Best effort: the voice is already gone.
    try {
      const { data: files } = await admin.storage.from("voice-samples").list(caller.id, { limit: 100 });
      const paths = (files ?? []).filter((f) => f.name).map((f) => `${caller.id}/${f.name}`);
      if (paths.length > 0) await admin.storage.from("voice-samples").remove(paths);
    } catch (err) {
      console.error("delete-cloned-voice sample cleanup failed:", err instanceof Error ? err.message : err);
    }

    // 4. Clear the record. An in-flight clone sees status != 'processing' and removes itself.
    const { error: clearError } = await admin
      .from("business_profile")
      .update({
        custom_voice_id: null,
        custom_voice_status: "none",
        custom_voice_error: null,
        use_custom_voice: false,
        custom_voice_consent_at: null,
        custom_voice_consent_by: null,
      })
      .eq("user_id", caller.id);
    if (clearError) {
      console.error("delete-cloned-voice clear failed:", clearError.message);
      return json({ error: "The voice was deleted but your settings could not be updated. Please refresh." }, 500);
    }

    return json({ deleted: true });
  } catch (err) {
    console.error("delete-cloned-voice error:", err);
    return json({ error: "Unexpected error while deleting the voice." }, 500);
  }
});
