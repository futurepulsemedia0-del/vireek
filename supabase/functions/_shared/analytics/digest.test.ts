import { describe, expect, it } from "vitest";
import { MockMailer, ResendMailer, buildDigest, digestIsDue, escapeHtml, lastCompletePeriod, mailerFromEnv } from "./digest.ts";
import type { KpiValues } from "./customerKpis.ts";

const K = (o: Partial<KpiValues> = {}): KpiValues => ({
  jobsCompleted: 10, revenueCents: 690000, firstTimeFixRateBp: 8000, callbackRateBp: 1000, activeTechnicians: 2, revenuePerTechnicianCents: 320000,
  grossProfitCents: 74000, jobProfitabilityBp: 3217, scheduledMinutes: 1080, capacityMinutes: 3840, utilizationBp: 2813, quotesSent: 10, quotesAccepted: 4, quoteConversionBp: 4000, ...o,
});

describe("buildDigest", () => {
  it("formats values, deltas and the link; null becomes n/a", () => {
    const d = buildDigest(K({ quoteConversionBp: null }), K({ firstTimeFixRateBp: 8500 }), { from: "2028-03-06", to: "2028-03-12" }, [], "https://x.test/a", "weekly");
    expect(d.text).toContain("First-time-fix rate: 80.0% (-5.0 pts)");
    expect(d.text).toContain("Quote conversion: n/a");
    expect(d.text).toContain("https://x.test/a");
    expect(d.subject).toContain("2028-03-06");
  });
  it("escapes HTML in everything it renders", () => {
    const d = buildDigest(K(), null, { from: "2028-03-06", to: "2028-03-12" }, [], 'https://x.test/?a="1"&b=<s>', "weekly");
    expect(d.html).not.toContain("<s>");
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
  it("lists alerts and marks bad ones", () => {
    const d = buildDigest(K(), null, { from: "a", to: "b" }, [{ metric: "first_time_fix_rate", value: 6500, baselineMean: 8010, z: -20, direction: "down", bad: true, severity: "critical" }], "l", "weekly");
    expect(d.text).toContain("First-time-fix rate moved down to 65.0% (usual 80.1%) - needs attention");
  });
});

describe("scheduling helpers", () => {
  it("digestIsDue", () => {
    const now = Date.parse("2028-03-13T00:00:00Z");
    expect(digestIsDue(null, "weekly", now)).toBe(true);
    expect(digestIsDue("2028-03-07T00:00:00Z", "weekly", now)).toBe(false); // 6 days
    expect(digestIsDue("2028-03-06T00:00:00Z", "weekly", now)).toBe(true); // 7 days
    expect(digestIsDue("2028-02-20T00:00:00Z", "monthly", now)).toBe(false); // 22 days
    expect(digestIsDue("2028-02-10T00:00:00Z", "monthly", now)).toBe(true);
  });
  it("lastCompletePeriod", () => {
    expect(lastCompletePeriod("2028-03-13", "weekly")).toEqual({ from: "2028-03-06", to: "2028-03-12" }); // Monday
    expect(lastCompletePeriod("2028-03-16", "weekly")).toEqual({ from: "2028-03-06", to: "2028-03-12" }); // Thursday
    expect(lastCompletePeriod("2028-03-12", "weekly")).toEqual({ from: "2028-02-28", to: "2028-03-05" }); // Sunday: current week unfinished
    expect(lastCompletePeriod("2028-03-02", "monthly")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(lastCompletePeriod("2028-01-15", "monthly")).toEqual({ from: "2027-12-01", to: "2027-12-31" });
  });
});

describe("mailer adapter", () => {
  it("defaults to the mock (nothing is sent) unless live mode AND a key are set", () => {
    expect(mailerFromEnv(() => undefined).mode).toBe("mock");
    expect(mailerFromEnv((k) => (k === "RESEND_API_KEY" ? "k" : undefined)).mode).toBe("mock");
    expect(mailerFromEnv((k) => ({ ANALYTICS_DIGEST_MODE: "live" } as Record<string, string>)[k]).mode).toBe("mock");
    expect(mailerFromEnv((k) => ({ ANALYTICS_DIGEST_MODE: "live", RESEND_API_KEY: "k" } as Record<string, string>)[k]).mode).toBe("live");
  });
  it("mock records messages", async () => {
    const m = new MockMailer();
    expect((await m.send({ to: "a@b.co", subject: "s", html: "h", text: "t" })).ok).toBe(true);
    expect(m.sent).toHaveLength(1);
  });
  it("Resend adapter reports provider errors and network failures without throwing", async () => {
    const msg = { to: "a@b.co", subject: "s", html: "h", text: "t" };
    expect(await new ResendMailer("k", "f", (async () => new Response("no", { status: 429 })) as typeof fetch).send(msg)).toEqual({ ok: false, error: "provider status 429" });
    expect((await new ResendMailer("k", "f", (async () => { throw new Error("down"); }) as typeof fetch).send(msg)).ok).toBe(false);
    expect(await new ResendMailer("k", "f", (async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 })) as typeof fetch).send(msg)).toEqual({ ok: true, id: "e1" });
  });
});
