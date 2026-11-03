import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import { GOOD_BUSINESS, LEAKY_BUSINESS } from "./mock.ts";
import { applyProviderEvent, finalizeReady, OTP_MAX_ATTEMPTS, reconcileCalls, runDueCalls, sendDueEmails } from "./service.ts";
import { E164, makeWorld, META, PHONE, TZ } from "./testWorld.ts";

const scheduledWorld = async (o: Parameters<ReturnType<typeof makeWorld>["scheduled"]>[0] = {}) => { const w = makeWorld(); const s = await w.scheduled(o); return { w, s }; };

describe("happy path: verify -> consent -> 3 AI-identified test calls -> scored report -> email", () => {
  it("runs end to end, with proofs, caps and a private report", async () => {
    const { w, s } = await scheduledWorld({ followup: true });
    expect(w.otp.sent).toEqual([{ to: E164, channel: "sms" }]);
    expect(w.store.calls.size).toBe(3);
    await w.runAllCalls(GOOD_BUSINESS);

    expect(w.calls.placed).toHaveLength(3);
    for (const p of w.calls.placed) expect(p.toE164).toBe(E164); // only ever the verified number
    const audit = [...w.store.audits.values()][0];
    expect(audit.status).toBe("complete");
    expect(audit.score?.total).toBe(100);

    const r = await w.act("report", { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ view: "owner", provisional: false, business_name: "Acme HVAC" });
    expect((r.body.score as { total: number }).total).toBe(100);
    expect((r.body.timeline as unknown[]).length).toBeGreaterThan(5);
    expect(JSON.stringify(r.body)).not.toContain("512-234"); // no raw phone in the report
    expect(JSON.stringify(r.body)).not.toContain("owner@acme");

    // consent ledger: who/when/IP/text version for each scope
    const scopes = w.store.consents.map((c) => c.scope).sort();
    expect(scopes).toEqual(["ai_test_calls", "email_followup", "otp_message"]);
    for (const c of w.store.consents) {
      expect(c).toMatchObject({ ip_address: META.ip, user_agent: META.userAgent, granted: true });
      expect(c.text_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.text_version).toBe("audit-consent-2026-11-v1");
      expect(c.captured_at).toMatch(/^2026-11-0/);
    }
    expect(w.store.consents.find((c) => c.scope === "ai_test_calls")!.basis).toMatch(/own number.*proved they control/s);

    // transactional report email sent; follow-ups queued for +3d and +10d only because the owner opted in
    expect(w.mailer.outbox).toHaveLength(1);
    expect(w.mailer.outbox[0].text).toContain(`https://vireek.com/audit/${s.token}`);
    expect(w.mailer.outbox[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const q = [...w.store.emails.values()].map((e) => `${e.step}:${e.status}`).sort();
    expect(q).toEqual(["0:sent", "1:queued", "2:queued"]);
  });

  it("the report token is never stored, only its hash", async () => {
    const { w, s } = await scheduledWorld();
    const a = [...w.store.audits.values()][0];
    expect(JSON.stringify(a)).not.toContain(s.token);
    expect(a.token_hash).toBe(await sha256Hex(s.token));
  });

  it("a leaky business gets a low score, critical findings and a fix path", async () => {
    const { w, s } = await scheduledWorld();
    await w.runAllCalls(LEAKY_BUSINESS);
    const r = await w.act("report", { token: s.token });
    const score = r.body.score as { total: number; findings: { id: string }[]; fix_path: { id: string }[] };
    expect(score.total).toBeLessThan(50);
    expect(score.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["no_voicemail", "weak_voicemail"]));
    expect((r.body.revenue as { monthly: { point: number } }).monthly.point).toBeGreaterThan(0);
    expect(score.fix_path.length).toBeGreaterThan(0);
  });

  it("follow-up emails are NOT queued without the separate opt-in", async () => {
    const { w } = await scheduledWorld({ followup: false });
    await w.runAllCalls();
    expect([...w.store.emails.values()].map((e) => e.step)).toEqual([0]);
    expect(w.store.consents.some((c) => c.scope === "email_followup")).toBe(false);
  });
});

describe("start: abuse and compliance gates", () => {
  const reject = async (body: Record<string, unknown>, status: number, w = makeWorld()) => {
    const r = await w.act("start", w.startBody(body));
    expect(r.status).toBe(status);
    expect(w.otp.sent).toHaveLength(0); // NOTHING was sent
    expect(w.store.verifications.size).toBe(0);
    return r;
  };
  it.each([["911"], ["+1 911"], ["112"], ["988"], ["(710) 234-5678"]])("never sends a code to emergency number %s", async (phone) => {
    const r = await reject({ phone }, 400);
    expect(r.body.error).toBe("invalid_phone");
  });
  it("rejects premium, fictional, foreign and Caribbean numbers", async () => {
    for (const phone of ["900-234-5678", "512-555-0100", "+44 20 7946 0958", "876-234-5678", "abc"]) await reject({ phone }, 400);
  });
  it("rejects missing consent / attestation", async () => {
    await reject({ consent_otp: false }, 400);
    await reject({ attest_owner: false }, 400);
    await reject({ consent_otp: undefined }, 400);
  });
  it("rejects disposable email, bad trade, bad timezone, bad name", async () => {
    await reject({ email: "x@mailinator.com" }, 400);
    await reject({ trade: "crypto" }, 400);
    await reject({ timezone: "Mars/Base" }, 400);
    await reject({ business_name: "!!" }, 400);
  });
  it("honeypot: pretends success, sends nothing, stores nothing", async () => {
    const w = makeWorld();
    const r = await w.act("start", w.startBody({ hp: "http://spam" }));
    expect(r.status).toBe(200);
    expect(w.otp.sent).toHaveLength(0);
    expect(w.store.verifications.size).toBe(0);
  });
  it("too-fast submissions and failed bot checks are refused before any paid step", async () => {
    await reject({ elapsed_ms: 200 }, 400);
    await reject({ elapsed_ms: undefined }, 400);
    await reject({ bot_token: "forged" }, 400);
    await reject({ bot_token: "" }, 400);
  });
  it("per-IP rate limit: the 7th request in an hour is refused", async () => {
    const w = makeWorld();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await w.act("start", w.startBody({ phone: `512-234-${5000 + i}`, email: `o${i}@acme.com` }))).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
    expect(w.otp.sent).toHaveLength(6);
  });
  it("per-number limit: 3/hour no matter how many IPs (SMS-bombing a victim)", async () => {
    const w = makeWorld();
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push((await w.act("start", w.startBody(), { ...META, ip: `198.51.100.${i}` })).status);
    expect(out).toEqual([200, 200, 200, 429, 429]);
    expect(w.otp.sent.filter((s) => s.to === E164)).toHaveLength(3);
  });
  it("blocklists (phone, email, domain, IP) are enforced and reveal nothing specific", async () => {
    const hash = async (k: "phone" | "email" | "ip", v: string) => (await import("./crypto.ts")).hashIdentifier("pepper", k, v);
    const cases: [string, string][] = [["phone_hash", await hash("phone", E164)], ["email_hash", await hash("email", "owner@acme-hvac.com")], ["email_domain", "acme-hvac.com"], ["ip_hash", await hash("ip", META.ip!)]];
    for (const [kind, value] of cases) {
      const w = makeWorld();
      await w.store.addBlock(kind as never, value, "test");
      const r = await w.act("start", w.startBody());
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/blocklist|phone_hash|email_domain/);
      expect(w.otp.sent).toHaveLength(0);
    }
  });
  it("one audit per number per 30 days (after a verified audit)", async () => {
    const w = makeWorld();
    await w.verified();
    const again = await w.act("start", w.startBody({ email: "other@acme.com" }), { ...META, ip: "198.51.100.77" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_audited");
    w.advanceMs(31 * 86_400_000);
    expect((await w.act("start", w.startBody({ email: "other@acme.com" }), { ...META, ip: "198.51.100.78" })).status).toBe(200);
  });
  it("kill switch (env) and DB switch stop new sends instantly, with a calm message", async () => {
    for (const mk of [() => makeWorld({ killSwitch: true }), () => { const w = makeWorld(); w.store.settings.enabled = false; return w; }]) {
      const w = mk();
      const r = await w.act("start", w.startBody());
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("unavailable");
      expect(w.otp.sent).toHaveLength(0);
      expect((await w.act("config", {})).body.available).toBe(false);
    }
  });
  it("daily budget and daily start cap stop spending", async () => {
    const w = makeWorld();
    w.store.limits.dailyBudgetCents = 5; // less than one SMS code
    expect((await w.act("start", w.startBody())).status).toBe(503);
    const w2 = makeWorld();
    w2.store.limits.dailyStartCap = 1;
    expect((await w2.act("start", w2.startBody())).status).toBe(200);
    expect((await w2.act("start", w2.startBody({ phone: "512-234-9999", email: "z@acme.com" }), { ...META, ip: "198.51.100.9" })).status).toBe(503);
  });
  it("a provider failure leaves no half-created verification and no charge to the owner's cooldown", async () => {
    const w = makeWorld();
    w.otp.fail = true;
    expect((await w.act("start", w.startBody())).status).toBe(502);
    expect(w.store.verifications.size).toBe(0);
    expect(await w.store.cooldownActive("x")).toBe(false);
  });
  it("toll-free and landline-looking lines are sent the code by VOICE", async () => {
    const w = makeWorld({ lookupEnabled: true });
    w.lookup.types.set(E164, "landline");
    expect((await w.act("start", w.startBody({ channel: "sms" }))).body.channel).toBe("voice");
    const w2 = makeWorld();
    expect((await w2.act("start", w2.startBody({ phone: "888-234-5678", channel: "sms" }))).body.channel).toBe("voice");
  });
  it("lookup says premium => refused even if the digits looked fine", async () => {
    const w = makeWorld({ lookupEnabled: true });
    w.lookup.types.set(E164, "premium");
    expect((await w.act("start", w.startBody())).status).toBe(400);
    expect(w.otp.sent).toHaveLength(0);
  });
});

describe("verify: ownership proof", () => {
  it("wrong codes are limited to 5 and then lock; the right code afterwards is refused", async () => {
    const w = makeWorld();
    const s = await w.act("start", w.startBody());
    const id = s.body.verification_id;
    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) expect((await w.act("verify", { verification_id: id, code: "000000" })).status).toBe(i === OTP_MAX_ATTEMPTS ? 400 : 400);
    const late = await w.act("verify", { verification_id: id, code: w.otp.lastCode(E164) });
    expect(late.status).toBe(429);
    expect(w.store.audits.size).toBe(0);
  });
  it("expired codes are refused", async () => {
    const w = makeWorld();
    const s = await w.act("start", w.startBody());
    w.advanceMs(11 * 60_000);
    expect((await w.act("verify", { verification_id: s.body.verification_id, code: w.otp.lastCode(E164) })).body.error).toBe("code_expired");
  });
  it("a code cannot be replayed, and a newer request supersedes the older one", async () => {
    const w = makeWorld();
    const first = await w.act("start", w.startBody());
    const second = await w.act("start", w.startBody());
    expect((await w.act("verify", { verification_id: first.body.verification_id, code: "123456" })).status).toBe(400);
    expect((await w.act("verify", { verification_id: second.body.verification_id, code: "123456" })).status).toBe(200);
    expect((await w.act("verify", { verification_id: second.body.verification_id, code: "123456" })).status).toBe(409);
    expect(w.store.audits.size).toBe(1);
  });
  it("garbage ids/codes are rejected without touching the store", async () => {
    const w = makeWorld();
    for (const body of [{}, { verification_id: "x", code: "123456" }, { verification_id: crypto.randomUUID(), code: "abc" }, { verification_id: crypto.randomUUID(), code: "123456" }]) {
      expect((await w.act("verify", body)).status).toBe(400);
    }
  });
  it("a verified number cannot be used to create a second audit in parallel", async () => {
    const w = makeWorld();
    const a = await w.act("start", w.startBody());
    const b = await w.act("start", w.startBody());
    const [x, y] = await Promise.all([a, b].map((s) => w.act("verify", { verification_id: s.body.verification_id, code: "123456" })));
    expect([x.status, y.status].filter((c) => c === 200)).toHaveLength(1);
    expect(w.store.audits.size).toBe(1);
  });
});

