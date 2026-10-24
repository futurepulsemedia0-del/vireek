import { describe, it, expect } from "vitest";
import {
  CLAIM_STALE_MS,
  DEFAULT_TEMPLATES,
  LATE_GRACE_DAYS,
  MAX_ATTEMPTS,
  TEMPLATE_VARIABLES,
  TOUCH_META,
  TOUCH_TYPES,
  addDays,
  buildEmailHtml,
  buildEmailText,
  buildSmsBody,
  buildTemplateVars,
  daysBetween,
  defaultSetupTemplates,
  escapeHtml,
  evaluateDue,
  firstName,
  formatLongDate,
  formatOffer,
  isIsoDate,
  isTouchType,
  normalizeOfferCode,
  occurrenceKey,
  offerCodeFromDigest,
  offerExpiry,
  ordinal,
  planChannelActions,
  renderTemplate,
  safeTimeZone,
  sampleVars,
  smsSegments,
  validateTemplate,
  yearsLabel,
  zonedNow,
  type ExistingLog,
  type OfferSettings,
  type StepLike,
} from "./lifecycleCore";

const NOW = Date.parse("2026-10-21T12:00:00Z");

describe("calendar helpers", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("counts whole days, positive when the target is later", () => {
    expect(daysBetween("2026-10-21", "2026-10-24")).toBe(3);
    expect(daysBetween("2026-10-21", "2026-10-19")).toBe(-2);
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
  });
  it("rejects impossible dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(() => daysBetween("nope", "2026-01-01")).toThrow();
  });
  it("falls back to UTC for unknown time zones", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(safeTimeZone("America/New_York")).toBe("America/New_York");
  });
  it("computes the business-local date and hour (not UTC's)", () => {
    // 2026-10-21 02:30 UTC is still the evening of the 20th in New York (EDT, UTC-4).
    const ny = zonedNow(new Date("2026-10-21T02:30:00Z"), "America/New_York");
    expect(ny).toEqual({ date: "2026-10-20", hour: 22, minute: 30 });
    const tehran = zonedNow(new Date("2026-10-21T02:30:00Z"), "Asia/Tehran");
    expect(tehran.date).toBe("2026-10-21");
  });
  it("never reports hour 24 at midnight", () => {
    expect(zonedNow(new Date("2026-10-21T00:05:00Z"), "UTC").hour).toBe(0);
  });
  it("formats a long date without drifting a day", () => {
    expect(formatLongDate("2026-11-20")).toBe("November 20, 2026");
    expect(formatLongDate("2027-01-01")).toBe("January 1, 2027");
    expect(() => formatLongDate("2026-02-31")).toThrow();
  });
});

describe("evaluateDue", () => {
  const s = { lead_days: 0, send_hour: 9 };
  const at = (date: string, hour: number) => ({ date, hour, minute: 0 });

  it("is not due the day before, on-the-day-before-send-hour", () => {
    expect(evaluateDue("2026-10-21", s, at("2026-10-20", 15))).toEqual({ due: false, reason: "too_early" });
    expect(evaluateDue("2026-10-21", s, at("2026-10-21", 8))).toEqual({ due: false, reason: "before_send_hour" });
  });
  it("is due from the send hour on the day", () => {
    expect(evaluateDue("2026-10-21", s, at("2026-10-21", 9))).toEqual({ due: true, sendDay: "2026-10-21" });
    expect(evaluateDue("2026-10-21", s, at("2026-10-21", 23)).due).toBe(true);
  });
  it("stays due through the grace window at any hour, then expires", () => {
    expect(evaluateDue("2026-10-21", s, at("2026-10-22", 0)).due).toBe(true);
    expect(evaluateDue("2026-10-21", s, at(addDays("2026-10-21", LATE_GRACE_DAYS), 3)).due).toBe(true);
    expect(evaluateDue("2026-10-21", s, at(addDays("2026-10-21", LATE_GRACE_DAYS + 1), 12))).toEqual({ due: false, reason: "too_late" });
  });
  it("honours a lead time", () => {
    const lead = { lead_days: 7, send_hour: 10 };
    expect(evaluateDue("2026-10-28", lead, at("2026-10-20", 12)).due).toBe(false);
    expect(evaluateDue("2026-10-28", lead, at("2026-10-21", 9))).toEqual({ due: false, reason: "before_send_hour" });
    expect(evaluateDue("2026-10-28", lead, at("2026-10-21", 10))).toEqual({ due: true, sendDay: "2026-10-21" });
  });
});

