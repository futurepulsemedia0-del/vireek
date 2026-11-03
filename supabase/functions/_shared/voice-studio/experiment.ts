// Experiment arm validation (pure). Arms are stored as jsonb: [{key, weight, voiceKey}].
import { validateArms, type Arm } from "./ab.ts";
import { isVoiceKey, type VoiceKey } from "./catalog.ts";

export interface VoiceArm extends Arm { voiceKey: VoiceKey }

/** Returns typed arms only if every arm is valid and voices are distinct; otherwise null (callers fail open). */
export function parseArms(raw: unknown): VoiceArm[] | null {
  if (!Array.isArray(raw)) return null;
  const arms: VoiceArm[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return null;
    const o = a as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.weight !== "number" || !isVoiceKey(o.voiceKey)) return null;
    arms.push({ key: o.key, weight: o.weight, voiceKey: o.voiceKey });
  }
  if (!validateArms(arms) || new Set(arms.map((a) => a.voiceKey)).size !== arms.length) return null;
  return arms;
}

/** Arms for a new experiment from user input; keys are generated (a, b, c). */
export function buildArms(input: { voiceKey: unknown; weight?: unknown }[]): VoiceArm[] | null {
  const keys = ["a", "b", "c"];
  if (!Array.isArray(input) || input.length < 2 || input.length > 3) return null;
  return parseArms(input.map((x, i) => ({ key: keys[i], weight: typeof x.weight === "number" ? x.weight : 1, voiceKey: x.voiceKey })));
}
