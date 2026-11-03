import { describe, expect, it } from "vitest";
import { signClaims, verifyClaims } from "./bridgeToken.ts";
import { geminiTranslate } from "./gemini.ts";

const SECRET = "x".repeat(40);
const claims = { sid: "s1", uid: "u1", role: "worker" as const, exp: 2_000_000_000 };

describe("bridge token", () => {
  it("round-trips", async () => {
    const t = await signClaims(claims, SECRET);
    expect(await verifyClaims(t, SECRET, 1_900_000_000)).toEqual(claims);
  });
  it("rejects tampering, wrong secret, expiry and junk without throwing", async () => {
    const t = await signClaims(claims, SECRET);
    const [b, s] = t.split(".");
    const forged = `${btoa(JSON.stringify({ ...claims, uid: "u2" })).replace(/=+$/, "")}.${s}`;
    expect(await verifyClaims(forged, SECRET, 1)).toBeNull();
    expect(await verifyClaims(t, "y".repeat(40), 1)).toBeNull();
    expect(await verifyClaims(t, SECRET, 2_100_000_000)).toBeNull();
    for (const j of [null, "", "abc", "a.b", `${b}.`]) expect(await verifyClaims(j as string, SECRET, 1)).toBeNull();
  });
  it("refuses a short secret", async () => {
    let threw = false;
    try { await signClaims(claims, "short"); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe("gemini adapter", () => {
  const ok = (text: string) => (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })) as unknown as typeof fetch;
  it("returns the parsed translation and sends the key only as a header", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"t":"hello","c":0.9}' }] } }] })); }) as unknown as typeof fetch;
    const r = await geminiTranslate({ apiKey: "K", fetchImpl: f })({ text: "hola", from: "es", to: "en", speaker: "caller" });
    expect(r).toEqual({ text: "hello", confidence: 0.9 });
    expect(seen!.url).not.toContain("K");
    expect(seen!.headers["x-goog-api-key"]).toBe("K");
    expect(seen!.body).toContain("<utterance");
  });
  it("is null on non-JSON output, HTTP errors, thrown errors and a missing key", async () => {
    expect(await geminiTranslate({ apiKey: "K", fetchImpl: ok("Sure, hello") })({ text: "hola", from: "es", to: "en", speaker: "caller" })).toBeNull();
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await geminiTranslate({ apiKey: "K", fetchImpl: bad })({ text: "hola", from: "es", to: "en", speaker: "caller" })).toBeNull();
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await geminiTranslate({ apiKey: "K", fetchImpl: boom })({ text: "hola", from: "es", to: "en", speaker: "caller" })).toBeNull();
    expect(await geminiTranslate({ apiKey: "" })({ text: "hola", from: "es", to: "en", speaker: "caller" })).toBeNull();
  });
});
