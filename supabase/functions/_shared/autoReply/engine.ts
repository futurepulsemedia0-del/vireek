// supabase/functions/_shared/autoReply/engine.ts
//
// Vireek — Inbound AI auto-reply orchestration (SMS + email).
//
// Every side effect (database, knowledge search, LLM, delivery, notifications)
// arrives through `AutoReplyDeps`, so this file has no Deno/npm imports and the
// whole decision pipeline is covered by engine.test.ts with in-memory fakes.
// runtime.ts wires the real implementations.
//
// Guarantees:
//  * idempotent  — one auto_reply_log row per inbound message (unique key);
//  * never throws — webhooks must always answer 200 so providers don't retry-storm;
//  * fail-safe   — any doubt ends in a human (queue / escalate), never a guess;
//  * fully logged — every inbound message gets exactly one terminal log row.

import {
  DEFAULT_ESCALATION_ACK,
  combineConfidence,
  decideAction,
  findEscalationKeyword,
  findReplyViolations,
  finalizeReply,
  isAutomatedSender,
  isBusinessOpen,
  isCarrierKeyword,
  summarizeHours,
  type BusinessHoursMap,
  type Channel,
  type EpistemicTier,
  type HolidayEntry,
  type ModelOutput,
  type ReplyMode,
} from "./decision.ts";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type BusinessContext,
  type PromptHistoryItem,
} from "./prompt.ts";

export type LogStatus = "processing" | "sent" | "pending_approval" | "escalated" | "skipped" | "rejected" | "failed";

export interface EngineSettings {
  smsEnabled: boolean;
  emailEnabled: boolean;
  mode: ReplyMode;
  confidenceThreshold: number;
  escalationKeywords: string[];
  useDefaultKeywords: boolean;
  scope: "always" | "after_hours_only";
  timezone: string;
  shareBookingLink: boolean;
  sendEscalationAck: boolean;
  escalationAckMessage: string | null;
  signature: string | null;
  extraInstructions: string | null;
  maxAutoRepliesPerDay: number;
  humanTakeoverMinutes: number;
}

export interface ConversationState {
  aiPaused: boolean;
  priorAiMessages: number;
  lastHumanReplyAt: string | null;
}

export interface BusinessRecord {
  name: string;
  services: string[];
  hours: BusinessHoursMap | null;
  holidays: HolidayEntry[] | null;
  bookingUrl: string | null;
  bookingRules: BusinessContext["bookingRules"];
}

export interface KnowledgeContext {
  tier: EpistemicTier;
  articleIds: string[];
  contextText: string; // trimmed excerpts shown to the model
  groundingText: string; // full text used to verify amounts in the draft
}

export interface LogPatch {
  status: LogStatus;
  reason: string;
  matchedKeyword?: string | null;
  confidence?: number | null;
  epistemicTier?: EpistemicTier | null;
  articleIds?: string[];
  draftBody?: string | null;
  finalBody?: string | null;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  outboundMessageId?: string | null;
}

export interface GenerateResult {
  output: ModelOutput | null;
  outputBlocked: boolean; // output guardrail tripped (identity leak, etc.)
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
}

export type DeliverResult = { ok: true; messageId: string } | { ok: false; reason: string };

export interface AutoReplyStore {
  /** Inserts the 'processing' log row. Returns its id, or null when this inbound message was already claimed. */
  claim(i: { userId: string; channel: Channel; conversationId: string; inboundMessageId: string }): Promise<string | null>;
  getSettings(userId: string): Promise<EngineSettings | null>;
  getConversationState(channel: Channel, conversationId: string): Promise<ConversationState | null>;
  countRecentReplies(userId: string, channel: Channel, conversationId: string, sinceIso: string): Promise<number>;
  hasRecentEscalationAck(userId: string, channel: Channel, conversationId: string, sinceIso: string): Promise<boolean>;
  getBusiness(userId: string): Promise<BusinessRecord>;
  getRecentMessages(channel: Channel, conversationId: string, limit: number, excludeMessageId: string): Promise<PromptHistoryItem[]>;
  markNeedsHuman(channel: Channel, conversationId: string): Promise<void>;
  finish(logId: string, patch: LogPatch): Promise<void>;
}

