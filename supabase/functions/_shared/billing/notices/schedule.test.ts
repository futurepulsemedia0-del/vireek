import { describe, expect, it } from "vitest";
import { calendarDaysBetween, daysUntilLocal, inSendWindow, localYmd, priceNoticeDecision, renewalNoticeDue, safeTimeZone, trialNoticeDue } from "./schedule";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

describe("time zones", () => {
  it("computes the local calendar day, not the UTC day", () => {
    const d = new Date("2026-03-10T02:30:00Z");
    expect(localYmd(d, NY)).toBe("2026-03-09");
    expect(localYmd(d, TOKYO)).toBe("2026-03-10");
  });
  it("falls back to the default zone for invalid input", () => {
    expect(safeTimeZone("Mars/Base")).toBe("America/New_York");
    expect(safeTimeZone(null)).toBe("America/New_York");
  });
  it("counts calendar days across a DST change", () => {
    expect(calendarDaysBetween("2026-03-07", "2026-03-10")).toBe(3);
    expect(daysUntilLocal(new Date("2026-03-10T12:00:00Z"), new Date("2026-03-07T12:00:00Z"), NY)).toBe(3);
  });
  it("send window is local 09:00-20:00", () => {
    expect(inSendWindow(new Date("2026-06-01T13:00:00Z"), NY)).toBe(true); // 09:00 EDT
    expect(inSendWindow(new Date("2026-06-01T12:59:00Z"), NY)).toBe(false); // 08:59 EDT
    expect(inSendWindow(new Date("2026-06-02T00:30:00Z"), NY)).toBe(false); // 20:30 EDT
  });
});

describe("trial notices (day 11 = 3 days left, day 13 = 1 day left of a 14-day trial)", () => {
  const start = new Date("2026-06-01T15:00:00Z");
  const end = new Date(start.getTime() + 14 * 86_400_000);
  const at = (days: number, hourUtc = 15) => new Date(Date.UTC(2026, 5, 1 + days, hourUtc));
  it("day 11 -> ends_in_3_days, day 13 -> ends_tomorrow", () => {
    expect(trialNoticeDue(end, at(11), NY)).toBe("ends_in_3_days");
    expect(trialNoticeDue(end, at(13), NY)).toBe("ends_tomorrow");
  });
  it("no notice on other days", () => {
    for (const d of [0, 1, 5, 10, 12, 14]) expect(trialNoticeDue(end, at(d), NY)).toBeNull();
  });
  it("respects the account's time zone (Tokyo sees the next day earlier)", () => {
    const now = new Date("2026-06-13T02:00:00Z"); // Jun 12 22:00 in NY (outside window), Jun 13 11:00 in Tokyo
    expect(trialNoticeDue(end, now, NY)).toBeNull();
    expect(trialNoticeDue(end, now, TOKYO)).toBe("ends_in_3_days"); // Tokyo: Jun 13 -> Jun 16 (trial ends 00:00 JST) = 3 days
  });
  it("is silent outside the daytime window", () => {
    expect(trialNoticeDue(end, at(11, 3), NY)).toBeNull();
  });
});

describe("annual renewal notice", () => {
  const now = new Date("2026-06-01T15:00:00Z");
  const base = { interval: "year", cancelAtPeriodEnd: false, now, tz: NY };
  it("fires within 30 days, not before", () => {
    expect(renewalNoticeDue({ ...base, periodEnd: new Date("2026-07-01T15:00:00Z") })).toBe(true); // 30 days
    expect(renewalNoticeDue({ ...base, periodEnd: new Date("2026-07-02T15:00:00Z") })).toBe(false); // 31 days
  });
  it("never for monthly plans or canceling subscriptions (no notice after cancellation)", () => {
    const periodEnd = new Date("2026-06-20T15:00:00Z");
    expect(renewalNoticeDue({ ...base, periodEnd, interval: "month" })).toBe(false);
    expect(renewalNoticeDue({ ...base, periodEnd, cancelAtPeriodEnd: true })).toBe(false);
  });
  it("not on the renewal day itself", () => {
    expect(renewalNoticeDue({ ...base, periodEnd: new Date("2026-06-01T20:00:00Z") })).toBe(false);
  });
});

describe("price change notice window", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  it("sends only while >= 30 days remain", () => {
    expect(priceNoticeDecision("2026-07-01", now, false)).toBe("send");
    expect(priceNoticeDecision("2026-06-30", now, false)).toBe("blocked_late");
  });
  it("a started dispatch completes instead of becoming late", () => {
    expect(priceNoticeDecision("2026-06-20", now, true)).toBe("completed");
  });
});
