// Single source of truth for server-side voice keys + provider voice-id mapping.
export const VOICE_KEYS = [
  "sarah-warm-f-us", "aria-friendly-f-us", "maya-calm-f-uk",
  "miles-confident-m-us", "jay-easygoing-m-us", "oliver-polished-m-uk",
] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

export const isVoiceKey = (v: unknown): v is VoiceKey => typeof v === "string" && (VOICE_KEYS as readonly string[]).includes(v);

/** Parses the VOICE_STUDIO_VOICE_MAP secret. Never throws; keeps only known keys with non-empty string ids. */
export function parseVoiceMap(raw: string | undefined | null): Partial<Record<VoiceKey, string>> {
  try {
    const o = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const out: Partial<Record<VoiceKey, string>> = {};
    for (const k of VOICE_KEYS) if (typeof o[k] === "string" && (o[k] as string).trim()) out[k] = (o[k] as string).trim();
    return out;
  } catch { return {}; }
}
