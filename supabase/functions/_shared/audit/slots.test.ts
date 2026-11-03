import { describe, expect, it } from "vitest";
import { canDialNow, checkSlot, DEFAULT_HOURS, normalizeHours, planTestSlots, validateSlots } from "./slots.ts";
import { zonedToUtc } from "../messaging/quietHoursCore.ts";

const TZ = "America/Chicago";
// Monday 2026-11-02 08:00 Chicago
const NOW = zonedToUtc(2026, 11, 2, 8, 0, TZ);
const input = { now: NOW, timezone: TZ, hours: DEFAULT_HOURS };
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, TZ).toISOString();

describe("normalizeHours", () => {
  it("accepts sane hours", () => expect(normalizeHours({ days: [1, 2, 3], open: "7:30", close: "18:00" })).toMatchObject({ ok: true, hours: { open: "07:30", close: "18:00" } }));
  it.each([
    [{ days: [], open: "08:00", close: "17:00" }], [{ days: [7], open: "08:00", close: "17:00" }], [{ days: [1], open: "17:00", close: "08:00" }],
    [{ days: [1], open: "08:00", close: "10:00" }], [{ days: [1], open: "x", close: "10:00" }], [null],
  ])("rejects %j", (h) => expect(normalizeHours(h).ok).toBe(false));
});

describe("planTestSlots", () => {
  it("proposes one slot per condition, each valid, >=90 min apart, inside 08:00-21:00", () => {
    const p = planTestSlots(input);
    expect(p.slots.map((s) => s.condition).sort()).toEqual(["after_hours", "business_hours", "lunch"]);
    expect(p.untestable).toEqual([]);
    for (const s of p.slots) expect(checkSlot(input, s)).toBeNull();
    const ts = p.slots.map((s) => s.scheduledFor.getTime());
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(90 * 60_000);
  });
  it("after-hours is right after close (17:30) for a 17:00 close", () => {
    const ah = planTestSlots(input).slots.find((s) => s.condition === "after_hours")!;
    expect(ah.scheduledFor.toISOString()).toBe(at(2, 17, 30));
  });
  it("reports after-hours as NOT testable when open until 21:00 on every day", () => {
    const p = planTestSlots({ ...input, hours: { days: [0, 1, 2, 3, 4, 5, 6], open: "08:00", close: "21:00" } });
    expect(p.untestable.map((u) => u.condition)).toContain("after_hours");
    expect(p.slots.find((s) => s.condition === "after_hours")).toBeUndefined();
  });
  it("uses a closed day mid-morning when evenings are unsafe", () => {
    const p = planTestSlots({ ...input, hours: { days: [1, 2, 3, 4, 5], open: "08:00", close: "20:45" } });
    const ah = p.slots.find((s) => s.condition === "after_hours")!;
    expect([0, 6]).toContain(new Date(ah.scheduledFor.toLocaleString("en-US", { timeZone: TZ })).getDay());
  });
  it("lunch is untestable if hours do not cover it", () => {
    const p = planTestSlots({ ...input, hours: { days: [1, 2, 3, 4, 5], open: "14:00", close: "20:00" } });
    expect(p.untestable).toContainEqual({ condition: "lunch", reason: "hours_dont_cover_lunch" });
  });
});

