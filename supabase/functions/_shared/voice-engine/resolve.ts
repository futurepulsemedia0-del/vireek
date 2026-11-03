// supabase/functions/_shared/voice-engine/resolve.ts
//
// Picks the voice engine for ONE tenant. Fail-safe by construction:
//   * default is Vapi;
//   * OpenAI Realtime is chosen only if ALL of these hold:
//       1. env VOICE_OPENAI_REALTIME_ENABLED === "true"   (global kill switch)
//       2. the tenant's voice_engine_flags.engine === "openai_realtime"
//       3. the OpenAI engine reports isReady() === true   (a stub never does)
//   * any error while reading the flag -> Vapi. This function never throws.
//   * with the kill switch off, the flag store is NOT queried at all, so default
//     deployments make zero extra database calls.

import type { VoiceEngine, VoiceEngineId } from "./types.ts";
import { isVoiceEngineId } from "./types.ts";

export const OPENAI_REALTIME_KILL_SWITCH_ENV = "VOICE_OPENAI_REALTIME_ENABLED";

export interface ResolveDeps {
  ownerId: string;
  /** e.g. (k) => Deno.env.get(k) */
  getEnv: (key: string) => string | undefined;
  /** Returns the stored engine id for the tenant, or null when there is no row. */
  loadFlag: (ownerId: string) => Promise<string | null>;
  engines: { vapi: VoiceEngine; openai_realtime: VoiceEngine };
}

export type ResolveReason =
  | "default"
  | "kill_switch_off"
  | "flag_not_openai"
  | "flag_lookup_failed"
  | "engine_not_ready"
  | "flag_enabled";

export interface ResolveResult {
  engine: VoiceEngine;
  selected: VoiceEngineId;
  reason: ResolveReason;
}

export async function resolveVoiceEngine(deps: ResolveDeps): Promise<ResolveResult> {
  const vapi = deps.engines.vapi;
  const result = (engine: VoiceEngine, reason: ResolveReason): ResolveResult => ({
    engine,
    selected: engine.id,
    reason,
  });

  let killSwitch: string | undefined;
  try {
    killSwitch = deps.getEnv(OPENAI_REALTIME_KILL_SWITCH_ENV);
  } catch {
    return result(vapi, "default");
  }
  if (killSwitch !== "true") return result(vapi, "kill_switch_off");

  let stored: string | null;
  try {
    stored = await deps.loadFlag(deps.ownerId);
  } catch {
    return result(vapi, "flag_lookup_failed");
  }

  if (!isVoiceEngineId(stored) || stored !== "openai_realtime") return result(vapi, "flag_not_openai");

  const openai = deps.engines.openai_realtime;
  if (!openai.isReady()) return result(vapi, "engine_not_ready");
  return result(openai, "flag_enabled");
}
