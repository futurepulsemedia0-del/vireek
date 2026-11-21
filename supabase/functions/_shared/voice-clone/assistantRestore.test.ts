import { describe, expect, it } from "vitest";
import { restoreAssistantVoice } from "./assistantRestore.ts";

type Step = { status: number; voiceId?: string };
function fakeFetch(gets: Step[], patch: { status: number }) {
  const log: string[] = [];
  let g = 0;
  const f = (async (_u: string, init?: { method?: string }) => {
    if (init?.method === "PATCH") { log.push("PATCH"); return { ok: patch.status < 300, status: patch.status, json: async () => ({}) } as Response; }
    log.push("GET");
    const s = gets[Math.min(g++, gets.length - 1)];
    return { ok: s.status < 300, status: s.status, json: async () => ({ voice: { voiceId: s.voiceId } }) } as Response;
  }) as unknown as typeof fetch;
  return { f, log };
}
const base = { vapiKey: "k", assistantId: "a1", cloneVoiceId: "clone123", buildPatch: () => ({ voice: { provider: "11labs", voiceId: "preset" } }) };

describe("restoreAssistantVoice", () => {
  it("no assistant means nothing points at the voice", async () => {
    expect(await restoreAssistantVoice({ ...base, assistantId: null })).toBe("not_needed");
  });
  it("is skipped when Vapi is not configured", async () => {
    expect(await restoreAssistantVoice({ ...base, vapiKey: "" })).toBe("skipped");
  });
  it("does nothing when the assistant uses another voice", async () => {
    const { f, log } = fakeFetch([{ status: 200, voiceId: "preset" }], { status: 200 });
    expect(await restoreAssistantVoice({ ...base, fetchImpl: f })).toBe("not_needed");
    expect(log).toEqual(["GET"]);
  });
  it("switches to the preset and confirms by reading the assistant again", async () => {
    const { f, log } = fakeFetch([{ status: 200, voiceId: "clone123" }, { status: 200, voiceId: "preset" }], { status: 200 });
    expect(await restoreAssistantVoice({ ...base, fetchImpl: f })).toBe("restored");
    expect(log).toEqual(["GET", "PATCH", "GET"]);
  });
  it("fails when the confirmation read still shows the clone", async () => {
    const { f } = fakeFetch([{ status: 200, voiceId: "clone123" }], { status: 200 });
    expect(await restoreAssistantVoice({ ...base, fetchImpl: f })).toBe("failed");
  });
  it("reports no_preset (and does not PATCH) when the owner has no preset voice", async () => {
    const { f, log } = fakeFetch([{ status: 200, voiceId: "clone123" }], { status: 200 });
    expect(await restoreAssistantVoice({ ...base, buildPatch: () => null, fetchImpl: f })).toBe("no_preset");
    expect(log).not.toContain("PATCH");
  });
  it("fails when the assistant cannot be read or the PATCH is rejected", async () => {
    expect(await restoreAssistantVoice({ ...base, fetchImpl: fakeFetch([{ status: 500 }], { status: 200 }).f })).toBe("failed");
    expect(await restoreAssistantVoice({ ...base, fetchImpl: fakeFetch([{ status: 200, voiceId: "clone123" }], { status: 422 }).f })).toBe("failed");
  });
});