describe("schedule: explicit consent to the exact calls", () => {
  it("refuses without the call-consent checkbox and creates no calls", async () => {
    const w = makeWorld();
    const v = await w.verified();
    const r = await w.act("schedule", { token: v.token, business_hours: { days: [1, 2, 3, 4, 5], open: "08:00", close: "17:00" }, slots: v.proposed.map((p) => ({ condition: p.condition, scheduled_for: p.scheduled_for })), consent_calls: false });
    expect(r.status).toBe(400);
    expect(w.store.calls.size).toBe(0);
    expect(w.store.consents.some((c) => c.scope === "ai_test_calls")).toBe(false);
  });
  it("rejects unsafe times: before 08:00, after 21:00, closer than 90 minutes, a 4th slot", async () => {
    const w = makeWorld();
    const v = await w.verified();
    const hours = { days: [1, 2, 3, 4, 5], open: "08:00", close: "17:00" };
    const bad = async (slots: unknown[]) => (await w.act("schedule", { token: v.token, business_hours: hours, slots, consent_calls: true })).status;
    expect(await bad([{ condition: "after_hours", scheduled_for: "2026-11-03T04:00:00Z" }])).toBe(400); // 22:00 Chicago
    expect(await bad([{ condition: "after_hours", scheduled_for: "2026-11-03T11:00:00Z" }])).toBe(400); // 05:00 Chicago
    expect(await bad([{ condition: "business_hours", scheduled_for: v.proposed[0].scheduled_for }, { condition: "lunch", scheduled_for: v.proposed[0].scheduled_for }])).toBe(400);
    expect(await bad([...v.proposed, v.proposed[0]].map((p) => ({ condition: p.condition, scheduled_for: p.scheduled_for })))).toBe(400);
    expect(w.store.calls.size).toBe(0);
  });
  it("cannot be scheduled twice", async () => {
    const { w, s } = await scheduledWorld();
    const again = await w.act("schedule", { token: s.token, business_hours: { days: [1], open: "08:00", close: "17:00" }, slots: [], consent_calls: true });
    expect(again.status).toBe(409);
    expect(w.store.calls.size).toBe(3);
  });
  it("per-audit spend cap refuses to schedule more than it may cost", async () => {
    const w = makeWorld();
    w.store.limits.perAuditCapCents = 50;
    const v = await w.verified();
    const r = await w.act("schedule", { token: v.token, business_hours: { days: [1, 2, 3, 4, 5], open: "08:00", close: "17:00" }, slots: v.proposed.map((p) => ({ condition: p.condition, scheduled_for: p.scheduled_for })), consent_calls: true });
    expect(r.status).toBe(503);
    expect(w.store.calls.size).toBe(0);
  });
  it("tampered, truncated and foreign tokens get the same generic 404", async () => {
    const { w, s } = await scheduledWorld();
    for (const t of [s.token.slice(0, -1) + (s.token.endsWith("A") ? "B" : "A"), "short", "", null, 7, "A".repeat(43)]) {
      for (const action of ["report", "assumptions", "share", "cancel", "delete", "plan", "schedule"]) expect((await w.act(action, { token: t })).status).toBe(404);
    }
    expect(w.store.audits.size).toBe(1);
  });
});

