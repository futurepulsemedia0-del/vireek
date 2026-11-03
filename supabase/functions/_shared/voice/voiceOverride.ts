// supabase/functions/_shared/voice/voiceOverride.ts
//
// Decides which voice a Vapi call should use for a business and returns it as an
// `assistantOverrides` fragment: spread it into assistantOverrides.
//
//   assistantOverrides: { ...(await loadVoiceOverride(admin, ownerId)), variableValues }
//
// Safety contract:
//   * Never throws and never blocks a call: any error/timeout -> {} (the voice
//     configured on the Vapi assistant is used, i.e. today's behaviour).
//   * The cloned voice is used ONLY when ALL hold: the owner selected it, status is
//     'ready', the id is well-formed, consent is recorded, and the
//     `ai_voice_cloning` feature gate is allowed.
//   * The row is always read with .eq("user_id", ownerId): one tenant can never
//     receive another tenant's voice.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { getFeatureGate } from "../ai-transparency/gate.ts";

/** Vapi's provider string for ElevenLabs (docs.vapi.ai/providers/voice/overview). */
export const VAPI_ELEVENLABS_PROVIDER = "11labs" as const;

export interface VapiVoice {
  provider: typeof VAPI_ELEVENLABS_PROVIDER;
  voiceId: string;
}
export interface VoiceOverride {
  voice?: VapiVoice;
}

export interface VoiceRow {
  assistant_voice?: string | null;
  use_custom_voice?: boolean | null;
  custom_voice_id?: string | null;
  custom_voice_status?: string | null;
  custom_voice_consent_at?: string | null;
  custom_voice_consent_by?: string | null;
}

/**
 * Preset id -> Vapi voice. `null` = keep the voice configured on the Vapi assistant
 * (exactly today's behaviour: voices still live on the assistant in the Vapi dashboard).
 * Fill an entry with a VERIFIED { provider, voiceId } to make that preset take effect.
 */
export const PRESET_VOICE_MAP: Readonly<Record<string, VapiVoice | null>> = {
  "sarah-warm-f-us": null,
  "aria-friendly-f-us": null,
  "maya-calm-f-uk": null,
  "miles-confident-m-us": null,
  "jay-easygoing-m-us": null,
  "oliver-polished-m-uk": null,
};

const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface ResolvedVoice {
  voice: VapiVoice | null;
  source: "custom" | "preset";
  /** Why the clone was not used (only when the owner selected it). */
  fallbackReason?: "clone_disabled" | "clone_not_ready" | "clone_id_invalid" | "consent_missing";
}

export function resolveVoice(row: VoiceRow | null | undefined, cloneAllowed: boolean): ResolvedVoice {
  const preset = PRESET_VOICE_MAP[row?.assistant_voice ?? ""] ?? null;
  if (row?.use_custom_voice !== true) return { voice: preset, source: "preset" };

  const fallback = (fallbackReason: NonNullable<ResolvedVoice["fallbackReason"]>): ResolvedVoice => ({
    voice: preset,
    source: "preset",
    fallbackReason,
  });
  if (!cloneAllowed) return fallback("clone_disabled");
  if (row.custom_voice_status !== "ready") return fallback("clone_not_ready");
  const id = row.custom_voice_id ?? "";
  if (!VOICE_ID_RE.test(id)) return fallback("clone_id_invalid");
  if (!row.custom_voice_consent_at || !row.custom_voice_consent_by) return fallback("consent_missing");
  return { voice: { provider: VAPI_ELEVENLABS_PROVIDER, voiceId: id }, source: "custom" };
}

export interface LoadVoiceOptions {
  /** Hard ceiling so a slow lookup can never delay the call. Default 1500 ms. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the `ai_voice_cloning` AI-transparency gate. */
  cloneAllowed?: (admin: SupabaseClient, ownerId: string) => Promise<boolean>;
}

const defaultCloneAllowed = async (admin: SupabaseClient, ownerId: string): Promise<boolean> =>
  (await getFeatureGate(admin, ownerId, "ai_voice_cloning")).allowed;

async function lookup(admin: SupabaseClient, ownerId: string, opts: LoadVoiceOptions): Promise<VoiceOverride> {
  const { data, error } = await admin
    .from("business_profile")
    .select(
      "assistant_voice, use_custom_voice, custom_voice_id, custom_voice_status, custom_voice_consent_at, custom_voice_consent_by",
    )
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = (data ?? null) as VoiceRow | null;
  // Only pay for the gate lookup when the clone was actually selected.
  const allowed = row?.use_custom_voice === true ? await (opts.cloneAllowed ?? defaultCloneAllowed)(admin, ownerId) : false;
  const resolved = resolveVoice(row, allowed);
  if (resolved.fallbackReason) console.warn("voice_clone_fallback", { owner: ownerId, reason: resolved.fallbackReason });
  return resolved.voice ? { voice: resolved.voice } : {};
}

export async function loadVoiceOverride(
  admin: SupabaseClient,
  ownerId: string,
  opts: LoadVoiceOptions = {},
): Promise<VoiceOverride> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(admin, ownerId, opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("voice override lookup timed out")), opts.timeoutMs ?? 1500);
      }),
    ]);
  } catch (err) {
    console.error("voice_override_failed", err instanceof Error ? err.message : err);
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
