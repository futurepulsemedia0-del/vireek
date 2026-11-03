// Call-time voice resolution for vapi-webhook's assistant-request. Fails OPEN: any problem => null,
// and the call proceeds with the assistant's own voice. Only a `voice` object is ever produced;
// firstMessage / AI disclosure are never touched.
import { sanitizeTuning } from "./logic.ts";
import { assignArm } from "./ab.ts";
import { parseVoiceMap } from "./catalog.ts";
import { parseArms } from "./experiment.ts";
import { buildVapiVoice } from "./vapi.ts";

// deno-lint-ignore no-explicit-any
type Admin = { from: (table: string) => any };
type Env = (key: string) => string | undefined;

const denoEnv: Env = (k) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);

export interface VoiceOverride {
  voice: ReturnType<typeof buildVapiVoice>;
  experiment?: { id: string; arm: string };
}

const TIMEOUT_MS = 1500;

async function resolve(admin: Admin, userId: string, callId: string | null, env: Env): Promise<VoiceOverride | null> {
  if (env("VOICE_STUDIO_RUNTIME") !== "on") return null;
  const map = parseVoiceMap(env("VOICE_STUDIO_VOICE_MAP"));

  // A consented cloned voice lives on the assistant itself (via voice-studio-sync): never override it.
  const { data: bp } = await admin.from("business_profile").select("custom_voice_status,custom_voice_id").eq("user_id", userId).maybeSingle();
  if (bp?.custom_voice_status === "ready" && bp.custom_voice_id) return null;

  const { data: prof } = await admin.from("voice_studio_profiles").select("voice_key,tuning")
    .eq("user_id", userId).is("location_id", null).eq("scenario", "default").maybeSingle();
  if (!prof) return null;

  let voiceKey: string = prof.voice_key;
  let experiment: VoiceOverride["experiment"];

  if (callId) {
    const { data: exp } = await admin.from("voice_experiments").select("id,arms")
      .eq("user_id", userId).is("location_id", null).eq("status", "running").maybeSingle();
    const arms = exp ? parseArms(exp.arms) : null;
    if (exp && arms) {
      let armKey = assignArm(exp.id, callId, arms);
      const ins = await admin.from("voice_experiment_assignments").insert({ experiment_id: exp.id, user_id: userId, call_id: callId, arm_key: armKey });
      if (ins.error) {
        if (ins.error.code !== "23505") throw new Error("assignment_failed");
        // Webhook retry: reuse the arm already recorded for this call (sticky).
        const { data: prev } = await admin.from("voice_experiment_assignments").select("arm_key")
          .eq("experiment_id", exp.id).eq("call_id", callId).maybeSingle();
        if (prev?.arm_key) armKey = prev.arm_key;
      }
      const arm = arms.find((a) => a.key === armKey);
      if (arm) { voiceKey = arm.voiceKey; experiment = { id: exp.id, arm: armKey }; }
    }
  }

  const providerVoice = (map as Record<string, string | undefined>)[voiceKey];
  if (!providerVoice) return null;
  return { voice: buildVapiVoice(providerVoice, sanitizeTuning(prof.tuning)), experiment };
}

export async function resolveVoiceOverride(
  admin: Admin, userId: string, callId: string | null, env: Env = denoEnv,
): Promise<VoiceOverride | null> {
  try {
    return await Promise.race([
      resolve(admin, userId, callId, env),
      new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.error("voice-studio runtime failed open", e instanceof Error ? e.message : e);
    return null;
  }
}
