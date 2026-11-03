// supabase/functions/_shared/voice/tts.ts
//
// Text-to-speech for briefs (ElevenLabs; the same vendor and secret as clone-voice) + cost model.
//
// Secrets: ELEVENLABS_API_KEY (required), SARAH_VOICE_ID (required for the default voice)
// Optional tuning (no redeploy of code needed): TTS_MODEL (default eleven_flash_v2_5, low latency + cheap),
//   TTS_COST_CENTS_PER_1K_CHARS (default 18 — a PLACEHOLDER: set it from your ElevenLabs plan/invoice),
//   VOICE_CALL_CENTS_PER_MIN (default 2.5) and VOICE_LLM_CENTS_PER_ANSWER (default 0.3) — also placeholders.

export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
export const OUTPUT_FORMAT = "mp3_44100_64";           // 64 kbps -> bytes * 8 / 64000 = seconds

export function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Estimated cost in cents for synthesising `chars` characters. An ESTIMATE until calibrated against the invoice. */
export function ttsCostCents(chars: number, centsPer1k = envNumber("TTS_COST_CENTS_PER_1K_CHARS", 18)): number {
  return Math.round((chars / 1000) * centsPer1k * 10000) / 10000;
}
export function audioSecondsFromBytes(bytes: number): number {
  return Math.round(((bytes * 8) / 64000) * 10) / 10;
}
/** Estimated cost of one inbound call (carrier + speech recognition + say) and its LLM answers, in cents. */
export function callCostCents(durationSeconds: number, llmAnswers: number): number {
  const perMin = envNumber("VOICE_CALL_CENTS_PER_MIN", 2.5);
  const perAnswer = envNumber("VOICE_LLM_CENTS_PER_ANSWER", 0.3);
  return Math.round(((durationSeconds / 60) * perMin + llmAnswers * perAnswer) * 10000) / 10000;
}

export type TtsResult =
  | { ok: true; audio: Uint8Array; chars: number; seconds: number; costCents: number }
  | { ok: false; error: "not_configured" | "provider_error" | "timeout"; status?: number };

export async function synthesize(text: string, voiceId: string, opts: { timeoutMs?: number } = {}): Promise<TtsResult> {
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key || !voiceId) return { ok: false, error: "not_configured" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: Deno.env.get("TTS_MODEL") || DEFAULT_TTS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: ctl.signal,
      },
    );
    if (!res.ok) {
      console.error(JSON.stringify({ event: "tts_failed", status: res.status }));   // never log the text (it contains business data)
      return { ok: false, error: "provider_error", status: res.status };
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    return { ok: true, audio, chars: text.length, seconds: audioSecondsFromBytes(audio.length), costCents: ttsCostCents(text.length) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "AbortError" ? "timeout" : "provider_error" };
  } finally {
    clearTimeout(timer);
  }
}