describe("runner: every dial passes every gate", () => {
  it("does nothing before the window, dials inside it, never twice", async () => {
    const { w, s } = await scheduledWorld();
    expect((await runDueCalls(w.deps)).claimed).toBe(0);
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
    expect((await runDueCalls(w.deps)).dialed).toBe(1);
    expect((await runDueCalls(w.deps)).claimed).toBe(0); // second sweep: no double dial
    expect(w.calls.placed).toHaveLength(1);
  });
  it("a window that passed is skipped, never dialed late", async () => {
    const { w, s } = await scheduledWorld();
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 45 * 60_000));
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
    expect([...w.store.calls.values()].find((c) => c.condition === "business_hours")!.skip_reason).toBe("window_missed");
  });
  it("fails closed without consent or for a blocked number", async () => {
    for (const mutate of [(w: ReturnType<typeof makeWorld>) => { w.store.consents = w.store.consents.filter((c) => c.scope !== "ai_test_calls"); }, async (w: ReturnType<typeof makeWorld>) => { await w.store.addBlock("phone_hash", [...w.store.audits.values()][0].phone_hash, "x"); }]) {
      const { w, s } = await scheduledWorld();
      await mutate(w);
      w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
      await runDueCalls(w.deps);
      expect(w.calls.placed).toHaveLength(0);
    }
  });
  it("the kill switch stops calls that are already scheduled", async () => {
    const { w, s } = await scheduledWorld();
    w.store.settings.enabled = false;
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
    w.store.settings.enabled = true;
    w.deps.env.killSwitch = true;
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
  });
  it("a timeout when placing is NEVER retried (the call may have connected)", async () => {
    const { w, s } = await scheduledWorld();
    w.calls.placeResult = "throw";
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
    await runDueCalls(w.deps);
    w.calls.placeResult = null;
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
    expect([...w.store.calls.values()].find((c) => c.slot === 1)).toMatchObject({ status: "failed", skip_reason: "dial_state_unknown", answer_kind: "unknown" });
  });
  it("a wrong timezone cannot push a call outside the number's own 08:00-21:00", async () => {
    const w = makeWorld();
    const v = await w.verified({ timezone: "America/Los_Angeles" }); // number is Central
    const hours = { days: [0, 1, 2, 3, 4, 5, 6], open: "06:00", close: "19:00" };
    // 19:40 Pacific = 21:40 Central: inside Pacific's safe window, outside Central's
    const at = new Date("2026-11-04T03:40:00Z");
    const slots = [{ condition: "after_hours", scheduled_for: at.toISOString() }];
    const r = await w.act("schedule", { token: v.token, business_hours: hours, slots, consent_calls: true });
    expect(r.status).toBe(200);
    w.setTime(new Date(at.getTime() + 60_000));
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
    expect([...w.store.calls.values()][0].skip_reason).toBe("outside_calling_hours");
  });
  it("our provider rejecting a call leaves it unscored and hands the number back if nothing could be tested", async () => {
    const { w } = await scheduledWorld();
    w.calls.placeResult = { ok: false, definitive: true, reason: "vapi_http_500" };
    await w.runAllCalls();
    const a = [...w.store.audits.values()][0];
    expect(a.status).toBe("complete");
    expect(a.score?.total).toBeNull();
    expect(await w.store.cooldownActive(a.phone_hash)).toBe(false);
    expect(w.mailer.outbox[0].text).toMatch(/couldn't complete enough test calls/);
  });
});

