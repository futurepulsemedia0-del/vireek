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
export type VerifyVoiceGoneResult = "gone" | "still_exists" | "unknown";

/**
 * GET https://api.elevenlabs.io/v1/voices/{voice_id} after a delete.
 * - 404            -> "gone"          (the provider no longer has the voice)
 * - 200            -> "still_exists"  (deletion did not take effect (yet): callers must keep their record and retry)
 * - anything else  -> "unknown"       (network error, 5xx, auth problem: not proof of deletion, callers retry)
 * [VERIFY] that ElevenLabs answers 404 for a deleted voice, with a throwaway voice, before relying on this in production.
 * Never throws.
 */
export async function verifyElevenLabsVoiceGone(
  apiKey: string,
  voiceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyVoiceGoneResult> {
  if (!apiKey || !VOICE_ID_RE.test(voiceId)) return "unknown";
  try {
    const res = await fetchImpl(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return "gone";
    if (res.ok) return "still_exists";
    return "unknown";
  } catch (err) {
    console.error("elevenlabs_verify_voice_error", err instanceof Error ? err.message : err);
    return "unknown";
  }
}

export interface DeleteAndVerifyResult {
  delete: DeleteVoiceResult;
  verified: VerifyVoiceGoneResult;
}

/**
 * Deletes the voice, then confirms it is gone. A deletion may take a moment to show, so a "still_exists"/"unknown"
 * answer is re-checked up to `checks` times, `waitMs` apart, before giving up (the caller then keeps its record and retries later).
 * If the delete itself failed, no verification is attempted.
 */
export async function deleteAndVerifyElevenLabsVoice(
  apiKey: string,
  voiceId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { checks?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeleteAndVerifyResult> {
  const checks = Math.max(1, opts.checks ?? 3);
  const waitMs = opts.waitMs ?? 600;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const del = await deleteElevenLabsVoice(apiKey, voiceId, fetchImpl);
  if (del === "failed") return { delete: del, verified: "unknown" };
  let verified: VerifyVoiceGoneResult = "unknown";
  for (let i = 0; i < checks; i++) {
    verified = await verifyElevenLabsVoiceGone(apiKey, voiceId, fetchImpl);
    if (verified === "gone") break;
    if (i < checks - 1) await sleep(waitMs);
  }
  return { delete: del, verified };
}
