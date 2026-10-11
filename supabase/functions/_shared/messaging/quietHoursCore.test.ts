import { describe, it, expect } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  decideSend,
  federalHolidayKeys,
  isHoliday,
  jitterMs,
  normalizeSettings,
  resolveCustomerTimezone,
  timezoneFromAddress,
  timezoneFromPhone,
  zonedParts,
  zonedToUtc,
  type QuietHoursSettings,
} from "./quietHoursCore";

const S: QuietHoursSettings = { ...DEFAULT_QUIET_HOURS, timezone: "America/New_York", start: "20:00", end: "08:00" };
const NY = { timezone: "America/New_York", source: "business" as const };
const LA = { timezone: "America/Los_Angeles", source: "phone" as const };

// Helper: UTC instant for a New York wall-clock time.
const ny = (y: number, m: number, d: number, h: number, mi = 0) => zonedToUtc(y, m, d, h, mi, "America/New_York");

describe("zoned time primitives", () => {
  it("round-trips wall clock through UTC", () => {
    const d = zonedToUtc(2026, 3, 10, 9, 30, "America/Chicago");
    const p = zonedParts(d, "America/Chicago");
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 3, 10, 9, 30]);
  });

  it("handles the spring-forward gap without drifting a day", () => {
    // 2026-03-08 02:30 does not exist in New York; result must land on 03-08.
    const d = zonedToUtc(2026, 3, 8, 2, 30, "America/New_York");
    expect(zonedParts(d, "America/New_York").dateKey).toBe("2026-03-08");
  });

  it("uses the correct offset on either side of DST", () => {
    expect(zonedToUtc(2026, 1, 15, 8, 0, "America/New_York").toISOString()).toBe("2026-01-15T13:00:00.000Z");
    expect(zonedToUtc(2026, 7, 15, 8, 0, "America/New_York").toISOString()).toBe("2026-07-15T12:00:00.000Z");
  });
});

describe("timezone detection", () => {
  it("prefers explicit customer timezone", () => {
    const r = resolveCustomerTimezone({ explicit: "America/Denver", address: "1 Main St, Austin, TX 78701", phone: "+12125551212", businessTimezone: "America/New_York" });
    expect(r).toEqual({ timezone: "America/Denver", source: "customer" });
  });

  it("falls back address -> phone -> business", () => {
    expect(resolveCustomerTimezone({ address: "12 Oak Ave, Seattle, WA 98101", phone: "+12125551212", businessTimezone: "America/New_York" })).toEqual({ timezone: "America/Los_Angeles", source: "address" });
    expect(resolveCustomerTimezone({ phone: "(312) 555-0100", businessTimezone: "America/New_York" })).toEqual({ timezone: "America/Chicago", source: "phone" });
    expect(resolveCustomerTimezone({ phone: "5550001111", businessTimezone: "America/Phoenix" })).toEqual({ timezone: "America/Phoenix", source: "business" });
  });

  it("ignores invalid explicit timezones", () => {
    expect(resolveCustomerTimezone({ explicit: "Mars/Olympus", businessTimezone: "America/Chicago" }).source).toBe("business");
  });

  it("parses state and special ZIPs", () => {
    expect(timezoneFromAddress("500 Elm, Phoenix, AZ 85001")).toBe("America/Phoenix");
    expect(timezoneFromAddress("9 Mesa Rd, El Paso, TX 79901")).toBe("America/Denver");
    expect(timezoneFromAddress("no state here")).toBeNull();
    expect(timezoneFromPhone("+1 808 555 0100")).toBe("Pacific/Honolulu");
    expect(timezoneFromPhone("12345")).toBeNull();
  });
});

describe("holidays", () => {
  it("computes federal holidays incl. observed dates", () => {
    const h = federalHolidayKeys(2026);
    expect(h.has("2026-07-03")).toBe(true); // July 4 is Saturday -> observed Friday
    expect(h.has("2026-11-26")).toBe(true); // Thanksgiving
    expect(h.has("2026-05-25")).toBe(true); // Memorial Day
    expect(h.has("2026-12-25")).toBe(true);
  });

  it("honours custom blackout dates and the federal toggle", () => {
    expect(isHoliday("2026-08-14", { ...S, blackoutDates: ["2026-08-14"] })).toBe(true);
    expect(isHoliday("2026-12-25", { ...S, useFederalHolidays: false })).toBe(false);
  });
});

