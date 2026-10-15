// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  CHAT_EVENT_TYPES,
  EVENT_META,
  buildMessageModel,
  formatMoney,
  isChatEventType,
  truncate,
  type BuildOptions,
  SAMPLE_PAYLOADS,
  type RenderableEvent,
} from "./events.ts";
import { SLACK_ACTION_ACK, SLACK_ACTION_ASSIGN, buildSlackMessage, escapeSlack, eventIdFromBlockId } from "./slackBlocks.ts";
import { TEAMS_FIELD_TECH, buildTeamsMessage } from "./teamsCards.ts";
import { computeSlackSignature, decodeJwtPayload, decryptSecret, encryptSecret, isTrustedServiceUrl, normalizeServiceUrl, timingSafeEqual, verifySlackSignature } from "./security.ts";

const EVENT_ID = "11111111-2222-3333-4444-555555555555";
const techs = [
  { id: "t1", name: "Alex Rivera" },
  { id: "t2", name: "Sam Cole" },
];
const opts: BuildOptions = { siteUrl: "https://vireek.com/", includeContact: true, actionsEnabled: true, technicians: techs };
const ev = (eventType: RenderableEvent["eventType"], payload: Record<string, unknown> = {}, extra: Partial<RenderableEvent> = {}): RenderableEvent => ({
  id: EVENT_ID,
  eventType,
  payload,
  ...extra,
});

describe("event catalogue", () => {
  it("covers exactly the six supported event types", () => {
    expect([...CHAT_EVENT_TYPES]).toEqual(["emergency_call", "missed_call", "new_job", "job_completed", "low_csat", "payment_failed"]);
    for (const t of CHAT_EVENT_TYPES) expect(EVENT_META[t].label.length > 0).toBe(true);
  });
  it("type guard rejects unknown values", () => {
    expect(isChatEventType("new_job")).toBe(true);
    expect(isChatEventType("nope")).toBe(false);
    expect(isChatEventType(7)).toBe(false);
  });
});

describe("buildMessageModel", () => {
  it("emergency call shows caller, summary and both actions", () => {
    const m = buildMessageModel(ev("emergency_call", { caller_name: "Dana", caller_phone: "+15551234567", summary: "No heat, elderly resident" }), opts);
    expect(m.fields.map((f) => f.label)).toEqual(["Caller", "Summary"]);
    expect(m.fields[0].value).toBe("Dana (+15551234567)");
    expect(m.actions).toEqual(["acknowledge", "assign"]);
    expect(m.link.url).toBe("https://vireek.com/dashboard/calls");
  });
  it("masks the phone and drops the address when contact details are off", () => {
    const call = buildMessageModel(ev("missed_call", { caller_name: "Dana", caller_phone: "+15551234567" }), { ...opts, includeContact: false });
    expect(call.fields[0].value).toBe("Dana (•••• 4567)");
    const job = buildMessageModel(ev("new_job", { customer_name: "Lee", address: "12 Elm St", service_type: "AC repair" }), { ...opts, includeContact: false });
    expect(job.fields.map((f) => f.label)).toEqual(["Customer", "Service"]);
  });
  it("acknowledged events no longer offer Acknowledge and show who did it", () => {
    const m = buildMessageModel(ev("emergency_call", {}, { acknowledgedBy: "Sam", assignedToName: "Alex Rivera" }), opts);
    expect(m.actions).toEqual(["assign"]);
    expect(m.status).toBe("Acknowledged by Sam · Assigned to Alex Rivera");
  });
  it("hides Assign without technicians and hides everything when actions are disabled", () => {
    expect(buildMessageModel(ev("new_job", {}), { ...opts, technicians: [] }).actions).toEqual([]);
    expect(buildMessageModel(ev("emergency_call", {}), { ...opts, actionsEnabled: false }).actions).toEqual([]);
  });
  it("job completed is informational only and never leaks invoice amounts", () => {
    const m = buildMessageModel(ev("job_completed", { customer_name: "Lee", invoice_amount: 900 }), opts);
    expect(m.actions).toEqual([]);
    expect(JSON.stringify(m)).not.toContain("900");
  });
  it("low CSAT renders the rating", () => {
    const m = buildMessageModel(ev("low_csat", { rating: 2, comment: "Late" }), opts);
    expect(m.fields[0]).toEqual({ label: "Rating", value: "2 / 5" });
  });
  it("payment failed distinguishes customer vs subscription failures", () => {
    const c = buildMessageModel(ev("payment_failed", { customer_name: "Lee", amount: 125.5, currency: "usd" }), opts);
    expect(c.fields[1]).toEqual({ label: "Amount", value: "$125.50" });
    const s = buildMessageModel(ev("payment_failed", { source: "subscription" }), opts);
    expect(s.fields).toHaveLength(0);
    expect(s.summary).toContain("subscription");
  });
  it("caps technicians at 25", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `Tech ${i}` }));
    expect(buildMessageModel(ev("new_job"), { ...opts, technicians: many }).technicians).toHaveLength(25);
  });
});

