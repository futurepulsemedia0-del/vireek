import { describe, it, expect } from "vitest";
import {
  processInboundAutoReply,
  type AutoReplyDeps,
  type BusinessRecord,
  type ConversationState,
  type EngineSettings,
  type GenerateResult,
  type InboundInput,
  type KnowledgeContext,
  type LogPatch,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// In-memory harness
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-07T20:00:00Z"); // Wed 16:00 New York

const SETTINGS: EngineSettings = {
  smsEnabled: true,
  emailEnabled: true,
  mode: "auto",
  confidenceThreshold: 0.8,
  escalationKeywords: ["mold"],
  useDefaultKeywords: true,
  scope: "always",
  timezone: "America/New_York",
  shareBookingLink: true,
  sendEscalationAck: true,
  escalationAckMessage: null,
  signature: null,
  extraInstructions: null,
  maxAutoRepliesPerDay: 4,
  humanTakeoverMinutes: 120,
};

const BUSINESS: BusinessRecord = {
  name: "Acme Plumbing",
  services: ["Drain cleaning", "Water heaters"],
  hours: { wed: { open: "08:00", close: "17:00" } },
  holidays: null,
  bookingUrl: "https://app.vireek.com/book/acme",
  bookingRules: { leadTimeHours: 2, windowDays: 14, durationMinutes: 60 },
};

const KB_OK: KnowledgeContext = {
  tier: "confident",
  articleIds: ["a1"],
  contextText: "• Diagnostic fee: $89",
  groundingText: "Diagnostic fee: $89 and we service the whole county.",
};

function goodModel(over: Partial<NonNullable<GenerateResult["output"]>> = {}): GenerateResult {
  return {
    output: { reply: "Our diagnostic visit is $89.", confidence: 0.93, intent: "pricing", needsHuman: false, reason: "kb", ...over },
    outputBlocked: false,
    provider: "gemini",
    model: "flash",
    latencyMs: 420,
  };
}

interface Harness {
  deps: AutoReplyDeps;
  logs: Map<string, LogPatch>;
  delivered: Array<{ channel: string; body: string; sentBy: string }>;
  notifications: string[];
  needsHuman: string[];
  generateCalls: number;
  prompts: Array<{ system: string; user: string }>;
}

function harness(opts: {
  settings?: Partial<EngineSettings> | null;
  state?: Partial<ConversationState> | null;
  business?: Partial<BusinessRecord>;
  kb?: KnowledgeContext;
  model?: GenerateResult;
  recentReplies?: number;
  recentAck?: boolean;
  duplicate?: boolean;
  deliverResult?: { ok: true; messageId: string } | { ok: false; reason: string };
  throwOnGenerate?: boolean;
} = {}): Harness {
  const h: Harness = { deps: null as never, logs: new Map(), delivered: [], notifications: [], needsHuman: [], generateCalls: 0, prompts: [] };
  const settings = opts.settings === null ? null : { ...SETTINGS, ...opts.settings };
  const state = opts.state === null ? null : { aiPaused: false, priorAiMessages: 0, lastHumanReplyAt: null, ...opts.state };
  h.deps = {
    store: {
      claim: async () => (opts.duplicate ? null : "log-1"),
      getSettings: async () => settings,
      getConversationState: async () => state,
      countRecentReplies: async () => opts.recentReplies ?? 0,
      hasRecentEscalationAck: async () => opts.recentAck ?? false,
      getBusiness: async () => ({ ...BUSINESS, ...opts.business }),
      getRecentMessages: async () => [{ direction: "inbound", body: "hi" }],
      markNeedsHuman: async (_c, id) => void h.needsHuman.push(id),
      finish: async (id, patch) => void h.logs.set(id, patch),
    },
    searchKnowledge: async () => opts.kb ?? KB_OK,
    generate: async (req) => {
      h.generateCalls++;
      h.prompts.push(req);
      if (opts.throwOnGenerate) throw new Error("boom");
      return opts.model ?? goodModel();
    },
    deliver: async (req) => {
      h.delivered.push({ channel: req.channel, body: req.body, sentBy: req.sentBy });
      return opts.deliverResult ?? { ok: true, messageId: "msg-1" };
    },
    notifyOwner: async (_u, n) => void h.notifications.push(n.title),
    now: () => NOW,
  };
  return h;
}

const SMS: InboundInput = { userId: "u1", channel: "sms", conversationId: "c1", inboundMessageId: "m1", text: "How much is a diagnostic visit?", customerLabel: "+15551234567" };
const EMAIL: InboundInput = { userId: "u1", channel: "email", conversationId: "c2", inboundMessageId: "m2", text: "What is your diagnostic fee?", subject: "Question", senderAddress: "jane@example.com" };

// ---------------------------------------------------------------------------

describe("processInboundAutoReply — happy path", () => {
  it("auto-sends a grounded, confident SMS reply with the AI disclosure and logs everything", async () => {
    const h = harness();
    const res = await processInboundAutoReply(h.deps, SMS);
    expect(res).toEqual({ status: "sent", reason: "auto_sent" });
    expect(h.delivered.length).toBe(1);
    expect(h.delivered[0].sentBy).toBe("ai");
    expect(h.delivered[0].body).toContain("$89");
    expect(h.delivered[0].body).toContain("Acme Plumbing automated assistant");
    const log = h.logs.get("log-1");
    expect(log?.status).toBe("sent");
    expect(log?.confidence).toBe(0.93);
    expect(log?.epistemicTier).toBe("confident");
    expect(log?.articleIds).toEqual(["a1"]);
    expect(log?.outboundMessageId).toBe("msg-1");
    expect(log?.provider).toBe("gemini");
  });

  it("skips the SMS signature after the first AI message but always signs emails", async () => {
    const sms = harness({ state: { priorAiMessages: 2 } });
    await processInboundAutoReply(sms.deps, SMS);
    expect(sms.delivered[0].body).not.toContain("automated assistant");
    const mail = harness({ state: { priorAiMessages: 2 } });
    await processInboundAutoReply(mail.deps, EMAIL);
    expect(mail.delivered[0].body).toContain("automated assistant");
  });

  it("gives the model the booking link and rules, and wraps the customer text as untrusted data", async () => {
    const h = harness();
    await processInboundAutoReply(h.deps, SMS);
    expect(h.prompts[0].user).toContain("https://app.vireek.com/book/acme");
    expect(h.prompts[0].user).toContain("at least 2h ahead");
    expect(h.prompts[0].user).toContain("<customer_message>");
    expect(h.prompts[0].system).toContain("Never confirm, schedule");
  });

  it("withholds the booking link from the model when sharing is turned off", async () => {
    const h = harness({ settings: { shareBookingLink: false } });
    await processInboundAutoReply(h.deps, SMS);
    expect(h.prompts[0].user).not.toContain("app.vireek.com");
    expect(h.prompts[0].user).toContain("No online booking link is available");
  });
});

describe("processInboundAutoReply — human approval & confidence", () => {
  it("queues for approval in approval mode and never sends", async () => {
    const h = harness({ settings: { mode: "approval" } });
    const res = await processInboundAutoReply(h.deps, SMS);
    expect(res).toEqual({ status: "pending_approval", reason: "approval_mode" });
    expect(h.delivered.length).toBe(0);
    expect(h.logs.get("log-1")?.draftBody).toContain("$89");
    expect(h.notifications).toContain("AI reply waiting for approval");
  });

  it("queues when confidence is below the owner's threshold", async () => {
    const h = harness({ model: goodModel({ confidence: 0.6 }) });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "pending_approval", reason: "below_threshold" });
    expect(h.delivered.length).toBe(0);
  });

  it("caps a confident-sounding model when retrieval only found a weak match", async () => {
    const h = harness({ kb: { ...KB_OK, tier: "weak_match" }, model: goodModel({ confidence: 0.99 }) });
    const res = await processInboundAutoReply(h.deps, SMS);
    expect(res.status).toBe("pending_approval");
    expect(h.logs.get("log-1")?.confidence).toBe(0.55);
  });

  it("queues when the draft quotes a price that is not in the knowledge base — even at 100% confidence", async () => {
    const h = harness({ model: goodModel({ reply: "That costs $149.", confidence: 1 }) });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "pending_approval", reason: "guard_ungrounded_amount" });
    expect(h.delivered.length).toBe(0);
  });

  it("queues when the output guardrail trips", async () => {
    const h = harness({ model: { ...goodModel(), outputBlocked: true } });
    expect((await processInboundAutoReply(h.deps, SMS)).reason).toBe("guard_output_guardrail");
  });
});

