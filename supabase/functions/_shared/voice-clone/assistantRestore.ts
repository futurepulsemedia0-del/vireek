// Before a cloned voice is deleted, make sure the live Vapi assistant is not still using it.
// Deleting a voice an assistant points at would break live calls. If the assistant uses the clone, switch it back to the
// preset voice the owner chose in Voice Studio, then confirm the switch by reading the assistant again.
//
// NOT LIVE-VERIFIED: the Vapi assistant `voice` schema is the same assumption voice-studio-sync already makes.

export type RestoreResult = "not_needed" | "restored" | "no_preset" | "skipped" | "failed";

export interface RestoreInput {
  vapiKey: string;
  assistantId: string | null;
  cloneVoiceId: string;
  /** Returns the PATCH body that sets the preset voice, or null when the owner has no preset configured. */
  buildPatch: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  fetchImpl?: typeof fetch;
}

const VAPI = "https://api.vapi.ai/assistant";

export async function restoreAssistantVoice(i: RestoreInput): Promise<RestoreResult> {
  const f = i.fetchImpl ?? fetch;
  if (!i.assistantId) return "not_needed"; // no live assistant, nothing points at the voice
  if (!i.vapiKey) return "skipped";       // cannot check; Vapi is not configured here
  const url = `${VAPI}/${encodeURIComponent(i.assistantId)}`;
  const headers = { Authorization: `Bearer ${i.vapiKey}` };
  const read = async (): Promise<string | null | "error"> => {
    try {
      const r = await f(url, { headers, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return "error";
      const j = (await r.json()) as { voice?: { voiceId?: unknown } };
      return typeof j.voice?.voiceId === "string" ? j.voice.voiceId : null;
    } catch { return "error"; }
  };

  const before = await read();
  if (before === "error") return "failed";
  if (before !== i.cloneVoiceId) return "not_needed";

  let patch: Record<string, unknown> | null;
  try { patch = await i.buildPatch(); } catch { return "failed"; }
  if (!patch) return "no_preset";

  try {
    const r = await f(url, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return "failed";
  } catch { return "failed"; }

  const after = await read();
  return after !== "error" && after !== i.cloneVoiceId ? "restored" : "failed";
}
