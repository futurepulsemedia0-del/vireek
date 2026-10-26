// supabase/functions/_shared/richMessaging/send.ts
//
// Orchestrates every outbound rich message and every provider receipt. Pure (all I/O is
// injected through RichSendDeps), so the whole decision tree is unit-tested without a network
// or database. Real dependencies live in runtime.ts.
//
// Guarantees:
//   * Consent first: STOP/DNC suppression and Apple "conversation deleted" are checked before
//     anything is sent (bypass exists ONLY for the STOP/START/HELP acknowledgement itself).
//   * Transactional only: marketing purpose is rejected here (RCS/Apple need explicit opt-in flows).
//   * Quiet hours are enforced for rich sends exactly like SMS; held messages are persisted and
//     released by rich-fallback-sweep after the gate is re-run.
//   * Automatic SMS fallback ALWAYS goes through sendCompliantSms (A2P + STOP + quiet hours),
//     is armed with a deadline, and is claimed atomically so it can never run twice.

import { bodyOf, fallbackTextOf, validateContent } from "./cards.ts";
import { pickRoute } from "./capability.ts";
import type {
  CapabilityRecord, CapabilityStatus, DeliveryEvent, FallbackState, Purpose, RichAccount, RichChannel,
  RichContent, RichConversationRef, RichProvider, RichStatus, StoredMessage,
} from "./types.ts";

// ---- dependency contracts -------------------------------------------------------------

export interface NewOutbound {
  userId: string;
  conversationId: string;
  content: RichContent;
  body: string;
  purpose: Purpose;
  source: string;
  sentBy: "human" | "system" | "ai" | "ai_approved";
  dedupeKey: string | null;
  customerId: string | null;
  status: "queued" | "deferred";
  scheduledFor: string | null;
  fallbackState: "none" | "armed";
  fallbackDeadline: string | null;
  fallbackText: string | null;
  fallbackPhone: string | null;
}

export interface MessagePatch {
  status?: RichStatus;
  providerMessageId?: string;
  failureReason?: string | null;
  fallbackState?: FallbackState;
  fallbackSmsSid?: string | null;
  scheduledFor?: string | null;
  deliveredAt?: string;
  readAt?: string;
}

export interface PatchCondition {
  status?: RichStatus[];
  fallbackState?: FallbackState[];
}

export interface RichMessageStore {
  /** `duplicate: true` => a row with the same (conversation, dedupeKey) already exists; `id` is that row. */
  insertOutbound(row: NewOutbound): Promise<{ id: string; duplicate: boolean }>;
  get(id: string): Promise<StoredMessage | null>;
  findForReceipt(correlationId: string | null, providerMessageId: string): Promise<StoredMessage | null>;
  /** Conditional update. Resolves true only if a row matched the condition and was changed. */
  patch(id: string, patch: MessagePatch, when?: PatchCondition): Promise<boolean>;
}

export type SmsOutcome =
  | { ok: true; sid: string; deferred?: boolean; sendAt?: string }
  | { ok: false; reason: string; detail?: string };

export interface RichSendDeps {
  now(): Date;
  loadAccount(userId: string): Promise<RichAccount | null>;
  upsertConversation(p: { userId: string; channel: RichChannel; identity: string; phone: string | null; name: string | null }): Promise<RichConversationRef>;
  getConversation(id: string): Promise<RichConversationRef | null>;
  getCapability(userId: string, channel: RichChannel, identity: string): Promise<CapabilityRecord | null>;
  putCapability(userId: string, channel: RichChannel, identity: string, status: CapabilityStatus, features?: unknown): Promise<void>;
  isSuppressed(userId: string, phone: string): Promise<boolean>;
  gateQuietHours(userId: string, i: { to: string; purpose: Purpose; customerId: string | null; override: { reason: string } | null; source: string }): Promise<{ proceed: true } | { proceed: false; sendAt: string }>;
  provider: RichProvider;
  messages: RichMessageStore;
  sendSms(userId: string, to: string, body: string, o: { purpose: Purpose; customerId: string | null; source: string; dedupeKey?: string; override: { reason: string } | null }): Promise<SmsOutcome>;
  /** Mirrors the SMS into sms_conversations / sms_messages so the SMS inbox thread stays complete. */
  logSmsThread(userId: string, phone: string, body: string, sid: string): Promise<void>;
}

// ---- inputs / results -----------------------------------------------------------------

export interface SendRichInput {
  userId: string;
  /** Recipient phone (E.164). Optional when replying inside `conversation`. */
  phone?: string | null;
  /** Existing rich thread to reply into. */
  conversation?: RichConversationRef | null;
  customerName?: string | null;
  content: RichContent;
  purpose?: Purpose;
  source: string;
  customerId?: string | null;
  dedupeKey?: string;
  sentBy?: "human" | "system";
  override?: { reason: string } | null;
  fallbackAfterSeconds?: number;
  /** ONLY for the STOP / START / HELP acknowledgement: skips suppression + quiet hours. */
  isConsentReply?: boolean;
}

