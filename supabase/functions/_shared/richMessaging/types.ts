// supabase/functions/_shared/richMessaging/types.ts
//
// Provider-neutral types for RCS Business Messaging + Apple Messages for Business.
// Pure module (no Deno / npm imports) so everything built on it is unit-testable.

import type { Purpose } from "../messaging/quietHoursCore.ts";

export type { Purpose };

export type RichChannel = "rcs" | "amb";
export type ProviderStatus = "not_started" | "requested" | "in_review" | "approved" | "rejected" | "suspended";
export type CapabilityStatus = "capable" | "not_capable" | "unknown";
export type RichStatus =
  | "queued" | "deferred" | "sent" | "delivered" | "read" | "failed" | "fallback_sent" | "cancelled" | "received";
export type FallbackState = "none" | "armed" | "sending" | "sent" | "cancelled" | "failed";

export interface RichAccount {
  userId: string;
  provider: "sinch";
  providerAppId: string | null;
  providerRegion: "us" | "eu" | "br";
  rcsStatus: ProviderStatus;
  rcsAgentId: string | null;
  ambStatus: ProviderStatus;
  ambBusinessId: string | null;
  rcsEnabled: boolean;
  ambEnabled: boolean;
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
  verifiedSenderName: string | null;
  fallbackToSms: boolean;
  fallbackAfterSeconds: number;
  attemptOnUnknown: boolean;
}

/** A button on a card. `value` = postback id (reply), https URL (url) or E.164 phone (call). */
export interface RichAction {
  type: "reply" | "url" | "call";
  label: string;
  value: string;
  /** SMS keyword the customer can text instead of tapping (reply actions, used in the SMS fallback). */
  keyword?: string;
}

export interface RichCard {
  title: string;
  description?: string;
  imageUrl?: string;
  actions: RichAction[];
}

export type RichContent =
  | { kind: "text"; text: string }
  | { kind: "card"; card: RichCard; fallbackText: string };

export interface CapabilityRecord {
  status: CapabilityStatus;
  checkedAt: string;
  expiresAt: string;
}

export interface RichConversationRef {
  id: string;
  userId: string;
  channel: RichChannel;
  identity: string;
  phone: string | null;
  name: string | null;
  optedOutAt: string | null;
  customerClosedAt: string | null;
}

export interface StoredMessage {
  id: string;
  userId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  status: RichStatus;
  fallbackState: FallbackState;
  fallbackDeadline: string | null;
  fallbackText: string | null;
  fallbackPhone: string | null;
  purpose: Purpose;
  customerId: string | null;
  providerMessageId: string | null;
  content: RichContent | null;
  scheduledFor: string | null;
  source: string | null;
  sentBy: "human" | "system" | "ai" | "ai_approved";
  dedupeKey: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

// ---- Normalised provider events -------------------------------------------------

export interface InboundEvent {
  type: "inbound";
  appId: string;
  channel: RichChannel;
  identity: string;
  providerMessageId: string;
  providerConversationId: string | null;
  contactId: string | null;
  text: string | null;
  postback: string | null;
  mediaUrl: string | null;
  receivedAt: string;
}

export interface DeliveryEvent {
  type: "delivery";
  appId: string;
  providerMessageId: string;
  correlationId: string | null;
  status: "delivered" | "read" | "failed" | "pending";
  reasonCode: string | null;
  reasonText: string | null;
  channel: RichChannel | null;
  identity: string | null;
}

export interface CapabilityEvent {
  type: "capability";
  appId: string;
  channel: RichChannel;
  identity: string;
  status: CapabilityStatus;
  features: unknown;
}

export interface OptOutEvent {
  type: "opt_out";
  appId: string;
  channel: RichChannel;
  identity: string;
}

export interface ConversationDeletedEvent {
  type: "conversation_deleted";
  appId: string;
  channel: RichChannel;
  identity: string;
}

export type RichEvent = InboundEvent | DeliveryEvent | CapabilityEvent | OptOutEvent | ConversationDeletedEvent;

// ---- Provider contract ------------------------------------------------------------

export type ProviderSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; code?: string; retryable: boolean };

export interface ProviderSendRequest {
  account: RichAccount;
  channel: RichChannel;
  identity: string;
  content: RichContent;
  correlationId: string;
  ttlSeconds?: number;
}

export interface RichProvider {
  send(req: ProviderSendRequest): Promise<ProviderSendResult>;
  queryCapability(account: RichAccount, channel: RichChannel, identity: string): Promise<boolean>;
}