describe("validateSlots (owner-edited schedule)", () => {
  const ok = [
    { condition: "business_hours", scheduledFor: at(3, 10) },
    { condition: "lunch", scheduledFor: at(3, 12, 15) },
    { condition: "after_hours", scheduledFor: at(3, 18) },
  ];
  it("accepts a valid schedule", () => expect(validateSlots(input, ok).ok).toBe(true));
  const reasons = (s: { condition: string; scheduledFor: string }[]) => { const r = validateSlots(input, s); return r.ok ? [] : r.errors.map((e) => e.reason); };
  it("rejects a call that would start before 08:00 or end after 21:00 local", () => {
    expect(reasons([{ condition: "after_hours", scheduledFor: at(3, 6) }])).toContain("outside_safe_window");
    expect(reasons([{ condition: "after_hours", scheduledFor: at(3, 20, 45) }])).toContain("outside_safe_window");
    expect(reasons([{ condition: "after_hours", scheduledFor: at(3, 22) }])).toContain("outside_safe_window");
  });
  it("rejects after-hours that is actually open hours, and business-hours that is closed", () => {
    expect(reasons([{ condition: "after_hours", scheduledFor: at(3, 10) }])).toContain("not_after_hours");
    expect(reasons([{ condition: "business_hours", scheduledFor: at(3, 18) }])).toContain("not_in_business_hours");
    expect(reasons([{ condition: "business_hours", scheduledFor: at(7, 10) }])).toContain("not_in_business_hours"); // Saturday
  });
  it("rejects lunch outside 11:00-14:00", () => expect(reasons([{ condition: "lunch", scheduledFor: at(3, 9) }])).toContain("not_at_lunch"));
  it("rejects past, too-soon and too-far times", () => {
    expect(reasons([{ condition: "business_hours", scheduledFor: at(2, 8, 2) }])).toContain("too_soon");
    expect(reasons([{ condition: "business_hours", scheduledFor: at(2, 7) }])).toContain("too_soon");
    expect(reasons([{ condition: "business_hours", scheduledFor: "2027-02-01T16:00:00Z" }])).toContain("too_far");
  });
  it("rejects calls closer than 90 minutes", () => {
    expect(reasons([{ condition: "business_hours", scheduledFor: at(3, 10) }, { condition: "lunch", scheduledFor: at(3, 11, 15) }])).toContain("too_close_to_another_call");
  });
  it("rejects duplicates, unknown conditions, more than 3, none, garbage", () => {
    expect(reasons([{ condition: "lunch", scheduledFor: at(3, 12) }, { condition: "lunch", scheduledFor: at(4, 12) }])).toContain("duplicate_condition");
    expect(reasons([{ condition: "weekend", scheduledFor: at(3, 12) }])).toContain("bad_condition");
    expect(reasons([...ok, ...ok])).toContain("duplicate_condition");
    expect(reasons([])).toContain("no_slots");
    expect(reasons([{ condition: "lunch", scheduledFor: "not a date" }])).toContain("bad_time");
  });
  it("rejects an invalid timezone", () => expect(validateSlots({ ...input, timezone: "Mars/Olympus" }, ok).ok).toBe(false));
});

describe("canDialNow: the last gate before any dial", () => {
  const call = { scheduledFor: new Date(at(3, 10)), windowEnd: new Date(at(3, 10, 30)) };
  const phone = "+15122345678"; // Central
  it("allows inside the window", () => expect(canDialNow(new Date(at(3, 10, 5)), call, TZ, phone)).toEqual({ ok: true }));
  it("blocks before, and after, the window (never dials late)", () => {
    expect(canDialNow(new Date(at(3, 9, 59)), call, TZ, phone)).toEqual({ ok: false, reason: "before_window" });
    expect(canDialNow(new Date(at(3, 10, 30)), call, TZ, phone)).toEqual({ ok: false, reason: "window_passed" });
  });
  it("blocks when the number's own timezone is outside 08:00-21:00 even if the owner's timezone is fine", () => {
    // Owner picked Pacific by mistake: 20:30 Pacific = 22:30 Central (the number is Central).
    const late = { scheduledFor: zonedToUtc(2026, 11, 3, 20, 25, "America/Los_Angeles"), windowEnd: zonedToUtc(2026, 11, 3, 20, 55, "America/Los_Angeles") };
    expect(canDialNow(zonedToUtc(2026, 11, 3, 20, 30, "America/Los_Angeles"), late, "America/Los_Angeles", phone)).toEqual({ ok: false, reason: "outside_calling_hours" });
  });
  it("blocks on an invalid timezone", () => expect(canDialNow(new Date(), call, "Nope/Nope", phone)).toEqual({ ok: false, reason: "bad_timezone" }));
});