describe("processInboundAutoReply — escalation", () => {
  it("escalates on a built-in keyword BEFORE calling the model, flags the thread and sends the holding message", async () => {
    const h = harness();
    const res = await processInboundAutoReply(h.deps, { ...SMS, text: "I smell gas in my kitchen" });
    expect(res).toEqual({ status: "escalated", reason: "escalation_keyword" });
    expect(h.generateCalls).toBe(0);
    expect(h.needsHuman).toEqual(["c1"]);
    expect(h.delivered.length).toBe(1);
    expect(h.delivered[0].body).toContain("emergency");
    expect(h.logs.get("log-1")?.matchedKeyword).toBe("smell gas");
    expect(h.notifications).toContain("Customer needs a human");
  });

  it("honours the owner's own keywords", async () => {
    const h = harness();
    const res = await processInboundAutoReply(h.deps, { ...SMS, text: "we found mold behind the wall" });
    expect(res.status).toBe("escalated");
    expect(h.logs.get("log-1")?.matchedKeyword).toBe("mold");
  });

  it("does not text the customer in approval mode (flag + notify only)", async () => {
    const h = harness({ settings: { mode: "approval" } });
    const res = await processInboundAutoReply(h.deps, { ...SMS, text: "I want a refund" });
    expect(res.status).toBe("escalated");
    expect(h.delivered.length).toBe(0);
    expect(h.needsHuman.length).toBe(1);
  });

  it("does not repeat the holding message within the ack window", async () => {
    const h = harness({ recentAck: true });
    await processInboundAutoReply(h.deps, { ...SMS, text: "this is unacceptable" });
    expect(h.delivered.length).toBe(0);
  });

  it("escalates when the model itself asks for a human", async () => {
    const h = harness({ model: goodModel({ needsHuman: true, reply: "A teammate will confirm." }) });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "escalated", reason: "model_requested_human" });
    expect(h.needsHuman).toEqual(["c1"]);
  });
});

