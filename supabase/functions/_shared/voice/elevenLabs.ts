// supabase/functions/_shared/voice/elevenLabs.ts
//
// Server-only ElevenLabs helpers. The API key never leaves the edge runtime.

const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type DeleteVoiceResult = "deleted" | "not_found" | "failed";

/**
 * DELETE https://api.elevenlabs.io/v1/voices/{voice_id}
 * - 200            -> "deleted"
 * - 404            -> "not_found" (already gone; callers treat it as success)
 * - anything else  -> "failed"    (callers must NOT drop their DB record)
 * Never throws.
 */
export async function deleteElevenLabsVoice(
  apiKey: string,
  voiceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeleteVoiceResult> {
  if (!apiKey || !VOICE_ID_RE.test(voiceId)) return "failed";
  try {
    const res = await fetchImpl(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "deleted";
    if (res.status === 404) return "not_found";
    console.error("elevenlabs_delete_voice_failed", res.status);
    return "failed";
  } catch (err) {
    console.error("elevenlabs_delete_voice_error", err instanceof Error ? err.message : err);
    return "failed";
  }
}
