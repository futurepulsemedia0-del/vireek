// supabase/functions/_shared/compliance/providerErasure.ts
//
// Provider-side erasure for full-account deletion (gap E5). Local rows are not enough: the voice
// clone lives at ElevenLabs and call data at Vapi. Dependency-injected fetch => unit-testable.
//
// VERIFY BEFORE RELYING: the Vapi `DELETE /call/{id}` endpoint and ElevenLabs `DELETE /v1/voices/{id}`
// must be confirmed against each vendor's current API docs and your plan. A 404 counts as "already gone".
// Twilio recordings/logs and Resend logs are NOT covered here (see docs/compliance/gap-list.md).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface ProviderErasureResult {
  ok: boolean;
  /** Providers skipped because no credential / nothing to delete. */
  skipped: string[];
  failed: string[];
  erased: { elevenlabsVoices: number; vapiCalls: number };
}

type Fetch = typeof fetch;
const MAX_CALLS = 2000;

async function del(f: Fetch, url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await f(url, { method: "DELETE", headers });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function eraseProviderData(
  admin: SupabaseClient,
  userId: string,
  env: { elevenLabsKey?: string; vapiKey?: string },
  f: Fetch = fetch,
): Promise<ProviderErasureResult> {
  const out: ProviderErasureResult = { ok: true, skipped: [], failed: [], erased: { elevenlabsVoices: 0, vapiCalls: 0 } };

  const { data: prof } = await admin.from("business_profile").select("custom_voice_id").eq("user_id", userId).maybeSingle();
  const voiceId = typeof prof?.custom_voice_id === "string" ? prof.custom_voice_id : "";
  if (voiceId) {
    if (!env.elevenLabsKey) out.skipped.push("elevenlabs:no_key");
    else if (await del(f, `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, { "xi-api-key": env.elevenLabsKey })) out.erased.elevenlabsVoices = 1;
    else out.failed.push("elevenlabs");
  }

  const { data: calls } = await admin.from("calls").select("vapi_call_id").eq("user_id", userId).not("vapi_call_id", "is", null).limit(MAX_CALLS);
  const ids = (calls ?? []).map((c: { vapi_call_id: string | null }) => c.vapi_call_id).filter((x): x is string => !!x);
  if (ids.length) {
    if (!env.vapiKey) out.skipped.push("vapi:no_key");
    else for (const id of ids) {
      if (await del(f, `https://api.vapi.ai/call/${encodeURIComponent(id)}`, { Authorization: `Bearer ${env.vapiKey}` })) out.erased.vapiCalls++;
      else out.failed.push(`vapi:${id}`);
    }
  }
  out.ok = out.failed.length === 0;
  return out;
}