describe("processInboundAutoReply — guards that must stay silent", () => {
  const cases: Array<[string, Parameters<typeof harness>[0], InboundInput, string]> = [
    ["feature disabled", { settings: { smsEnabled: false } }, SMS, "disabled"],
    ["no settings row", { settings: null }, SMS, "disabled"],
    ["paused conversation", { state: { aiPaused: true } }, SMS, "ai_paused"],
    ["STOP keyword", {}, { ...SMS, text: "STOP" }, "carrier_keyword"],
    ["empty message", {}, { ...SMS, text: "   " }, "empty_message"],
    ["automated email sender", {}, { ...EMAIL, senderAddress: "no-reply@shop.com" }, "automated_sender"],
    ["a human replied 30 minutes ago", { state: { lastHumanReplyAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() } }, SMS, "human_active"],
    ["daily cap reached", { recentReplies: 4 }, SMS, "rate_limited"],
    ["after-hours-only while open", { settings: { scope: "after_hours_only" } }, SMS, "business_open"],
    ["conversation vanished", { state: null }, SMS, "conversation_missing"],
  ];
  for (const [name, opts, input, reason] of cases) {
    it(`skips: ${name}`, async () => {
      const h = harness(opts);
      expect(await processInboundAutoReply(h.deps, input)).toEqual({ status: "skipped", reason });
      expect(h.delivered.length).toBe(0);
      expect(h.generateCalls).toBe(0);
    });
  }

  it("answers again once the human has been quiet longer than the takeover window", async () => {
    const h = harness({ state: { lastHumanReplyAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() } });
    expect((await processInboundAutoReply(h.deps, SMS)).status).toBe("sent");
  });

  it("replies after hours when scope is after_hours_only", async () => {
    const h = harness({ settings: { scope: "after_hours_only" }, business: { hours: { wed: { open: "08:00", close: "12:00" } } } });
    expect((await processInboundAutoReply(h.deps, SMS)).status).toBe("sent");
  });

  it("is idempotent: a re-delivered webhook is a no-op", async () => {
    const h = harness({ duplicate: true });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "duplicate", reason: "already_processed" });
    expect(h.generateCalls).toBe(0);
  });
});

describe("processInboundAutoReply — failure handling", () => {
  it("flags the thread for a human when no model is available", async () => {
    const h = harness({ model: { output: null, outputBlocked: false, provider: null, model: null, latencyMs: null } });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "failed", reason: "model_unavailable" });
    expect(h.needsHuman).toEqual(["c1"]);
  });

  it("never throws — an unexpected error becomes a failed log row and a human flag", async () => {
    const h = harness({ throwOnGenerate: true });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "failed", reason: "exception" });
    expect(h.logs.get("log-1")?.status).toBe("failed");
    expect(h.needsHuman).toEqual(["c1"]);
  });

  it("records a failed delivery and flags a human (e.g. A2P not approved)", async () => {
    const h = harness({ deliverResult: { ok: false, reason: "A2P_NOT_APPROVED" } });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "failed", reason: "delivery_a2p_not_approved" });
    expect(h.needsHuman).toEqual(["c1"]);
    expect(h.logs.get("log-1")?.draftBody).toContain("$89");
  });

  it("treats an opted-out number as a quiet skip, not an error", async () => {
    const h = harness({ deliverResult: { ok: false, reason: "OPTED_OUT" } });
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "skipped", reason: "opted_out" });
    expect(h.needsHuman.length).toBe(0);
  });

  it("survives a failing claim", async () => {
    const h = harness();
    h.deps.store.claim = async () => { throw new Error("db down"); };
    expect(await processInboundAutoReply(h.deps, SMS)).toEqual({ status: "failed", reason: "claim_error" });
  });
});