describe("provider events", () => {
  it("measures ring seconds from status updates and ignores duplicate end reports", async () => {
    const { w } = await scheduledWorld();
    await w.runAllCalls();
    const c = [...w.store.calls.values()].find((x) => x.slot === 1)!;
    expect(c).toMatchObject({ status: "completed", answer_kind: "live_person", ring_seconds: 8 });
    const before = JSON.stringify(c);
    await applyProviderEvent(w.deps, { type: "end-of-call-report", providerCallId: c.vapi_call_id, auditCallId: c.id, report: { endedReason: "customer-busy" } });
    expect(JSON.stringify([...w.store.calls.values()].find((x) => x.slot === 1))).toBe(before);
  });
  it("events for unknown calls are ignored (the webhook can fall through to normal handling)", async () => {
    const { w } = await scheduledWorld();
    expect((await applyProviderEvent(w.deps, { type: "end-of-call-report", providerCallId: "nope", auditCallId: null })).handled).toBe(false);
    expect((await applyProviderEvent(w.deps, { type: "end-of-call-report", providerCallId: "nope", auditCallId: crypto.randomUUID() })).handled).toBe(false);
  });
  it("a lost end report is recovered by reconciliation", async () => {
    const { w, s } = await scheduledWorld();
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
    await runDueCalls(w.deps);
    w.calls.conditionOf.set("mock-call-1", "business_hours");
    w.advanceMs(5 * 60_000);
    expect(await reconcileCalls(w.deps)).toBe(1);
    expect([...w.store.calls.values()].find((c) => c.slot === 1)!.status).toBe("completed");
  });
  it("'stop calling me' on a test call blocks the number, cancels the rest and silences follow-ups", async () => {
    const { w } = await scheduledWorld({ followup: true });
    await w.runAllCalls((c) => (c === "business_hours" ? { endedReason: "assistant-ended-call", durationSeconds: 9, structured: { answered_by: "human", asked_to_stop: true } } : GOOD_BUSINESS(c)));
    expect(w.calls.placed).toHaveLength(1);
    const a = [...w.store.audits.values()][0];
    expect(await w.store.isBlocked("phone_hash", a.phone_hash)).toBe(true);
    expect([...w.store.calls.values()].filter((c) => c.status === "cancelled")).toHaveLength(2);
    expect([...w.store.emails.values()].filter((e) => e.kind === "followup" && e.status === "queued")).toHaveLength(0);
  });
  it("no transcript, audio or free text from the call is ever persisted", async () => {
    const { w } = await scheduledWorld();
    await w.calls.fetchReport("x");
    const rep = { endedReason: "assistant-ended-call", durationSeconds: 30, transientTranscript: "User: our secret address is 12 Elm St", structured: { answered_by: "human", summary: "12 Elm St", transcript: "12 Elm St" } };
    w.calls.behaviour = () => rep as never;
    await w.runAllCalls(() => rep as never);
    expect(JSON.stringify([...w.store.calls.values()])).not.toContain("Elm");
    expect(JSON.stringify(w.store.events)).not.toContain("Elm");
  });
});

