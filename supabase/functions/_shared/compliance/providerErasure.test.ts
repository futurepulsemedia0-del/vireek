import { describe, expect, it } from "vitest";
import { eraseProviderData } from "./providerErasure";

function fakeAdmin(voice: string | null, callIds: string[]) {
  const q = (rows: unknown, single: boolean) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "limit"]) b[m] = () => b;
    b.maybeSingle = () => Promise.resolve({ data: rows });
    b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: single ? rows : rows }).then(r);
    return b;
  };
  return { from: (t: string) => (t === "business_profile" ? q(voice ? { custom_voice_id: voice } : null, true) : q(callIds.map((id) => ({ vapi_call_id: id })), false)) } as never;
}
const mkFetch = (status: number, log: string[]) => (async (url: string, init: { method: string }) => { log.push(`${init.method} ${url}`); return { ok: status < 300, status }; }) as never;

describe("eraseProviderData", () => {
  it("deletes voice and calls", async () => {
    const log: string[] = [];
    const r = await eraseProviderData(fakeAdmin("v1", ["c1", "c2"]), "u", { elevenLabsKey: "k", vapiKey: "k" }, mkFetch(204, log));
    expect(r.ok).toBe(true);
    expect(r.erased.vapiCalls).toBe(2);
    expect(r.erased.elevenlabsVoices).toBe(1);
  });
  it("treats 404 as already gone", async () => {
    const r = await eraseProviderData(fakeAdmin("v1", []), "u", { elevenLabsKey: "k" }, mkFetch(404, []));
    expect(r.ok).toBe(true);
  });
  it("reports failures so the caller can retry", async () => {
    const r = await eraseProviderData(fakeAdmin(null, ["c1"]), "u", { vapiKey: "k" }, mkFetch(500, []));
    expect(r.ok).toBe(false);
    expect(r.failed[0]).toBe("vapi:c1");
  });
  it("skips (not fails) when no credential", async () => {
    const r = await eraseProviderData(fakeAdmin("v1", ["c1"]), "u", {}, mkFetch(204, []));
    expect(r.skipped.length).toBe(2);
    expect(r.ok).toBe(true);
  });
});