export interface AutoReplyDeps {
  store: AutoReplyStore;
  searchKnowledge(userId: string, question: string, channel: Channel): Promise<KnowledgeContext>;
  generate(req: { system: string; user: string }): Promise<GenerateResult>;
  deliver(req: {
    userId: string;
    channel: Channel;
    conversationId: string;
    body: string;
    sentBy: "ai" | "ai_approved";
  }): Promise<DeliverResult>;
  notifyOwner(userId: string, n: { title: string; message: string }): Promise<void>;
  now(): Date;
  log?(event: string, data: Record<string, unknown>): void;
}

export interface InboundInput {
  userId: string;
  channel: Channel;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  subject?: string | null;
  senderAddress?: string | null; // email only
  headers?: Record<string, string> | null; // email only, optional
  customerLabel?: string | null;
}

export interface EngineResult {
  status: LogStatus | "duplicate";
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACK_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function processInboundAutoReply(deps: AutoReplyDeps, input: InboundInput): Promise<EngineResult> {
  const { store } = deps;
  let logId: string | null;
  try {
    logId = await store.claim({
      userId: input.userId,
      channel: input.channel,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
    });
  } catch (error) {
    deps.log?.("auto_reply_claim_failed", { error: errMsg(error) });
    return { status: "failed", reason: "claim_error" };
  }
  if (!logId) return { status: "duplicate", reason: "already_processed" };
  const claimed: string = logId;

  const finish = async (status: LogStatus, reason: string, patch: Partial<LogPatch> = {}): Promise<EngineResult> => {
    try {
      await store.finish(claimed, { status, reason, ...patch });
    } catch (error) {
      deps.log?.("auto_reply_finish_failed", { logId: claimed, error: errMsg(error) });
    }
    return { status, reason };
  };

  try {
    const settings = await store.getSettings(input.userId);
    const enabled = input.channel === "sms" ? settings?.smsEnabled : settings?.emailEnabled;
    if (!settings || !enabled) return finish("skipped", "disabled");

    const text = (input.text ?? "").trim();
    if (!text) return finish("skipped", "empty_message");

    if (input.channel === "sms" && isCarrierKeyword(text)) return finish("skipped", "carrier_keyword");
    if (input.channel === "email" && isAutomatedSender(input.senderAddress ?? "", input.headers, input.subject)) {
      return finish("skipped", "automated_sender");
    }

    const state = await store.getConversationState(input.channel, input.conversationId);
    if (!state) return finish("skipped", "conversation_missing");
    if (state.aiPaused) return finish("skipped", "ai_paused");

    const now = deps.now();
    if (settings.humanTakeoverMinutes > 0 && state.lastHumanReplyAt) {
      const sinceHuman = now.getTime() - new Date(state.lastHumanReplyAt).getTime();
      if (sinceHuman >= 0 && sinceHuman < settings.humanTakeoverMinutes * 60_000) return finish("skipped", "human_active");
    }

    const business = await store.getBusiness(input.userId);
    const openNow = isBusinessOpen(business.hours, business.holidays, now, settings.timezone);
    if (settings.scope === "after_hours_only" && openNow === true) return finish("skipped", "business_open");

    const customerLabel = input.customerLabel || "a customer";
    const channelLabel = input.channel === "sms" ? "SMS" : "email";

    // --- Escalation: handled BEFORE any model call, so risky messages never wait on (or depend on) an LLM.
    const keyword = findEscalationKeyword(text, settings.escalationKeywords, settings.useDefaultKeywords);
    const escalate = async (reason: string, patch: Partial<LogPatch>): Promise<EngineResult> => {
      await store.markNeedsHuman(input.channel, input.conversationId);
      let outboundMessageId: string | null = null;
      let ackBody: string | null = null;
      if (settings.sendEscalationAck && settings.mode === "auto") {
        const alreadyAcked = await store.hasRecentEscalationAck(
          input.userId, input.channel, input.conversationId, new Date(now.getTime() - ACK_WINDOW_MS).toISOString(),
        );
        if (!alreadyAcked) {
          ackBody = finalizeReply(settings.escalationAckMessage?.trim() || DEFAULT_ESCALATION_ACK, {
            channel: input.channel, signature: null, includeSignature: false,
          });
          const sent = await deps.deliver({
            userId: input.userId, channel: input.channel, conversationId: input.conversationId, body: ackBody, sentBy: "ai",
          });
          if (sent.ok) outboundMessageId = sent.messageId;
          else ackBody = null;
        }
      }
      await deps.notifyOwner(input.userId, {
        title: "Customer needs a human",
        message: `${channelLabel} from ${customerLabel}: ${keyword ? `mentioned "${keyword}"` : reason.replace(/_/g, " ")}.`,
      }).catch(() => undefined);
      return finish("escalated", reason, { matchedKeyword: keyword, finalBody: ackBody, outboundMessageId, ...patch });
    };

    if (keyword) return escalate("escalation_keyword", {});

    // --- Loop / spam guard
    const recent = await store.countRecentReplies(
      input.userId, input.channel, input.conversationId, new Date(now.getTime() - DAY_MS).toISOString(),
    );
    if (recent >= settings.maxAutoRepliesPerDay) return finish("skipped", "rate_limited");

    // --- Ground the answer in the business's own knowledge base + booking rules
    const knowledge = await deps.searchKnowledge(input.userId, text, input.channel);
    const history = await store.getRecentMessages(input.channel, input.conversationId, 6, input.inboundMessageId);
    const businessContext: BusinessContext = {
      name: business.name,
      services: business.services,
      hoursSummary: summarizeHours(business.hours),
      openNow,
      bookingUrl: business.bookingUrl,
      bookingRules: business.bookingRules,
    };

    const generated = await deps.generate({
      system: buildSystemPrompt({
        businessName: business.name, channel: input.channel, extraInstructions: settings.extraInstructions,
      }),
      user: buildUserPrompt({
        business: businessContext,
        knowledgeContext: knowledge.contextText,
        retrievalTier: knowledge.tier,
        history,
        customerMessage: text,
        subject: input.subject,
        shareBookingLink: settings.shareBookingLink,
      }),
    });

    const meta = { provider: generated.provider, model: generated.model, latencyMs: generated.latencyMs };
    const base = { epistemicTier: knowledge.tier, articleIds: knowledge.articleIds, ...meta };

    if (!generated.output) {
      await store.markNeedsHuman(input.channel, input.conversationId);
      return finish("failed", "model_unavailable", base);
    }
    const out = generated.output;

    const allowedUrls = settings.shareBookingLink && business.bookingUrl ? [business.bookingUrl] : [];
    const violations = findReplyViolations(out.reply, {
      groundingText: `${knowledge.groundingText} ${summarizeHours(business.hours) ?? ""} ${business.services.join(" ")}`,
      allowedUrls,
    });
    if (generated.outputBlocked) violations.push("output_guardrail");

    const confidence = combineConfidence({ intent: out.intent, modelConfidence: out.confidence, tier: knowledge.tier });
    const decision = decideAction({
      mode: settings.mode,
      threshold: settings.confidenceThreshold,
      confidence,
      modelNeedsHuman: out.needsHuman,
      violations,
    });

    const defaultSignature = `— ${business.name} automated assistant`;
    const draft = finalizeReply(out.reply, {
      channel: input.channel,
      signature: settings.signature?.trim() || defaultSignature,
      includeSignature: input.channel === "email" || state.priorAiMessages === 0,
    });
    const logBase = { ...base, confidence, draftBody: draft };

    if (decision.action === "escalate") return escalate(decision.reason, logBase);

    if (decision.action === "queue") {
      await deps.notifyOwner(input.userId, {
        title: "AI reply waiting for approval",
        message: `${channelLabel} from ${customerLabel} — ${decision.reason.replace(/_/g, " ")}.`,
      }).catch(() => undefined);
      return finish("pending_approval", decision.reason, logBase);
    }

    const sent = await deps.deliver({
      userId: input.userId, channel: input.channel, conversationId: input.conversationId, body: draft, sentBy: "ai",
    });
    if (sent.ok) return finish("sent", decision.reason, { ...logBase, finalBody: draft, outboundMessageId: sent.messageId });
    if (sent.reason === "OPTED_OUT") return finish("skipped", "opted_out", logBase);

    await store.markNeedsHuman(input.channel, input.conversationId);
    return finish("failed", `delivery_${sent.reason.toLowerCase()}`, logBase);
  } catch (error) {
    deps.log?.("auto_reply_engine_error", { logId: claimed, error: errMsg(error) });
    await store.markNeedsHuman(input.channel, input.conversationId).catch(() => undefined);
    return finish("failed", "exception");
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
