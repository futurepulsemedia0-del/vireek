// supabase/functions/_shared/richMessaging/inbound.ts
//
// Inbound handling for RCS / Apple Messages events. Mirrors sms-webhook step for step
// (resolve tenant -> STOP handling -> upsert thread -> de-duplicated insert -> language),
// with the consent logic shared via _shared/messaging/optOut.ts. Pure: I/O is injected.

import { parsePostback } from "./cards.ts";
import { classifyKeyword, helpText, optInAckText, optOutAckText } from "../messaging/optOut.ts";
import type {
  CapabilityEvent, ConversationDeletedEvent, InboundEvent, OptOutEvent, RichAccount, RichChannel, RichConversationRef,
} from "./types.ts";

export interface InboundMessageRow {
  userId: string;
  conversationId: string;
  kind: "text" | "reply" | "media";
  body: string;
  content: Record<string, unknown> | null;
  providerMessageId: string;
  createdAt: string;
}

export interface InboundDeps {
  resolveAccount(appId: string): Promise<RichAccount | null>;
  /** Upsert by (user, channel, identity); sets unread + last_message_at; clears customer_closed_at. */
  upsertInboundConversation(p: {
    userId: string; channel: RichChannel; identity: string; phone: string | null;
    contactId: string | null; providerConversationId: string | null; at: string;
  }): Promise<RichConversationRef>;
  findConversation(userId: string, channel: RichChannel, identity: string): Promise<RichConversationRef | null>;
  /** `duplicate: true` when the provider message id was already stored (provider retry). */
  insertInbound(row: InboundMessageRow): Promise<{ duplicate: boolean }>;
  /** Writes dnc_suppressions (when phone known) + stamps rich_conversations.opted_out_at. */
  recordOptOut(userId: string, conversationId: string, phone: string | null): Promise<void>;
  /** Removes only 'customer_opt_out' suppressions + clears opted_out_at. */
  recordOptIn(userId: string, conversationId: string, phone: string | null): Promise<void>;
  markClosedByCustomer(userId: string, conversationId: string): Promise<void>;
  putCapability(userId: string, channel: RichChannel, identity: string, status: "capable" | "not_capable" | "unknown", features?: unknown): Promise<void>;
  recordLanguage(userId: string, phone: string, text: string): Promise<void>;
  /** Sends the STOP/START/HELP acknowledgement on the same thread (sendRich with isConsentReply). */
  sendConsentReply(conversation: RichConversationRef, text: string): Promise<void>;
}

export type InboundOutcome = "stored" | "duplicate" | "unknown_account" | "opt_out" | "opt_in" | "help";

function brandOf(account: RichAccount): string {
  return account.brandName?.trim() || account.verifiedSenderName?.trim() || "Our team";
}

/** RCS identity arrives as digits (or +digits). Normalise to E.164 the same way the SMS path does. */
export function e164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function identityFor(channel: RichChannel, raw: string): string {
  return channel === "rcs" ? e164(raw) : raw;
}

export async function handleInbound(deps: InboundDeps, ev: InboundEvent): Promise<InboundOutcome> {
  const account = await deps.resolveAccount(ev.appId);
  if (!account) return "unknown_account";

  const identity = identityFor(ev.channel, ev.identity);
  const phone = ev.channel === "rcs" ? identity : null;
  const post = parsePostback(ev.postback);

  const kind: InboundMessageRow["kind"] = ev.postback ? "reply" : ev.mediaUrl && !ev.text ? "media" : "text";
  const body =
    ev.text?.trim() ||
    (post ? `Tapped: ${post.action}${post.ref ? ` (${post.ref})` : ""}` : ev.postback ? "Tapped a button" : ev.mediaUrl ? "(media attachment)" : "(empty message)");

  const conversation = await deps.upsertInboundConversation({
    userId: account.userId, channel: ev.channel, identity, phone, contactId: ev.contactId,
    providerConversationId: ev.providerConversationId, at: ev.receivedAt,
  });

  // Consent keywords are applied BEFORE the duplicate check: they are idempotent, and a provider
  // retry after a crash must still end with the customer suppressed.
  const keyword = ev.text ? classifyKeyword(ev.text) : null;
  if (keyword === "stop") await deps.recordOptOut(account.userId, conversation.id, phone ?? conversation.phone);
  if (keyword === "start") await deps.recordOptIn(account.userId, conversation.id, phone ?? conversation.phone);

  const { duplicate } = await deps.insertInbound({
    userId: account.userId,
    conversationId: conversation.id,
    kind,
    body,
    content: ev.postback || ev.mediaUrl ? { postback: ev.postback, mediaUrl: ev.mediaUrl } : null,
    providerMessageId: ev.providerMessageId,
    createdAt: ev.receivedAt,
  });
  if (duplicate) return "duplicate"; // provider retry: acknowledgements already sent once

  // Receiving from an RCS number proves it is RCS capable.
  if (ev.channel === "rcs") await deps.putCapability(account.userId, "rcs", identity, "capable");

  if (keyword === "stop") {
    await deps.sendConsentReply({ ...conversation, optedOutAt: ev.receivedAt }, optOutAckText(brandOf(account)));
    return "opt_out";
  }
  if (keyword === "start") {
    await deps.sendConsentReply({ ...conversation, optedOutAt: null }, optInAckText(brandOf(account)));
    return "opt_in";
  }
  if (keyword === "help") {
    await deps.sendConsentReply(conversation, helpText(brandOf(account)));
    return "help";
  }

  if (phone && ev.text) await deps.recordLanguage(account.userId, phone, ev.text);
  return "stored";
}

export async function handleProviderOptOut(deps: InboundDeps, ev: OptOutEvent): Promise<boolean> {
  const account = await deps.resolveAccount(ev.appId);
  if (!account) return false;
  const identity = identityFor(ev.channel, ev.identity);
  const conv = await deps.findConversation(account.userId, ev.channel, identity);
  if (!conv) return false;
  await deps.recordOptOut(account.userId, conv.id, conv.phone);
  return true;
}

export async function handleConversationDeleted(deps: InboundDeps, ev: ConversationDeletedEvent): Promise<boolean> {
  const account = await deps.resolveAccount(ev.appId);
  if (!account) return false;
  const conv = await deps.findConversation(account.userId, ev.channel, identityFor(ev.channel, ev.identity));
  if (!conv) return false;
  await deps.markClosedByCustomer(account.userId, conv.id);
  return true;
}

export async function handleCapability(deps: InboundDeps, ev: CapabilityEvent): Promise<boolean> {
  const account = await deps.resolveAccount(ev.appId);
  if (!account) return false;
  await deps.putCapability(account.userId, ev.channel, identityFor(ev.channel, ev.identity), ev.status, ev.features);
  return true;
}