describe("decideSend", () => {
  it("allows daytime sends", () => {
    const d = decideSend({ channel: "sms", purpose: "service", settings: S, tz: NY, now: ny(2026, 3, 10, 12) });
    expect(d.allowed).toBe(true);
  });

  it("defers overnight sends to the quiet-window end", () => {
    const d = decideSend({ channel: "email", purpose: "marketing", settings: S, tz: NY, now: ny(2026, 3, 10, 22) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("QUIET_HOURS");
      expect(d.sendAt).toBe(ny(2026, 3, 11, 8).toISOString());
    }
  });

  it("uses the CUSTOMER's timezone, not the business's", () => {
    // 11:30 in New York = 08:30 in LA: open for LA, and 11:30 NY open too.
    const now = ny(2026, 3, 10, 22, 30); // 22:30 NY = 19:30 LA
    expect(decideSend({ channel: "sms", purpose: "service", settings: S, tz: NY, now }).allowed).toBe(false);
    expect(decideSend({ channel: "sms", purpose: "service", settings: S, tz: LA, now }).allowed).toBe(true);
  });

  it("applies the 08:00–21:00 compliance floor even if the business window is wider", () => {
    const wide = { ...S, start: "23:00", end: "05:00" };
    const d = decideSend({ channel: "sms", purpose: "service", settings: wide, tz: NY, now: ny(2026, 3, 10, 21, 30) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("COMPLIANCE_FLOOR");
    // Email has no floor, so the same instant is fine.
    expect(decideSend({ channel: "email", purpose: "service", settings: wide, tz: NY, now: ny(2026, 3, 10, 21, 30) }).allowed).toBe(true);
  });

  it("keeps the floor when the business disables quiet hours", () => {
    const off = { ...S, enabled: false };
    expect(decideSend({ channel: "call", purpose: "marketing", settings: off, tz: NY, now: ny(2026, 3, 10, 7) }).allowed).toBe(false);
    const ok = decideSend({ channel: "email", purpose: "marketing", settings: off, tz: NY, now: ny(2026, 3, 10, 3) });
    expect(ok.allowed).toBe(true);
    if (ok.allowed) expect(ok.reason).toBe("DISABLED");
  });

  it("only applies to configured channels", () => {
    const smsOnly = { ...S, channels: ["sms" as const] };
    const d = decideSend({ channel: "email", purpose: "marketing", settings: smsOnly, tz: NY, now: ny(2026, 3, 10, 22) });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.reason).toBe("NOT_COVERED");
  });

  it("blocks holidays all day and chains to the next open morning", () => {
    // Thanksgiving + day after are blacked out -> next open is Sat 08:00.
    const d = decideSend({ channel: "email", purpose: "marketing", settings: S, tz: NY, now: ny(2026, 11, 26, 12) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("HOLIDAY");
      expect(d.sendAt).toBe(ny(2026, 11, 28, 8).toISOString());
    }
  });

  it("evaluates holidays on the customer's local date", () => {
    const s = { ...S, blackoutDates: ["2026-08-14"] };
    // 23:30 on Aug 13 in NY is already Aug 14 02:30... in Honolulu it's still Aug 13 17:30.
    const now = ny(2026, 8, 13, 23, 30);
    const hi = { timezone: "Pacific/Honolulu", source: "address" as const };
    expect(decideSend({ channel: "email", purpose: "service", settings: s, tz: hi, now }).allowed).toBe(true);
  });

  it("supports quiet weekdays", () => {
    const sundays = { ...S, quietWeekdays: [0] };
    const d = decideSend({ channel: "email", purpose: "service", settings: sundays, tz: NY, now: ny(2026, 3, 8, 12) }); // Sunday
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("QUIET_WEEKDAY");
      expect(d.sendAt).toBe(ny(2026, 3, 9, 8).toISOString());
    }
  });

  it("lets emergencies bypass, but never marketing", () => {
    const now = ny(2026, 3, 10, 2);
    const e = decideSend({ channel: "sms", purpose: "emergency", settings: S, tz: NY, now });
    expect(e.allowed && e.reason).toBe("EMERGENCY_OVERRIDE");
    const m = decideSend({ channel: "sms", purpose: "marketing", settings: S, tz: NY, now, manualOverride: { reason: "please" } });
    expect(m.allowed).toBe(false);
    const noOverride = { ...S, allowEmergencyOverride: false };
    expect(decideSend({ channel: "sms", purpose: "emergency", settings: noOverride, tz: NY, now }).allowed).toBe(false);
  });

  it("allows an owner-confirmed manual override for service messages only with a reason", () => {
    const now = ny(2026, 3, 10, 2);
    expect(decideSend({ channel: "sms", purpose: "service", settings: S, tz: NY, now, manualOverride: { reason: "  " } }).allowed).toBe(false);
    const d = decideSend({ channel: "sms", purpose: "service", settings: S, tz: NY, now, manualOverride: { reason: "Customer asked us to text tonight" } });
    expect(d.allowed && d.reason).toBe("MANUAL_OVERRIDE");
  });

  it("handles overnight windows after midnight", () => {
    const d = decideSend({ channel: "email", purpose: "service", settings: S, tz: NY, now: ny(2026, 3, 11, 3) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.sendAt).toBe(ny(2026, 3, 11, 8).toISOString());
  });

  it("treats start === end as no business quiet window", () => {
    const none = { ...S, start: "00:00", end: "00:00" };
    expect(decideSend({ channel: "email", purpose: "service", settings: none, tz: NY, now: ny(2026, 3, 10, 3) }).allowed).toBe(true);
  });
});

describe("jitter + settings", () => {
  it("jitter is deterministic and bounded", () => {
    expect(jitterMs("abc")).toBe(jitterMs("abc"));
    expect(jitterMs("abc", 10)).toBeLessThan(10 * 60 * 1000);
  });

  it("normalizeSettings repairs bad input", () => {
    const n = normalizeSettings({ enabled: "yes", start: "99:99", channels: ["sms", "fax"], quietWeekdays: [0, 9, "x"], blackoutDates: ["2026-12-31", "nope"] }, "Mars/Base");
    expect(n.start).toBe(DEFAULT_QUIET_HOURS.start);
    expect(n.channels).toEqual(["sms"]);
    expect(n.quietWeekdays).toEqual([0]);
    expect(n.blackoutDates).toEqual(["2026-12-31"]);
    expect(n.timezone).toBe(DEFAULT_QUIET_HOURS.timezone);
    expect(n.enabled).toBe(DEFAULT_QUIET_HOURS.enabled);
  });
});
