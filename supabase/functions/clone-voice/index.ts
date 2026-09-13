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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface CloneRequestBody {
  storagePath: string;
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

    await admin
      .from("business_profile")
      .update({ custom_voice_status: "processing", custom_voice_error: null })
      .eq("user_id", caller.id);

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

    await admin
      .from("business_profile")
      .update({
        custom_voice_id: elevenData.voice_id,
        custom_voice_status: "ready",
        custom_voice_error: null,
      })
      .eq("user_id", caller.id);

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