export type SendRichFailure =
  | "INVALID_CONTENT" | "MARKETING_NOT_SUPPORTED" | "NO_RECIPIENT" | "OPTED_OUT" | "CONVERSATION_CLOSED"
  | "PROVIDER_ERROR" | "SMS_FAILED";

export type SendRichResult =
  | { ok: true; route: RichChannel; status: "sent" | "deferred"; messageId: string; sendAt?: string; duplicate?: boolean }
  | { ok: true; route: "sms"; sid: string; deferred?: boolean; sendAt?: string; messageId?: string; viaFallback?: boolean }
  | { ok: false; reason: SendRichFailure; detail?: string; messageId?: string };

const fail = (reason: SendRichFailure, detail?: string, messageId?: string): SendRichResult => ({ ok: false, reason, detail, messageId });

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

// ---- main entry -------------------------------------------------------------------------

export async function sendRich(deps: RichSendDeps, input: SendRichInput, resume?: StoredMessage): Promise<SendRichResult> {
  const invalid = validateContent(input.content);
  if (invalid) return fail("INVALID_CONTENT", invalid);

  const purpose: Purpose = input.purpose ?? "service";
  if (purpose === "marketing") return fail("MARKETING_NOT_SUPPORTED", "RCS / Apple Messages are transactional-only until a marketing opt-in flow exists.");

  let conv = input.conversation ?? null;
  const phone = input.phone ?? conv?.phone ?? null;
  if (!phone && !conv) return fail("NO_RECIPIENT");

  // 1. Consent. Never skipped except for the acknowledgement of a consent keyword.
  if (!input.isConsentReply) {
    if (conv?.optedOutAt) return fail("OPTED_OUT", "Customer opted out on this thread.");
    if (phone && (await deps.isSuppressed(input.userId, phone))) return fail("OPTED_OUT", "Number is on the do-not-contact list.");
  }
  if (conv?.channel === "amb" && conv.customerClosedAt && !input.isConsentReply) {
    return fail("CONVERSATION_CLOSED", "Customer deleted the Apple Messages conversation.");
  }

  // 2. Route (capability per recipient).
  const account = await deps.loadAccount(input.userId);
  const rcsIdentity = conv ? (conv.channel === "rcs" ? conv.identity : null) : phone;
  const capability = rcsIdentity ? await deps.getCapability(input.userId, "rcs", rcsIdentity) : null;
  const now = deps.now();
  const decision = pickRoute({ account, conversation: conv, phone, capability, now });

  if (decision.probe && account && rcsIdentity && decision.route !== "amb") {
    await deps.provider.queryCapability(account, "rcs", rcsIdentity).catch(() => false);
  }

  // 3. Plain SMS route (RCS/Apple not usable or recipient not capable).
  if (decision.route === "sms") {
    if (!phone) return fail("NO_RECIPIENT", "No phone number to send an SMS to.");
    return viaSms(deps, input, phone, purpose, false);
  }

  // 4. Rich route. The thread must exist before a message row can reference it.
  const channel: RichChannel = decision.route;
  conv ??= await deps.upsertConversation({ userId: input.userId, channel: "rcs", identity: phone!, phone, name: input.customerName ?? null });
  if (!account) return fail("PROVIDER_ERROR", "No messaging account.");

  // 4a. Quiet hours (same rules as SMS).
  if (!input.isConsentReply) {
    const gate = await deps.gateQuietHours(input.userId, { to: phone ?? "", purpose, customerId: input.customerId ?? null, override: input.override ?? null, source: input.source });
    if (!gate.proceed) {
      if (resume) {
        await deps.messages.patch(resume.id, { status: "deferred", scheduledFor: gate.sendAt });
        return { ok: true, route: channel, status: "deferred", messageId: resume.id, sendAt: gate.sendAt };
      }
      const held = await deps.messages.insertOutbound(rowFor(input, conv, purpose, { status: "deferred", scheduledFor: gate.sendAt, fallback: null }));
      return { ok: true, route: channel, status: "deferred", messageId: held.id, sendAt: gate.sendAt, duplicate: held.duplicate || undefined };
    }
  }

  // 4b. Persist BEFORE calling the provider: the row id is the provider correlation id, so a
  //     crash after the provider accepted the message can still be reconciled by its receipt.
  const armed = decision.armFallback && !!phone && !!account.fallbackToSms;
  const seconds = clamp(input.fallbackAfterSeconds ?? account.fallbackAfterSeconds, 10, 900);
  const fallback = armed ? { deadline: new Date(now.getTime() + seconds * 1000).toISOString(), text: fallbackTextOf(input.content), phone: phone! } : null;

  let messageId: string;
  if (resume) {
    messageId = resume.id;
    if (fallback) await deps.messages.patch(resume.id, { fallbackState: "armed" });
  } else {
    const ins = await deps.messages.insertOutbound(rowFor(input, conv, purpose, { status: "queued", scheduledFor: null, fallback }));
    if (ins.duplicate) return { ok: true, route: channel, status: "sent", messageId: ins.id, duplicate: true };
    messageId = ins.id;
  }

  // 4c. Provider send.
  const res = await deps.provider.send({
    account, channel, identity: conv.identity, content: input.content, correlationId: messageId, ttlSeconds: armed ? seconds : undefined,
  });

  if (res.ok) {
    const advanced = await deps.messages.patch(messageId, { status: "sent", providerMessageId: res.providerMessageId }, { status: ["queued"] });
    // A receipt can beat us here; never downgrade, but always remember the provider id.
    if (!advanced) await deps.messages.patch(messageId, { providerMessageId: res.providerMessageId });
    return { ok: true, route: channel, status: "sent", messageId };
  }

  // 4d. Provider refused: fall back right away when armed, otherwise mark failed.
  if (armed && (await deps.messages.patch(messageId, { fallbackState: "sending" }, { fallbackState: ["armed"] }))) {
    const stored = await deps.messages.get(messageId);
    if (stored) {
      const fb = await runFallback(deps, stored, "provider_error");
      if (fb.ok) return { ok: true, route: "sms", sid: fb.sid, deferred: fb.deferred, sendAt: fb.sendAt, messageId, viaFallback: true };
      return fail("SMS_FAILED", fb.detail, messageId);
    }
  }
  await deps.messages.patch(messageId, { status: "failed", failureReason: res.error.slice(0, 300) }, { status: ["queued"] });
  return fail("PROVIDER_ERROR", res.error, messageId);
}