describe("report access, sharing, assumptions, deletion, unsubscribe", () => {
  it("expired reports 404", async () => {
    const { w, s } = await scheduledWorld();
    w.advanceMs(31 * 86_400_000);
    expect((await w.act("report", { token: s.token })).status).toBe(404);
  });
  it("sharing is owner-controlled, revocable, and the shared view is redacted", async () => {
    const { w, s } = await scheduledWorld();
    await w.runAllCalls();
    const sh = await w.act("share", { token: s.token, enable: true });
    const view = await w.act("report", { share_token: sh.body.share_token });
    expect(view.status).toBe(200);
    expect(view.body.view).toBe("shared");
    for (const k of ["revenue", "masked_phone", "masked_email", "can_cancel", "share_enabled"]) expect(view.body).not.toHaveProperty(k);
    // the shared token cannot be used as an owner token
    for (const action of ["delete", "share", "assumptions", "cancel"]) expect((await w.act(action, { token: sh.body.share_token })).status).toBe(404);
    await w.act("share", { token: s.token, enable: false });
    expect((await w.act("report", { share_token: sh.body.share_token })).status).toBe(404);
  });
  it("editing assumptions persists, recalculates, and clamps hostile values", async () => {
    const { w, s } = await scheduledWorld();
    await w.runAllCalls(LEAKY_BUSINESS);
    const base = (await w.act("report", { token: s.token })).body.revenue as { monthly: { point: number } };
    const edited = await w.act("assumptions", { token: s.token, assumptions: { avgJobValue: 700, jobConversionRate: 5, junk: 1 } });
    const after = (await w.act("report", { token: s.token })).body.revenue as { monthly: { point: number }; assumptions: { key: string; value: number; source: string }[]; is_placeholder: boolean };
    expect(after.monthly.point).toBeGreaterThan(base.monthly.point);
    expect(after.assumptions.find((a) => a.key === "jobConversionRate")!.value).toBe(1);
    expect(after.assumptions.find((a) => a.key === "avgJobValue")!.source).toBe("owner");
    expect(edited.status).toBe(200);
  });
  it("one-click delete removes everything, redacts consent receipts, and works while the feature is OFF", async () => {
    const { w, s } = await scheduledWorld({ followup: true });
    await w.runAllCalls();
    w.store.settings.enabled = false;
    w.deps.env.killSwitch = true;
    expect((await w.act("delete", { token: s.token })).body).toEqual({ deleted: true });
    expect(w.store.audits.size).toBe(0);
    expect(w.store.calls.size).toBe(0);
    expect(w.store.emails.size).toBe(0);
    expect(w.store.events).toHaveLength(0);
    for (const c of w.store.consents) expect(c).toMatchObject({ phone_e164: "", email: "", ip_address: null, user_agent: null, redacted: true });
    expect(w.store.consents[0].text_sha256).toMatch(/^[0-9a-f]{64}$/); // proof of wording retained
    expect((await w.act("report", { token: s.token })).status).toBe(404);
    expect((await w.act("delete", { token: s.token })).status).toBe(404);
  });
  it("cancel stops remaining calls", async () => {
    const { w, s } = await scheduledWorld();
    expect((await w.act("cancel", { token: s.token })).body.cancelled).toBe(3);
    w.setTime(new Date(Date.parse(s.proposed[0].scheduled_for) + 60_000));
    await runDueCalls(w.deps);
    expect(w.calls.placed).toHaveLength(0);
  });
  it("unsubscribe: signed link works, forged links don't, follow-ups never send afterwards", async () => {
    const { w } = await scheduledWorld({ followup: true });
    await w.runAllCalls();
    const a = [...w.store.audits.values()][0];
    const { signUnsubscribe } = await import("./crypto.ts");
    expect((await w.act("unsubscribe", { t: "junk" })).status).toBe(400);
    expect((await w.act("unsubscribe", { t: await signUnsubscribe("wrong-secret", a.email_hash, a.id) })).status).toBe(400);
    expect((await w.act("unsubscribe", { t: await signUnsubscribe("link-secret", a.email_hash, a.id) })).body.unsubscribed).toBe(true);
    w.advanceMs(11 * 86_400_000);
    await sendDueEmails(w.deps);
    expect(w.mailer.outbox).toHaveLength(1); // only the original transactional email
  });
  it("follow-ups refuse to send without a postal address (CAN-SPAM) or when globally disabled", async () => {
    const { w } = await scheduledWorld({ followup: true });
    await w.runAllCalls();
    w.deps.env.postalAddress = null;
    w.advanceMs(4 * 86_400_000);
    await sendDueEmails(w.deps);
    expect(w.mailer.outbox).toHaveLength(1);
  });
  it("a follow-up that is sent carries an unsubscribe link and the postal address", async () => {
    const { w } = await scheduledWorld({ followup: true });
    await w.runAllCalls();
    w.advanceMs(4 * 86_400_000);
    await sendDueEmails(w.deps);
    expect(w.mailer.outbox).toHaveLength(2);
    expect(w.mailer.outbox[1].html).toMatch(/Unsubscribe/);
    expect(w.mailer.outbox[1].text).toContain("Austin TX");
    expect(w.mailer.outbox[1].text).toMatch(/audit\/unsubscribe\//);
  });
  it("retention: purge removes expired audits", async () => {
    const { w } = await scheduledWorld();
    w.advanceMs(31 * 86_400_000);
    expect((await w.store.purgeExpired()).audits_deleted).toBe(1);
    expect(w.store.audits.size).toBe(0);
  });
  it("finalizeReady is idempotent", async () => {
    const { w } = await scheduledWorld();
    await w.runAllCalls();
    expect(await finalizeReady(w.deps)).toEqual([]);
    expect(w.mailer.outbox).toHaveLength(1);
  });
});

describe("observability", () => {
  it("logs never contain phone numbers, emails or tokens", async () => {
    const { w, s } = await scheduledWorld({ followup: true });
    await w.runAllCalls();
    const all = JSON.stringify(w.logs) + JSON.stringify(w.store.events);
    for (const secret of [E164, PHONE, "owner@acme-hvac.com", s.token, "pepper"]) expect(all).not.toContain(secret);
  });
});
void TZ;
