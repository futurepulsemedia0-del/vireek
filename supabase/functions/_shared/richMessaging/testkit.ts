// supabase/functions/_shared/richMessaging/testkit.ts
//
// In-memory implementation of every injected dependency, shared by the unit tests.
// Not imported by any edge function.

import type { InboundDeps } from "./inbound.ts";
import type { MessagePatch, NewOutbound, PatchCondition, RichSendDeps, SmsOutcome } from "./send.ts";
import type {
  CapabilityRecord, CapabilityStatus, ProviderSendRequest, ProviderSendResult, RichAccount, RichChannel,
  RichConversationRef, StoredMessage,
} from "./types.ts";
import { expiryFor } from "./capability.ts";

export const USER = "user-1";
export const APP = "app-1";
export const PHONE = "+15551230001";

export function account(over: Partial<RichAccount> = {}): RichAccount {
  return {
    userId: USER, provider: "sinch", providerAppId: APP, providerRegion: "us",
    rcsStatus: "approved", rcsAgentId: "agent-1", ambStatus: "approved", ambBusinessId: "mba-1",
    rcsEnabled: true, ambEnabled: true, brandName: "Acme HVAC", brandLogoUrl: null, brandColor: null,
    verifiedSenderName: null, fallbackToSms: true, fallbackAfterSeconds: 45, attemptOnUnknown: true, ...over,
  };
}

export interface Harness {
  deps: RichSendDeps & InboundDeps;
  clock: { now: Date };
  messages: Map<string, StoredMessage>;
  conversations: Map<string, RichConversationRef>;
  caps: Map<string, CapabilityRecord>;
  suppressed: Set<string>;
  smsSent: Array<{ to: string; body: string; opts: Record<string, unknown> }>;
  smsThread: Array<{ phone: string; body: string; sid: string }>;
  providerCalls: ProviderSendRequest[];
  probes: string[];
  inboundRows: Array<{ providerMessageId: string; body: string; kind: string }>;
  optOuts: string[];
  optIns: string[];
  closed: string[];
  consentReplies: string[];
  languages: string[];
  setAccount(a: RichAccount | null): void;
  setProvider(fn: (r: ProviderSendRequest) => ProviderSendResult): void;
  setSms(fn: (to: string, body: string) => SmsOutcome): void;
  setGate(fn: () => { proceed: true } | { proceed: false; sendAt: string }): void;
}

