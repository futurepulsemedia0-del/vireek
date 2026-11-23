import { describe, expect, it } from "vitest";
import { DEFAULT_STL_SETTINGS, decideDial, type DialInput } from "./core.ts";

const NOW = new Date("2026-11-04T15:00:00Z"); // Wed 10:00 New York
const base = (over: Partial<DialInput> = {}): DialInput => ({
  now: NOW,
  settings: { ...DEFAULT_STL_SETTINGS, enabled: true },
  request: { receivedAt: new Date(NOW.getTime() - 5_000), attemptCount: 0 },
  consent: { granted: true, scope: ["ai_voice_call"] },
  dncSuppressed: false,
  voiceOptOut: false,
  attemptsLast24h: 0,
  oldestAttemptLast24h: null,
  gate: { proceed: true, timezone: "America/New_York" },
  ...over,
});

describe("decideDial — Canada gate", () => {
  it("stops and hands a Canadian lead to a human while the Canada pack is not enabled", () => {
    expect(decideDial(base({ canadaBlocked: true }))).toEqual({ action: "stop", status: "suppressed", reason: "canada_pack_not_enabled", needsHuman: true });
  });
  it("beats otherwise valid consent, and leaves non-Canadian behaviour unchanged", () => {
    expect(decideDial(base({ canadaBlocked: false }))).toEqual({ action: "dial" });
    expect(decideDial(base())).toEqual({ action: "dial" });
  });
  it("a disabled feature still reports feature_disabled first", () => {
    expect(decideDial(base({ canadaBlocked: true, settings: { ...DEFAULT_STL_SETTINGS, enabled: false } }))).toMatchObject({ reason: "feature_disabled" });
  });
});
