import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUND_PREFS, MAX_DURATION_S, SOUND_CUES, SOUND_EVENTS, TARGET_RMS,
  eventDuration, eventRms, isSoundAllowedOnRoute, playSoundEvent, sanitizePrefs, scheduleFor,
} from "./soundIdentity";

describe("sound identity", () => {
  it("is off by default and the logo never auto-plays", () => {
    expect(DEFAULT_SOUND_PREFS.enabled).toBe(false);
    expect(DEFAULT_SOUND_PREFS.events.logo).toBe(false);
  });
  it("respects duration limits (logo <= 2s, others <= 1.2s, ring <= 2s)", () => {
    for (const e of SOUND_EVENTS) expect(eventDuration(e)).toBeLessThanOrEqual(MAX_DURATION_S[e]);
  });
  it("normalizes loudness: every event hits the target RMS", () => {
    for (const e of SOUND_EVENTS) expect(Math.abs(eventRms(e) - TARGET_RMS) < 0.001).toBe(true);
  });
  it("keeps peak gain safe (<= 0.35) and has no copyrighted samples (oscillators only)", () => {
    for (const e of SOUND_EVENTS) for (const n of scheduleFor(e)) {
      expect(n.gain).toBeLessThanOrEqual(0.35);
      expect(["sine", "triangle"].includes(n.type)).toBe(true);
    }
  });
  it("has a visual cue and caption for every event", () => {
    for (const e of SOUND_EVENTS) {
      expect(SOUND_CUES[e].label.length).toBeGreaterThan(0);
      expect(SOUND_CUES[e].caption.startsWith("[")).toBe(true);
    }
  });
  it("sanitizes stored prefs", () => {
    expect(sanitizePrefs({ enabled: "yes", volume: 9, events: { error: "x" } }).enabled).toBe(false);
    expect(sanitizePrefs({ volume: 9 }).volume).toBe(1);
    expect(sanitizePrefs({ volume: -2 }).volume).toBe(0);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_SOUND_PREFS);
  });
  it("only allows sound inside the dashboard", () => {
    expect(isSoundAllowedOnRoute("/dashboard/jobs")).toBe(true);
    expect(isSoundAllowedOnRoute("/")).toBe(false);
    expect(isSoundAllowedOnRoute("/pricing")).toBe(false);
    expect(isSoundAllowedOnRoute("/dashboardx")).toBe(false);
  });
  it("always announces visually, even when muted or on a public route", async () => {
    const seen: string[] = [];
    const announce = (c: { event: string }) => { seen.push(c.event); };
    expect(await playSoundEvent("job_booked", { prefs: DEFAULT_SOUND_PREFS, pathname: "/dashboard", announce })).toBe("muted");
    const on = { ...DEFAULT_SOUND_PREFS, enabled: true };
    expect(await playSoundEvent("job_booked", { prefs: on, pathname: "/pricing", announce })).toBe("blocked_route");
    expect(seen).toEqual(["job_booked", "job_booked"]);
  });
});
