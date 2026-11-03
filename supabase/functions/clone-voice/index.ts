// supabase/functions/clone-voice/index.ts
//
// Takes an already-uploaded voice sample from the private `voice-samples`
// storage bucket and clones it via the ElevenLabs API, then writes the
// resulting voice_id back onto `business_profile`. Called from the
// dashboard's Business Profile page — see
// src/components/settings/VoiceCloningCard.tsx.
//
// Required secrets (set once):
//   supabase secrets set ELEVENLABS_API_KEY=sk_xxxxxxxxxxxx
//
// Deploy:
//   supabase functions deploy clone-voice

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getFeatureGate, recordProvenanceSidecar } from "../_shared/ai-transparency/gate.ts";
import { canStartClone, phraseMatches } from "../_shared/voice-studio/consent.ts";
import { deleteElevenLabsVoice } from "../_shared/voice/elevenLabs.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface CloneRequestBody {
  storagePath: string;
  consentId: string;
}
  storagePath: string;
  /** Must be literally `true`: the owner confirmed they may clone this voice. */
  consent?: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Missing Authorization header." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const elevenLabsKey = Deno.env.get("ELEVENLABS_API_KEY") ?? "";

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const caller = userData.user;

    const body = (await req.json()) as CloneRequestBody;
    const storagePath = (body.storagePath ?? "").trim();
    if (!storagePath) {
      return new Response(JSON.stringify({ error: "Missing storagePath." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only let a caller kick off cloning for their own uploaded sample.
    if (!storagePath.startsWith(`${caller.id}/`)) {
      return new Response(JSON.stringify({ error: "You can only clone your own uploaded sample." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

        // Explicit, per-request consent. Never inferred, never defaulted.
    if (body.consent !== true) {
      return new Response(JSON.stringify({ error: "Consent confirmation is required before cloning a voice." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const consentId = (body.consentId ?? "").trim();
    const { data: consent } = await admin
      .from("voice_clone_consents")
      .select("id,user_id,status,attested,liveness_phrase,created_at")
      .eq("id", consentId)
      .eq("user_id", caller.id)
      .maybeSingle();
    if (!consent || !canStartClone(consent, caller.id, new Date())) {
      return new Response(JSON.stringify({ error: "A valid, unexpired consent is required before cloning." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const gate = await getFeatureGate(admin, caller.id, "ai_voice_cloning");
    if (!gate.allowed) {
      return new Response(JSON.stringify({ error: "Voice cloning is turned off in AI Transparency settings." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Only commit if the row is still 'processing'. If the owner deleted the clone
    // while ElevenLabs was working, remove the new voice instead of resurrecting it.
    const { data: committed } = await admin
      .from("business_profile")
      .update({
        custom_voice_id: elevenData.voice_id,
        custom_voice_status: "ready",
        custom_voice_error: null,
      })
      .eq("user_id", caller.id)
      .eq("custom_voice_status", "processing")
      .select("user_id");

    if (!committed || committed.length === 0) {
      await deleteElevenLabsVoice(elevenLabsKey, elevenData.voice_id);
      return new Response(JSON.stringify({ error: "The voice was removed before cloning finished." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Replacing a sample must not leave the old voice behind at ElevenLabs (best effort).
    if (previousVoiceId && previousVoiceId !== elevenData.voice_id) {
      await deleteElevenLabsVoice(elevenLabsKey, previousVoiceId);
    }
          // Remember the voice being replaced so it can be removed at ElevenLabs once the new one is saved.
    const { data: previous } = await admin
      .from("business_profile")
      .select("custom_voice_id")
      .eq("user_id", caller.id)
      .maybeSingle();
    const previousVoiceId = (previous?.custom_voice_id as string | null) ?? null;
    if (!elevenLabsKey) {
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "Voice cloning isn't configured yet." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "Voice cloning isn't configured yet." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: fileData, error: downloadError } = await admin.storage
      .from("voice-samples")
      .download(storagePath);

    if (downloadError || !fileData) {
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "Could not read the uploaded sample." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "Could not read the uploaded sample." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const sttForm = new FormData();
    sttForm.append("model_id", "scribe_v1");
    sttForm.append("file", fileData, "sample.mp3");
    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": elevenLabsKey },
      body: sttForm,
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    const transcript = sttRes && sttRes.ok ? (((await sttRes.json()) as { text?: string }).text ?? "") : null;
    if (transcript === null || !phraseMatches(transcript, consent.liveness_phrase)) {
      const reason = transcript === null ? "liveness_unverifiable" : "liveness_phrase_mismatch";
      await admin.from("voice_clone_consents").update({ status: "rejected", failure_reason: reason }).eq("id", consent.id);
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "Liveness check failed. Start again and read the phrase aloud." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "Liveness check failed. Start again and read the phrase aloud." }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const form = new FormData();
    form.append("name", `vireek-${caller.id}`);
    form.append("files", fileData, "sample.mp3");

    const elevenRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": elevenLabsKey },
      body: form,
    });

    if (!elevenRes.ok) {
      const detail = await elevenRes.text();
      console.error("ElevenLabs clone failed:", detail);
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "ElevenLabs rejected the sample." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "Voice cloning failed. Try a cleaner audio sample." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const elevenData = (await elevenRes.json()) as { voice_id?: string };
    if (!elevenData.voice_id) {
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "No voice ID returned." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "No voice ID returned." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: approveErr } = await admin
      .from("voice_clone_consents")
      .update({
        status: "approved",
        provider_voice_id: elevenData.voice_id,
        sample_path: storagePath,
        approved_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq("id", consent.id);
    if (approveErr) {
      // Never keep a cloned voice that has no approved consent record.
      await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(elevenData.voice_id)}`, {
        method: "DELETE",
        headers: { "xi-api-key": elevenLabsKey },
      }).catch(() => null);
      await admin
        .from("business_profile")
        .update({ custom_voice_status: "failed", custom_voice_error: "Could not record consent." })
        .eq("user_id", caller.id);
      return new Response(JSON.stringify({ error: "Could not record consent. Try again." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await admin
      .from("business_profile")
      .update({
        custom_voice_id: elevenData.voice_id,
        custom_voice_status: "ready",
        custom_voice_error: null,
      })
      .eq("user_id", caller.id);

    await recordProvenanceSidecar(admin, caller.id, {
      subjectType: "voice_clone",
      subjectRef: elevenData.voice_id,
      featureKey: "ai_voice_cloning",
      provider: "ElevenLabs",
      aiGeneratedAudio: true,
      aiProcessed: true,
    });
    
    return new Response(JSON.stringify({ voiceId: elevenData.voice_id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("clone-voice error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error while cloning the voice." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
