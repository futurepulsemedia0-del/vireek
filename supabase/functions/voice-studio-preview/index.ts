// Authenticated TTS preview. NOT LIVE-VERIFIED against ElevenLabs: confirm the
// text-to-speech request shape and voice_settings.speed support for MODEL_ID.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { LIMITS, estimateCostCents, prepareSpeechText, sanitizeTuning, toProviderSettings } from "../_shared/voice-studio/logic.ts";

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
const HOURLY_LIMIT = 40;
const MODEL_ID = "eleven_multilingual_v2";

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: allowed, error: permErr } = await authClient.rpc("can_edit_call_scripts");
    if (permErr) throw permErr;
    if (allowed !== true) return json({ error: "You don't have permission to use Voice Studio." }, 403);

    const { data: owner, error: ownerErr } = await authClient.rpc("get_account_owner_id");
    if (ownerErr || typeof owner !== "string") throw ownerErr ?? new Error("owner_not_resolved");

    let body: { voiceKey?: unknown; text?: unknown; tuning?: unknown };
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
    const voiceKey = String(body?.voiceKey ?? "");
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!VOICE_KEYS.has(voiceKey)) return json({ error: "Unknown voice." }, 400);
    if (!text || text.length > LIMITS.maxText) return json({ error: `Text must be 1–${LIMITS.maxText} characters.` }, 400);

    const apiKey = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
    let map: Record<string, string> = {};
    try { map = JSON.parse(Deno.env.get("VOICE_STUDIO_VOICE_MAP") ?? "{}"); } catch { /* treated as unconfigured */ }
    const providerVoice = map[voiceKey];
    if (!apiKey || !providerVoice) return json({ error: "This voice isn't configured yet.", code: "voice_unconfigured" }, 503);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error: countErr } = await admin
      .from("voice_studio_preview_log").select("id", { count: "exact", head: true })
      .eq("user_id", owner).gte("created_at", since);
    if (countErr) throw countErr;
    if ((count ?? 0) >= HOURLY_LIMIT) return json({ error: "Preview limit reached. Try again later.", code: "rate_limited" }, 429);

    const tuning = sanitizeTuning(body?.tuning);
    const spoken = prepareSpeechText(text, tuning);

    const t0 = Date.now();
    let audio: ArrayBuffer | null = null;
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(providerVoice)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: spoken, model_id: MODEL_ID, voice_settings: toProviderSettings(tuning) }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (r.ok) audio = await r.arrayBuffer();
      else console.error("voice-studio provider status", r.status);
    } catch (e) {
      console.error("voice-studio provider error", e instanceof Error ? e.message : e);
    }
    const latency = Date.now() - t0;
    const rate = Number(Deno.env.get("VOICE_STUDIO_CENTS_PER_1K_CHARS") ?? "");
    const cost = Number.isFinite(rate) && rate > 0 ? estimateCostCents(spoken.length, rate) : null;

    await admin.from("voice_studio_preview_log").insert({
      user_id: owner, voice_key: voiceKey, chars: spoken.length,
      latency_ms: latency, ok: audio !== null, est_cost_cents: cost ?? 0,
    });

    if (!audio) return json({ error: "Voice provider unavailable. Try again.", code: "provider_failed" }, 502);
    return json({ audio_base64: b64(audio), mime: "audio/mpeg", latency_ms: latency, est_cost_cents: cost, spoken_text: spoken });
  } catch (e) {
    console.error("voice-studio-preview error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
