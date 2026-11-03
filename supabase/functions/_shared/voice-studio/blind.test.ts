import { describe, expect, it } from "vitest";
import { makeSessionId, parseSessionId, seededOrder, tally } from "./blind.ts";

describe("blind session", () => {
  it("round-trips voice indices", () => {
    const id = makeSessionId("k3m9x2ab", [4, 0, 2]);
    expect(id).toBe("k3m9x2ab-402");
    expect(parseSessionId(id, 6)).toEqual([4, 0, 2]);
  });
  it("rejects malformed, duplicate, out-of-range and too-short codes", () => {
    expect(parseSessionId("bad", 6)).toBe(null);
    expect(parseSessionId("k3m9x2ab-11", 6)).toBe(null);
    expect(parseSessionId("k3m9x2ab-07", 6)).toBe(null);
    expect(parseSessionId("k3m9x2ab-0", 6)).toBe(null);
    expect(parseSessionId("K3M9X2AB-01", 6)).toBe(null);
  });
  it("orders deterministically and keeps every item exactly once", () => {
    const a = seededOrder(["x", "y", "z"], "seed1");
    expect(a).toEqual(seededOrder(["x", "y", "z"], "seed1"));
    expect([...a].sort()).toEqual(["x", "y", "z"]);
  });
  it("tallies votes", () => {
    expect(tally([{ voice_key: "a" }, { voice_key: "b" }, { voice_key: "a" }])).toEqual({ a: 2, b: 1 });
  });
});