export function makeHarness(init: { account?: RichAccount | null } = {}): Harness {
  const clock = { now: new Date("2026-10-07T18:00:00Z") };
  let acct: RichAccount | null = init.account === undefined ? account() : init.account;
  let providerFn: (r: ProviderSendRequest) => ProviderSendResult = () => ({ ok: true, providerMessageId: `pm-${h.providerCalls.length - 1}` });
  let smsFn: (to: string, body: string) => SmsOutcome = () => ({ ok: true, sid: `SM${h.smsSent.length}` });
  let gateFn: () => { proceed: true } | { proceed: false; sendAt: string } = () => ({ proceed: true });
  let seq = 0;

  const h: Harness = {
    clock, messages: new Map(), conversations: new Map(), caps: new Map(), suppressed: new Set(),
    smsSent: [], smsThread: [], providerCalls: [], probes: [], inboundRows: [], optOuts: [], optIns: [], closed: [],
    consentReplies: [], languages: [],
    setAccount: (a) => { acct = a; },
    setProvider: (fn) => { providerFn = fn; },
    setSms: (fn) => { smsFn = fn; },
    setGate: (fn) => { gateFn = fn; },
    deps: undefined as unknown as Harness["deps"],
  };

  const convKey = (c: { channel: RichChannel; identity: string }) => `${c.channel}:${c.identity}`;
  const findConv = (channel: RichChannel, identity: string) =>
    [...h.conversations.values()].find((c) => convKey(c) === `${channel}:${identity}`) ?? null;
  const capKey = (channel: string, identity: string) => `${channel}:${identity}`;

  const deps: Harness["deps"] = {
    now: () => clock.now,
    async loadAccount() { return acct; },
    async resolveAccount(appId) { return acct && acct.providerAppId === appId ? acct : null; },

    async upsertConversation(p) {
      const found = findConv(p.channel, p.identity);
      if (found) return found;
      const c: RichConversationRef = { id: `conv-${++seq}`, userId: p.userId, channel: p.channel, identity: p.identity, phone: p.phone, name: p.name, optedOutAt: null, customerClosedAt: null };
      h.conversations.set(c.id, c);
      return c;
    },
    async upsertInboundConversation(p) {
      const found = findConv(p.channel, p.identity);
      if (found) { found.customerClosedAt = null; return found; }
      const c: RichConversationRef = { id: `conv-${++seq}`, userId: p.userId, channel: p.channel, identity: p.identity, phone: p.phone, name: null, optedOutAt: null, customerClosedAt: null };
      h.conversations.set(c.id, c);
      return c;
    },
    async getConversation(id) { return h.conversations.get(id) ?? null; },
    async findConversation(_u, channel, identity) { return findConv(channel, identity); },

    async getCapability(_u, channel, identity) { return h.caps.get(capKey(channel, identity)) ?? null; },
    async putCapability(_u, channel, identity, status: CapabilityStatus) {
      h.caps.set(capKey(channel, identity), { status, checkedAt: clock.now.toISOString(), expiresAt: expiryFor(status, clock.now) });
    },

    async isSuppressed(_u, phone) { return h.suppressed.has(phone); },
    async gateQuietHours() { return gateFn(); },

    provider: {
      async send(req) { h.providerCalls.push(req); return providerFn(req); },
      async queryCapability(_a, _c, identity) { h.probes.push(identity); return true; },
    },

    messages: {
      async insertOutbound(row: NewOutbound) {
        if (row.dedupeKey) {
          const dup = [...h.messages.values()].find((m) => m.conversationId === row.conversationId && m.dedupeKey === row.dedupeKey);
          if (dup) return { id: dup.id, duplicate: true };
        }
        const m: StoredMessage = {
          id: `msg-${++seq}`, userId: row.userId, conversationId: row.conversationId, direction: "outbound",
          status: row.status, fallbackState: row.fallbackState, fallbackDeadline: row.fallbackDeadline,
          fallbackText: row.fallbackText, fallbackPhone: row.fallbackPhone, purpose: row.purpose, customerId: row.customerId,
          providerMessageId: null, content: row.content, scheduledFor: row.scheduledFor, source: row.source,
          sentBy: row.sentBy, dedupeKey: row.dedupeKey, deliveredAt: null, readAt: null,
        };
        h.messages.set(m.id, m);
        return { id: m.id, duplicate: false };
      },
      async get(id) { return h.messages.get(id) ?? null; },
      async findForReceipt(correlationId, providerMessageId) {
        if (correlationId && h.messages.has(correlationId)) return h.messages.get(correlationId)!;
        return [...h.messages.values()].find((m) => m.providerMessageId === providerMessageId) ?? null;
      },
      async patch(id: string, p: MessagePatch, when?: PatchCondition) {
        const m = h.messages.get(id);
        if (!m) return false;
        if (when?.status && !when.status.includes(m.status)) return false;
        if (when?.fallbackState && !when.fallbackState.includes(m.fallbackState)) return false;
        if (p.status !== undefined) m.status = p.status;
        if (p.providerMessageId !== undefined) m.providerMessageId = p.providerMessageId;
        if (p.fallbackState !== undefined) m.fallbackState = p.fallbackState;
        if (p.scheduledFor !== undefined) m.scheduledFor = p.scheduledFor;
        if (p.deliveredAt !== undefined) m.deliveredAt = p.deliveredAt;
        if (p.readAt !== undefined) m.readAt = p.readAt;
        (m as StoredMessage & { failureReason?: string | null }).failureReason = p.failureReason ?? (m as { failureReason?: string | null }).failureReason;
        (m as StoredMessage & { fallbackSmsSid?: string | null }).fallbackSmsSid = p.fallbackSmsSid ?? (m as { fallbackSmsSid?: string | null }).fallbackSmsSid;
        return true;
      },
    },

    async sendSms(_u, to, body, opts) {
      h.smsSent.push({ to, body, opts });
      return smsFn(to, body);
    },
    async logSmsThread(_u, phone, body, sid) { h.smsThread.push({ phone, body, sid }); },

    async insertInbound(row) {
      if (h.inboundRows.some((r) => r.providerMessageId === row.providerMessageId)) return { duplicate: true };
      h.inboundRows.push({ providerMessageId: row.providerMessageId, body: row.body, kind: row.kind });
      return { duplicate: false };
    },
    async recordOptOut(_u, conversationId, phone) {
      if (phone) h.suppressed.add(phone);
      h.optOuts.push(conversationId);
      const c = h.conversations.get(conversationId);
      if (c) c.optedOutAt = clock.now.toISOString();
    },
    async recordOptIn(_u, conversationId, phone) {
      if (phone) h.suppressed.delete(phone);
      h.optIns.push(conversationId);
      const c = h.conversations.get(conversationId);
      if (c) c.optedOutAt = null;
    },
    async markClosedByCustomer(_u, conversationId) {
      h.closed.push(conversationId);
      const c = h.conversations.get(conversationId);
      if (c) c.customerClosedAt = clock.now.toISOString();
    },
    async recordLanguage(_u, _phone, text) { h.languages.push(text); },
    async sendConsentReply(_c, text) { h.consentReplies.push(text); },
  };
  h.deps = deps;
  return h;
}
