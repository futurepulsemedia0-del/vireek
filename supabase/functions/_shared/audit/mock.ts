// supabase/functions/_shared/audit/mock.ts
// Mock telephony / mail / bot providers: deterministic, no network, no money. Used by tests and the Playwright flow.
// The service accepts ONLY these when AUDIT_TELEPHONY=mock, which the Edge Function refuses in production (see audit-api).

import type { RawCallReport } from "./outcome.ts";
import type { BotCheck, CallProvider, LineLookup, Mailer, OtpProvider, PlaceResult } from "./ports.ts";
import type { Condition } from "./types.ts";

export class MockOtp implements OtpProvider {
  codes = new Map<string, string>();
  sent: { to: string; channel: "sms" | "voice" }[] = [];
  fail = false;
  async start(to: string, channel: "sms" | "voice") {
    if (this.fail) throw new Error("provider down");
    this.sent.push({ to, channel });
    this.codes.set(to, "123456");
    return { ref: `mock-${this.sent.length}` };
  }
  async check(to: string, code: string) { return this.codes.get(to) === code; }
  lastCode(to: string) { return this.codes.get(to) ?? null; }
}

export type MockBehaviour = (condition: Condition) => Partial<RawCallReport> & { _place?: PlaceResult };

/** The scripted "business" on the other end of the mock phone line. */
export const GOOD_BUSINESS: MockBehaviour = () => ({
  endedReason: "assistant-ended-call", durationSeconds: 40, structured: { answered_by: "human", offered_to_book_or_take_details: true },
});
export const LEAKY_BUSINESS: MockBehaviour = (c) =>
  c === "business_hours"
    ? { endedReason: "assistant-ended-call", durationSeconds: 35, structured: { answered_by: "human", offered_to_book_or_take_details: false, could_take_message_only: true } }
    : c === "lunch"
      ? { endedReason: "voicemail", durationSeconds: 20, structured: { answered_by: "voicemail", greeting_present: true, business_name_stated: true, callback_promised: false, greeting_seconds: 12 } }
      : { endedReason: "customer-did-not-answer", durationSeconds: 0, structured: { answered_by: "none" } };

export class MockCalls implements CallProvider {
  placed: { auditCallId: string; toE164: string; businessName: string; providerCallId: string }[] = [];
  behaviour: MockBehaviour = GOOD_BUSINESS;
  conditionOf = new Map<string, Condition>();
  placeResult: PlaceResult | "throw" | null = null;
  async place(i: { auditCallId: string; toE164: string; businessName: string }): Promise<PlaceResult> {
    if (this.placeResult === "throw") throw new Error("timeout");
    if (this.placeResult) return this.placeResult;
    const providerCallId = `mock-call-${this.placed.length + 1}`;
    this.placed.push({ ...i, providerCallId });
    return { ok: true, providerCallId };
  }
  async fetchReport(providerCallId: string) { return this.reportFor(providerCallId); }
  reportFor(providerCallId: string, condition?: Condition): RawCallReport {
    const c = condition ?? this.conditionOf.get(providerCallId) ?? "business_hours";
    const { _place: _ignored, ...r } = this.behaviour(c);
    return { ringingAt: "2026-11-03T16:00:00.000Z", answeredAt: r.endedReason === "customer-did-not-answer" ? null : "2026-11-03T16:00:08.000Z", endedAt: "2026-11-03T16:00:48.000Z", costUsd: 0.12, ...r };
  }
}

export class MockMailer implements Mailer {
  outbox: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }[] = [];
  fail = false;
  async send(m: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) {
    if (this.fail) throw new Error("smtp down");
    this.outbox.push(m);
    return { id: `mail-${this.outbox.length}` };
  }
}

export class MockBot implements BotCheck {
  async verify(token: string) { return token === "human-ok-token"; }
}
export class MockLookup implements LineLookup {
  types = new Map<string, string>();
  async lookup(e164: string) { return { type: this.types.get(e164) ?? "mobile" }; }
}