describe("offers", () => {
  const base: OfferSettings = { offer_enabled: true, offer_type: "percent_off", offer_value: 10, offer_title: "any repair", offer_terms: null, offer_valid_days: 30 };
  it("formats each offer type", () => {
    expect(formatOffer(base)).toBe("10% off any repair");
    expect(formatOffer({ ...base, offer_type: "amount_off", offer_value: 25 })).toBe("$25 off any repair");
    expect(formatOffer({ ...base, offer_type: "amount_off", offer_value: 12.5 })).toBe("$12.50 off any repair");
    expect(formatOffer({ ...base, offer_type: "free_service", offer_title: "Free 21-point tune-up" })).toBe("Free 21-point tune-up");
  });
  it("never produces a half-built offer", () => {
    expect(formatOffer({ ...base, offer_enabled: false })).toBe("");
    expect(formatOffer({ ...base, offer_title: "  " })).toBe("");
    expect(formatOffer({ ...base, offer_value: null })).toBe("");
    expect(formatOffer({ ...base, offer_value: 150 })).toBe("");
    expect(formatOffer({ ...base, offer_type: "amount_off", offer_value: 0 })).toBe("");
  });
  it("derives a stable, well-formed code from a digest", () => {
    const code = offerCodeFromDigest("a3f9c2d1e87b6a5c");
    expect(code).toMatch(/^LC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(offerCodeFromDigest("a3f9c2d1e87b6a5c")).toBe(code);
    expect(offerCodeFromDigest("a3f9c2d1e8ffffff")).toBe(code); // only the first 40 bits are used
    expect(offerCodeFromDigest("b3f9c2d1e87b6a5c")).not.toBe(code);
    expect(() => offerCodeFromDigest("xyz")).toThrow();
  });
  it("normalises codes typed by staff", () => {
    const code = offerCodeFromDigest("0123456789abcdef");
    expect(normalizeOfferCode(code.toLowerCase())).toBe(code);
    expect(normalizeOfferCode(code.replace(/-/g, " "))).toBe(code);
    expect(normalizeOfferCode(code.replace(/-/g, ""))).toBe(code);
    expect(normalizeOfferCode("LC-0O0O-1I1L")).toBe("LC-0000-1111");
    expect(normalizeOfferCode("XX-ABCD-EFGH")).toBeNull();
    expect(normalizeOfferCode("LC-ABC")).toBeNull();
    expect(normalizeOfferCode("LC-UUUU-UUUU")).toBeNull();
  });
  it("builds a per-occurrence key and an expiry", () => {
    const k = occurrenceKey("u1", { touch_type: "birthday", customer_id: "c1", equipment_id: null, occurrence_year: 2026 });
    expect(k).toBe("u1|birthday|c1|-|2026");
    expect(offerExpiry(NOW, 30)).toBe("2026-11-20T12:00:00.000Z");
  });
});

describe("template rendering", () => {
  it("fills variables and drops unknown ones", () => {
    expect(renderTemplate("Hi {{name}} from {{ company_name }} {{nope}}!", { name: "Sara", company_name: "Acme" })).toBe("Hi Sara from Acme !");
  });
  it("keeps offer blocks only when an offer exists", () => {
    const t = "Hello.\n\n{{#offer}}Take {{offer}} ({{offer_code}}).\n\n{{/offer}}Bye.";
    expect(renderTemplate(t, { offer: "10% off", offer_code: "LC-AAAA-BBBB" })).toBe("Hello.\n\nTake 10% off (LC-AAAA-BBBB).\n\nBye.");
    expect(renderTemplate(t, {})).toBe("Hello.\n\nBye.");
    expect(renderTemplate(t, { offer: "   " })).toBe("Hello.\n\nBye.");
  });
  it("does not re-expand placeholders that appear inside values", () => {
    expect(renderTemplate("Hi {{name}}", { name: "{{company_name}}", company_name: "Acme" })).toBe("Hi {{company_name}}");
  });
  it("cleans the whitespace left behind by removed blocks", () => {
    expect(renderTemplate("A\n\n\n\n{{#offer}}x{{/offer}}\n\n\nB  \n", {})).toBe("A\n\nB");
  });
  it("renders every default template for every touch with and without an offer", () => {
    for (const t of TOUCH_TYPES) {
      for (const withOffer of [true, false]) {
        const vars = sampleVars(t, "Northwind", withOffer);
        const email = renderTemplate(DEFAULT_TEMPLATES[t].email.body, vars);
        const subject = renderTemplate(DEFAULT_TEMPLATES[t].email.subject, vars);
        const sms = renderTemplate(DEFAULT_TEMPLATES[t].sms.body, vars);
        for (const out of [email, subject, sms]) {
          expect(out).not.toMatch(/\{\{|\}\}/);
          expect(out.length).toBeGreaterThan(5);
        }
        expect(email.includes("LC-7K2M-9QXA")).toBe(withOffer);
        expect(sms.includes("LC-7K2M-9QXA")).toBe(withOffer);
      }
    }
  });
  it("ships default templates that pass their own validation", () => {
    for (const tpl of defaultSetupTemplates()) {
      for (const step of tpl.steps) {
        const r = validateTemplate(step.channel, step.subject, step.body);
        expect(r.errors).toEqual([]);
        expect(r.warnings).toEqual([]);
      }
    }
  });
});

describe("variables & wording", () => {
  it("uses the first name and a friendly fallback", () => {
    expect(firstName("Sara Ahmadi")).toBe("Sara");
    expect(firstName("  ")).toBe("there");
    expect(firstName(null)).toBe("there");
  });
  it("makes correct ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });
  it("pluralises years", () => {
    expect(yearsLabel(1)).toBe("1 year");
    expect(yearsLabel(5)).toBe("5 years");
  });
  it("leaves year variables empty for birthdays and falls back for missing equipment", () => {
    const v = buildTemplateVars({ occ: { customer_name: "Sara", equipment_label: null, years_count: null }, companyName: "  ", offer: null });
    expect(v.years).toBe("");
    expect(v.years_label).toBe("");
    expect(v.equipment).toBe("equipment");
    expect(v.company_name).toBe("our team");
    expect(v.offer).toBe("");
  });
  it("describes every placeholder", () => {
    expect(TEMPLATE_VARIABLES.every((v) => v.description && v.example)).toBe(true);
  });
});

describe("template validation", () => {
  it("flags unknown and unbalanced placeholders", () => {
    const r = validateTemplate("email", "Hi {{nam}}", "{{#offer}}x");
    expect(r.errors).toContain("Unknown placeholder {{nam}}.");
    expect(r.errors).toContain("{{#offer}} and {{/offer}} must come in pairs.");
  });
  it("requires subject for email and body for both", () => {
    expect(validateTemplate("email", "  ", "Body").errors).toContain("Email needs a subject line.");
    expect(validateTemplate("sms", null, " ").errors).toContain("The message body is empty.");
  });
  it("warns about offer placeholders outside a block", () => {
    expect(validateTemplate("email", "S", "Use {{offer_code}}").warnings.length).toBe(1);
    expect(validateTemplate("email", "S", "{{#offer}}Use {{offer_code}}{{/offer}}").warnings.length).toBe(0);
  });
  it("warns on long SMS and rejects absurd ones", () => {
    const long = "x".repeat(400);
    expect(validateTemplate("sms", null, long).warnings.some((w) => w.includes("SMS segments"))).toBe(true);
    expect(validateTemplate("sms", null, "x".repeat(601)).errors.length).toBe(1);
  });
});

describe("message assembly", () => {
  it("escapes HTML in bodies and keeps line breaks", () => {
    const html = buildEmailHtml("Hi <b>Sara</b> & co\nline2\n\nSecond", { companyName: "A&B", preferenceUrl: "https://x.test/preferences/abc" });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;Sara&lt;/b&gt; &amp; co<br>line2");
    expect(html).toContain("A&amp;B");
    expect(html.match(/<p /g)?.length).toBe(3); // two paragraphs + footer
    expect(html).toContain('href="https://x.test/preferences/abc"');
  });
  it("always includes an unsubscribe route in email text", () => {
    expect(buildEmailText("Hello", { companyName: "Acme", preferenceUrl: "https://x.test/p/1" })).toContain("https://x.test/p/1");
  });
  it("appends the opt-out line to SMS exactly once", () => {
    expect(buildSmsBody("Happy birthday!")).toBe("Happy birthday!\nReply STOP to opt out.");
    expect(buildSmsBody("Happy birthday! Reply STOP to end.")).toBe("Happy birthday! Reply STOP to end.");
  });
  it("counts SMS segments for GSM-7 and unicode", () => {
    expect(smsSegments("Hello")).toEqual({ encoding: "gsm7", length: 5, segments: 1 });
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("[]").length).toBe(4); // extended characters cost two septets
    expect(smsSegments("سلام").encoding).toBe("ucs2");
    expect(smsSegments("😀".repeat(36)).segments).toBe(2);
    expect(smsSegments("").segments).toBe(0);
  });
  it("escapes quotes for attributes", () => {
    expect(escapeHtml(`"a" 'b'`)).toBe("&quot;a&quot; &#39;b&#39;");
  });
});

describe("planChannelActions", () => {
  const step = (channel: "email" | "sms", order: number, body = "Hi"): StepLike => ({ id: `s${order}`, step_order: order, channel, subject: channel === "email" ? "S" : null, body });
  const steps = [step("email", 1), step("sms", 2)];
  const ok = {
    steps,
    consent: { email: true, sms: true },
    contact: { email: "sara@example.com", phone: "+14155550123" },
    prefsAllowed: { email: true, sms: true },
    smsSuppressed: false,
    existing: [] as ExistingLog[],
    nowMs: NOW,
  };
  const row = (over: Partial<ExistingLog>): ExistingLog => ({ channel: "email", status: "failed", attempts: 1, claimed_at: null, skip_reason: null, ...over });

  it("sends on every consented, reachable channel", () => {
    expect(planChannelActions(ok).map((p) => [p.channel, p.action])).toEqual([["email", "send"], ["sms", "send"]]);
  });
  it("uses only the lowest step per channel", () => {
    const plans = planChannelActions({ ...ok, steps: [step("email", 3, "later"), step("email", 1, "first"), step("sms", 2)] });
    expect(plans.filter((p) => p.channel === "email")).toHaveLength(1);
    expect(plans.find((p) => p.channel === "email")?.step.body).toBe("first");
  });
  it("never uses a channel without its own consent", () => {
    const plans = planChannelActions({ ...ok, consent: { email: true, sms: false } });
    expect(plans.find((p) => p.channel === "sms")).toMatchObject({ action: "record_skip", reason: "no_channel_consent" });
    expect(plans.find((p) => p.channel === "email")?.action).toBe("send");
  });
  it("skips when contact details are unusable", () => {
    const plans = planChannelActions({ ...ok, contact: { email: "not-an-email", phone: "123" } });
    expect(plans.map((p) => p.reason)).toEqual(["no_contact", "no_contact"]);
  });
  it("honours the preference center and the SMS suppression list", () => {
    expect(planChannelActions({ ...ok, prefsAllowed: { email: false, sms: true } })[0]).toMatchObject({ action: "record_skip", reason: "preferences_opt_out" });
    expect(planChannelActions({ ...ok, smsSuppressed: true })[1]).toMatchObject({ action: "record_skip", reason: "do_not_contact" });
  });
  it("does not rewrite an identical skip, but re-evaluates when the reason changes", () => {
    const sameSkip = row({ status: "skipped", skip_reason: "no_channel_consent" });
    expect(planChannelActions({ ...ok, consent: { email: false, sms: true }, existing: [sameSkip] })[0].action).toBe("noop");
    const otherSkip = row({ status: "skipped", skip_reason: "no_contact" });
    expect(planChannelActions({ ...ok, consent: { email: false, sms: true }, existing: [otherSkip] })[0].action).toBe("record_skip");
  });
  it("sends after a skip once consent is granted (takes over the skipped row)", () => {
    const skipped = row({ status: "skipped", skip_reason: "no_channel_consent" });
    const plan = planChannelActions({ ...ok, existing: [skipped] })[0];
    expect(plan.action).toBe("send");
    expect(plan.reclaim).toBe(skipped);
  });
  it("never resends a delivered message", () => {
    expect(planChannelActions({ ...ok, existing: [row({ status: "sent" })] })[0]).toMatchObject({ action: "noop", reason: "already_sent" });
  });
  it("retries failures until attempts are exhausted", () => {
    expect(planChannelActions({ ...ok, existing: [row({ status: "failed", attempts: MAX_ATTEMPTS - 1 })] })[0].action).toBe("send");
    expect(planChannelActions({ ...ok, existing: [row({ status: "failed", attempts: MAX_ATTEMPTS })] })[0]).toMatchObject({ action: "noop", reason: "attempts_exhausted" });
  });
  it("always retries deferred (quiet-hours) rows", () => {
    expect(planChannelActions({ ...ok, existing: [row({ status: "deferred", attempts: 3 })] })[0].action).toBe("send");
  });
  it("leaves fresh claims alone but takes over stale ones", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const stale = new Date(NOW - CLAIM_STALE_MS - 1000).toISOString();
    expect(planChannelActions({ ...ok, existing: [row({ status: "claimed", claimed_at: fresh })] })[0]).toMatchObject({ action: "noop", reason: "in_progress" });
    expect(planChannelActions({ ...ok, existing: [row({ status: "claimed", claimed_at: stale, attempts: 1 })] })[0].action).toBe("send");
    expect(planChannelActions({ ...ok, existing: [row({ status: "claimed", claimed_at: stale, attempts: MAX_ATTEMPTS })] })[0].reason).toBe("attempts_exhausted");
  });
  it("does not write a ledger row for an empty template", () => {
    const plans = planChannelActions({ ...ok, steps: [step("email", 1, "   ")] });
    expect(plans[0]).toMatchObject({ action: "noop", reason: "empty_template" });
  });
});

describe("metadata", () => {
  it("describes every touch type and keeps trigger events unique", () => {
    expect(TOUCH_TYPES.every((t) => TOUCH_META[t].label && TOUCH_META[t].description)).toBe(true);
    expect(new Set(TOUCH_TYPES.map((t) => TOUCH_META[t].triggerEvent)).size).toBe(TOUCH_TYPES.length);
    expect(isTouchType("birthday")).toBe(true);
    expect(isTouchType("wedding")).toBe(false);
    expect(TOUCH_META.birthday.hasYears).toBe(false);
  });
});
