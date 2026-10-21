import { describe, expect, it } from "vitest";
import { buildEmail, buildSmsText, describeWindow, type WindowMessageInput } from "./message";

const base: WindowMessageInput = {
  kind: "confirmed",
  businessName: "Acme HVAC",
  technicianName: null,
  serviceType: "AC repair",
  windowStart: "2026-10-20T14:00:00Z", // 10:00 AM New York (EDT)
  windowEnd: "2026-10-20T16:00:00Z",
  timeZone: "America/New_York",
  link: "https://vireek.com/reschedule/abc",
};

describe("describeWindow", () => {
  it("renders in the business time zone, not UTC", () => {
    const w = describeWindow(base.windowStart, base.windowEnd, "America/New_York");
    expect(w.from).toBe("10:00 AM");
    expect(w.to).toBe("12:00 PM");
    expect(w.day).toBe("Tue, Oct 20");
  });
  it("shifts correctly for another zone", () => {
    expect(describeWindow(base.windowStart, base.windowEnd, "Asia/Baku").from).toBe("6:00 PM");
  });
});

describe("buildSmsText", () => {
  it("confirms the booking with the window and an opt-out line", () => {
    const t = buildSmsText(base);
    expect(t).toContain("Acme HVAC: you're booked for your AC repair visit.");
    expect(t).toContain("between 10:00 AM and 12:00 PM on Tue, Oct 20");
    expect(t).toContain("https://vireek.com/reschedule/abc");
    expect(t.endsWith("Reply STOP to opt out.")).toBe(true);
  });
  it("names the technician and shows the previous window when narrowed", () => {
    const t = buildSmsText({
      ...base, kind: "narrowed", technicianName: "Mike",
      windowStart: "2026-10-20T15:00:00Z", windowEnd: "2026-10-20T17:00:00Z",
      previousStart: "2026-10-20T14:00:00Z", previousEnd: "2026-10-20T18:00:00Z",
    });
    expect(t).toContain("we narrowed your arrival window");
    expect(t).toContain("Mike will arrive between 11:00 AM and 1:00 PM");
    expect(t).toContain("(was 10:00 AM – 2:00 PM)");
  });
  it("includes the previous day when a reschedule moved the window to another day", () => {
    const t = buildSmsText({
      ...base, kind: "changed",
      windowStart: "2026-10-21T14:00:00Z", windowEnd: "2026-10-21T16:00:00Z",
      previousStart: "2026-10-20T14:00:00Z", previousEnd: "2026-10-20T16:00:00Z",
    });
    expect(t).toContain("changed");
    expect(t).toContain("(was Tue, Oct 20, 10:00 AM – 12:00 PM)");
  });
  it("falls back to generic wording and drops the link when missing", () => {
    const t = buildSmsText({ ...base, businessName: null, serviceType: null, link: null });
    expect(t.startsWith("Your service provider: you're booked for your visit.")).toBe(true);
    expect(t).not.toContain("Need another time?");
  });
});

describe("buildEmail", () => {
  it("builds subject, text and html without leaking the SMS opt-out line", () => {
    const e = buildEmail(base);
    expect(e.subject).toBe("Your arrival window: Tue, Oct 20, 10:00 AM – 12:00 PM");
    expect(e.text).not.toContain("STOP");
    expect(e.html).toContain("Need another time?");
  });
  it("escapes HTML in business names", () => {
    const e = buildEmail({ ...base, businessName: "<script>x</script>" });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });
});