function rowFor(
  input: SendRichInput,
  conv: RichConversationRef,
  purpose: Purpose,
  o: { status: "queued" | "deferred"; scheduledFor: string | null; fallback: { deadline: string; text: string; phone: string } | null },
): NewOutbound {
  return {
    userId: input.userId,
    conversationId: conv.id,
    content: input.content,
    body: bodyOf(input.content),
    purpose,
    source: input.source,
    sentBy: input.sentBy ?? "system",
    dedupeKey: input.dedupeKey ?? null,
    customerId: input.customerId ?? null,
    status: o.status,
    scheduledFor: o.scheduledFor,
    fallbackState: o.fallback ? "armed" : "none",
    fallbackDeadline: o.fallback?.deadline ?? null,
    fallbackText: o.fallback?.text ?? null,
    fallbackPhone: o.fallback?.phone ?? null,
  };
}

async function viaSms(deps: RichSendDeps, input: SendRichInput, phone: string, purpose: Purpose, viaFallback: boolean): Promise<SendRichResult> {
  const body = fallbackTextOf(input.content);
  const res = await deps.sendSms(input.userId, phone, body, {
    purpose, customerId: input.customerId ?? null, source: input.source, dedupeKey: input.dedupeKey, override: input.override ?? null,
  });
  if (!res.ok) return fail("SMS_FAILED", `${res.reason}${res.detail ? `: ${res.detail}` : ""}`);
  await deps.logSmsThread(input.userId, phone, body, res.sid);
  return { ok: true, route: "sms", sid: res.sid, deferred: res.deferred, sendAt: res.sendAt, viaFallback };
}

// ---- deferred release (rich-fallback-sweep) --------------------------------------------------

/** Re-runs the whole pipeline (consent, capability, quiet hours) for a row released from the deferral queue. */
export async function dispatchDeferred(deps: RichSendDeps, row: StoredMessage): Promise<SendRichResult> {
  const conv = await deps.getConversation(row.conversationId);
  if (!row.content || !conv) {
    await deps.messages.patch(row.id, { status: "failed", failureReason: "deferred_message_unrecoverable" });
    return fail("INVALID_CONTENT", "Deferred message is missing content or thread.", row.id);
  }
  const res = await sendRich(deps, {
    userId: row.userId, conversation: conv, phone: conv.phone, content: row.content, purpose: row.purpose,
    source: row.source ?? "rich-deferred", customerId: row.customerId, sentBy: row.sentBy === "human" ? "human" : "system",
  }, row);
  if (!res.ok) {
    await deps.messages.patch(row.id, { status: "failed", failureReason: `${res.reason}${res.detail ? `: ${res.detail}` : ""}`.slice(0, 300) });
  } else if (res.route === "sms") {
    // Routed to SMS at release time (e.g. capability changed): the rich row is superseded.
    await deps.messages.patch(row.id, { status: "fallback_sent", fallbackSmsSid: res.sid, failureReason: "rerouted_to_sms" });
  }
  return res;
}

