import { describe, expect, it } from "vitest";
import { deleteAndVerifyElevenLabsVoice, verifyElevenLabsVoiceGone } from "../voice/elevenLabs.ts";

const VID = "voice_abcdef123";
function seq(responses: Array<number | "throw">) {
  const calls: string[] = [];
  let i = 0;
  const f = (async (_u: string, init?: { method?: string }) => {
    calls.push(init?.method ?? "GET");
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "throw") throw new Error("network");
    return { ok: r < 300, status: r, body: null } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noSleep = async () => undefined;

describe("verifyElevenLabsVoiceGone", () => {
  it("404 means gone, 200 means still there, anything else is unknown", async () => {
    expect(await verifyElevenLabsVoiceGone("k", VID, seq([404]).f)).toBe("gone");
    expect(await verifyElevenLabsVoiceGone("k", VID, seq([200]).f)).toBe("still_exists");
    expect(await verifyElevenLabsVoiceGone("k", VID, seq([500]).f)).toBe("unknown");
    expect(await verifyElevenLabsVoiceGone("k", VID, seq([401]).f)).toBe("unknown");
    expect(await verifyElevenLabsVoiceGone("k", VID, seq(["throw"]).f)).toBe("unknown");
  });
  it("refuses a missing key or a malformed id without calling the network", async () => {
    const s = seq([404]);
    expect(await verifyElevenLabsVoiceGone("", VID, s.f)).toBe("unknown");
    expect(await verifyElevenLabsVoiceGone("k", "../etc", s.f)).toBe("unknown");
    expect(s.calls).toHaveLength(0);
  });
});

describe("deleteAndVerifyElevenLabsVoice", () => {
  it("DELETE then GET 404 => deleted + gone", async () => {
    const s = seq([200, 404]);
    expect(await deleteAndVerifyElevenLabsVoice("k", VID, s.f, { sleep: noSleep })).toEqual({ delete: "deleted", verified: "gone" });
    expect(s.calls).toEqual(["DELETE", "GET"]);
  });
  it("re-checks when the voice is briefly still visible", async () => {
    const s = seq([200, 200, 200, 404]);
    expect((await deleteAndVerifyElevenLabsVoice("k", VID, s.f, { sleep: noSleep })).verified).toBe("gone");
    expect(s.calls).toEqual(["DELETE", "GET", "GET", "GET"]);
  });
  it("gives up after the configured checks and reports still_exists", async () => {
    const s = seq([200, 200]);
    expect(await deleteAndVerifyElevenLabsVoice("k", VID, s.f, { checks: 2, sleep: noSleep })).toEqual({ delete: "deleted", verified: "still_exists" });
  });
  it("a delete 404 counts as deleted and is still verified", async () => {
    const s = seq([404, 404]);
    expect(await deleteAndVerifyElevenLabsVoice("k", VID, s.f, { sleep: noSleep })).toEqual({ delete: "not_found", verified: "gone" });
  });
  it("a failed delete is not verified", async () => {
    const s = seq([500]);
    expect(await deleteAndVerifyElevenLabsVoice("k", VID, s.f, { sleep: noSleep })).toEqual({ delete: "failed", verified: "unknown" });
    expect(s.calls).toEqual(["DELETE"]);
  });
});