describe("helpers", () => {
  it("truncate trims, strips control chars and adds an ellipsis", () => {
    expect(truncate("  hi\u0007  ", 10)).toBe("hi");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
  it("formatMoney tolerates bad input", () => {
    expect(formatMoney("abc", "usd")).toBe("");
    expect(formatMoney(10, "zz!")).toBe("$10.00");
  });
});

describe("Slack Block Kit", () => {
  const model = buildMessageModel(ev("emergency_call", { caller_name: "<Dana> & co", summary: "Gas smell" }), opts);
  const msg = buildSlackMessage(model);
  it("escapes mrkdwn control characters", () => {
    expect(escapeSlack("<a> & b")).toBe("&lt;a&gt; &amp; b");
    expect(JSON.stringify(msg.blocks)).toContain("&lt;Dana&gt; &amp; co");
  });
  it("builds header, summary, fields and an actions block keyed by the event id", () => {
    const actions = msg.blocks[msg.blocks.length - 1] as { type: string; block_id: string; elements: { action_id: string; options?: unknown[] }[] };
    expect(actions.type).toBe("actions");
    expect(eventIdFromBlockId(actions.block_id)).toBe(EVENT_ID);
    expect(actions.elements.map((e) => e.action_id)).toEqual([SLACK_ACTION_ACK, SLACK_ACTION_ASSIGN, "vk_open"]);
    expect(actions.elements[1].options).toHaveLength(2);
  });
  it("has a notification fallback text and a bounded header", () => {
    expect(msg.text).toContain("Emergency call");
    expect(msg.text.length).toBeLessThanOrEqual(300);
  });
  it("rejects malformed block ids", () => {
    expect(eventIdFromBlockId("vk:not-a-uuid")).toBeNull();
    expect(eventIdFromBlockId("other:" + EVENT_ID)).toBeNull();
    expect(eventIdFromBlockId(undefined)).toBeNull();
  });
});

describe("Teams Adaptive Card", () => {
  const card = buildTeamsMessage(buildMessageModel(ev("emergency_call", { caller_name: "Dana" }), opts)).attachments[0].content as {
    version: string;
    body: { type: string; id?: string; choices?: unknown[] }[];
    actions: { type: string; data?: Record<string, string> }[];
  };
  it("targets Adaptive Cards 1.4 with Submit actions carrying the event id", () => {
    expect(card.version).toBe("1.4");
    const submits = card.actions.filter((a) => a.type === "Action.Submit");
    expect(submits.map((a) => a.data?.vk)).toEqual(["ack", "assign"]);
    expect(submits.every((a) => a.data?.e === EVENT_ID)).toBe(true);
  });
  it("includes the technician picker only when Assign is offered", () => {
    const picker = card.body.find((b) => b.type === "Input.ChoiceSet");
    expect(picker?.id).toBe(TEAMS_FIELD_TECH);
    expect(picker?.choices).toHaveLength(2);
    const bare = buildTeamsMessage(buildMessageModel(ev("job_completed"), opts)).attachments[0].content as { body: { type: string }[]; actions: { type: string }[] };
    expect(bare.body.some((b) => b.type === "Input.ChoiceSet")).toBe(false);
    expect(bare.actions.map((a) => a.type)).toEqual(["Action.OpenUrl"]);
  });
});

describe("Slack request signature", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const ts = "1700000000";
  const now = 1700000000 * 1000;
  it("accepts a correct, fresh signature", async () => {
    const sig = await computeSlackSignature(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, sig, body, now)).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets, missing headers and replays", async () => {
    const sig = await computeSlackSignature(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, sig, body + "x", now)).toBe(false);
    expect(await verifySlackSignature("other", ts, sig, body, now)).toBe(false);
    expect(await verifySlackSignature(secret, null, sig, body, now)).toBe(false);
    expect(await verifySlackSignature(secret, ts, null, body, now)).toBe(false);
    expect(await verifySlackSignature(secret, ts, sig, body, now + 6 * 60 * 1000)).toBe(false);
  });
});

describe("secret encryption", () => {
  const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
  const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));
  it("round-trips and never repeats ciphertext", async () => {
    const a = await encryptSecret("xoxb-secret-token", key);
    const b = await encryptSecret("xoxb-secret-token", key);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("xoxb");
    expect(a === b).toBe(false);
    expect(await decryptSecret(a, key)).toBe("xoxb-secret-token");
  });
  it("fails with the wrong key, a corrupt blob or a short key", async () => {
    const blob = await encryptSecret("t", key);
    await expect(decryptSecret(blob, otherKey)).rejects.toThrow();
    await expect(decryptSecret("garbage", key)).rejects.toThrow();
    await expect(encryptSecret("t", btoa("short"))).rejects.toThrow();
  });
  it("timingSafeEqual compares correctly", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("Teams helpers", () => {
  it("only trusts Microsoft Bot Framework service URLs (SSRF guard for the bot token)", () => {
    expect(isTrustedServiceUrl("https://smba.trafficmanager.net/amer/")).toBe(true);
    expect(isTrustedServiceUrl("https://smba.infra.gov.teams.microsoft.us/")).toBe(true);
    expect(isTrustedServiceUrl("http://smba.trafficmanager.net/amer/")).toBe(false);
    expect(isTrustedServiceUrl("https://evil.example.com/")).toBe(false);
    expect(isTrustedServiceUrl("https://trafficmanager.net.evil.com/")).toBe(false);
    expect(isTrustedServiceUrl("not a url")).toBe(false);
    expect(isTrustedServiceUrl(undefined)).toBe(false);
  });
  it("normalizes the trailing slash", () => {
    expect(normalizeServiceUrl("https://smba.trafficmanager.net/amer")).toBe("https://smba.trafficmanager.net/amer/");
    expect(normalizeServiceUrl("https://smba.trafficmanager.net/amer/")).toBe("https://smba.trafficmanager.net/amer/");
  });
  it("decodes a JWT payload and tolerates garbage", () => {
    const payload = btoa(JSON.stringify({ tid: "abc", name: "Zoë" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeJwtPayload(`h.${payload}.s`)?.tid).toBe("abc");
    expect(decodeJwtPayload("nope")).toBeNull();
    expect(decodeJwtPayload("a.%%%.c")).toBeNull();
  });
  it("ships a sample payload for every event type", () => {
    for (const t of CHAT_EVENT_TYPES) expect(Object.keys(SAMPLE_PAYLOADS[t]).length > 0).toBe(true);
  });
});