// ---- SMS fallback ----------------------------------------------------------------------------

export type FallbackTrigger = "provider_error" | "provider_failed" | "timeout";

/** Precondition: the caller atomically moved fallback_state armed -> sending (so this runs once). */
export async function runFallback(
  deps: RichSendDeps,
  row: StoredMessage,
  trigger: FallbackTrigger,
): Promise<{ ok: true; sid: string; deferred?: boolean; sendAt?: string } | { ok: false; detail: string }> {
  const failWith = async (detail: string) => {
    await deps.messages.patch(row.id, { status: "failed", fallbackState: "failed", failureReason: `fallback: ${detail}`.slice(0, 300) });
    return { ok: false as const, detail };
  };

  const phone = row.fallbackPhone;
  const text = row.fallbackText;
  if (!phone || !text) return failWith("no phone/text for SMS fallback");
  if (await deps.isSuppressed(row.userId, phone)) return failWith("recipient opted out");

  const res = await deps.sendSms(row.userId, phone, text, {
    purpose: row.purpose, customerId: row.customerId, source: `rich-fallback:${trigger}`, dedupeKey: `rich-fb:${row.id}`, override: null,
  });
  if (!res.ok) return failWith(`${res.reason}${res.detail ? `: ${res.detail}` : ""}`);

  await deps.messages.patch(row.id, { status: "fallback_sent", fallbackState: "sent", fallbackSmsSid: res.sid, failureReason: null });
  await deps.logSmsThread(row.userId, phone, text, res.sid);
  return { ok: true, sid: res.sid, deferred: res.deferred, sendAt: res.sendAt };
}

/** Sweeper entry: a claimed (armed -> sending) row whose deadline passed without a receipt. */
export function runTimeoutFallback(deps: RichSendDeps, row: StoredMessage) {
  return runFallback(deps, row, "timeout");
}

// ---- provider receipts -------------------------------------------------------------------------

const RANK: Record<string, number> = { queued: 0, deferred: 0, sent: 1, delivered: 2, read: 3 };

/** Delivery states only ever move forward; a late receipt never overwrites a fallback or a later state. */
export function nextDeliveryStatus(current: RichStatus, incoming: "delivered" | "read"): RichStatus | null {
  if (current === "fallback_sent" || current === "cancelled" || current === "received") return null;
  if (current === "failed") return incoming; // provider recovered after reporting failure
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : null;
}

export type ReceiptOutcome = "applied" | "ignored" | "unknown_message" | "fallback_triggered";

export async function applyDelivery(deps: RichSendDeps, ev: DeliveryEvent): Promise<ReceiptOutcome> {
  if (ev.status === "pending") return "ignored";
  const msg = await deps.messages.findForReceipt(ev.correlationId, ev.providerMessageId);
  if (!msg || msg.direction !== "outbound") return "unknown_message";
  const nowIso = deps.now().toISOString();
  const conv = await deps.getConversation(msg.conversationId);

  if (ev.status === "delivered" || ev.status === "read") {
    const target = nextDeliveryStatus(msg.status, ev.status);
    await deps.messages.patch(msg.id, {
      ...(target ? { status: target } : {}),
      deliveredAt: msg.deliveredAt ?? nowIso,
      ...(ev.status === "read" ? { readAt: msg.readAt ?? nowIso } : {}),
      ...(msg.providerMessageId ? {} : { providerMessageId: ev.providerMessageId }),
    });
    await deps.messages.patch(msg.id, { fallbackState: "cancelled" }, { fallbackState: ["armed"] });
    if (conv && conv.channel === "rcs") await deps.putCapability(msg.userId, "rcs", conv.identity, "capable");
    return "applied";
  }

  // failed
  if (msg.status === "delivered" || msg.status === "read" || msg.status === "fallback_sent") return "ignored";
  await deps.messages.patch(msg.id, { status: "failed", failureReason: [ev.reasonCode, ev.reasonText].filter(Boolean).join(": ").slice(0, 300) || "provider_failed" }, { status: ["queued", "sent"] });
  if (conv && conv.channel === "rcs" && ev.reasonCode === "RECIPIENT_NOT_REACHABLE") {
    await deps.putCapability(msg.userId, "rcs", conv.identity, "not_capable");
  }
  if (await deps.messages.patch(msg.id, { fallbackState: "sending" }, { fallbackState: ["armed"] })) {
    const fresh = (await deps.messages.get(msg.id)) ?? msg;
    await runFallback(deps, fresh, "provider_failed");
    return "fallback_triggered";
  }
  return "applied";
}
