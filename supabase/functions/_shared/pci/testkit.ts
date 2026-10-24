// supabase/functions/_shared/pci/testkit.ts
// In-memory ports for the pay-by-phone orchestrator. Test-only (never imported by an edge function).
import type { AuditEventInput } from "./session.ts";
import { ChargeError, type ChargeResult, type PciPorts, type PhonePaymentRow, type SessionPatch } from "./orchestrator.ts";

export interface Recorder {
  /** Every payload written to any table, serialized — the "database" the tests scan for card data. */
  dbWrites: string[];
  logs: string[];
  /** Everything sent to Twilio/Stripe, serialized. */
  outbound: string[];
  order: string[];
  sessions: Map<string, PhonePaymentRow>;
  audit: Array<{ sessionId: string; event: AuditEventInput }>;
  paymentRequests: Map<string, { status: string; amount: number }>;
  charges: number;
  finalized: number;
}

export interface FakeOptions {
  balanceCents?: number;
  connect?: string | null;
  callSid?: string | null;
  pauseFails?: boolean;
  redirectFails?: boolean;
  chargeError?: ChargeError["code"] | null;
  chargeStatus?: string;
  now?: () => Date;
  motoEnabled?: boolean;
}

export const CALL_SID = "CA" + "a".repeat(32);
export const USER = "00000000-0000-0000-0000-0000000000a1";
export const JOB = "00000000-0000-0000-0000-0000000000e1";

export function makeFakePorts(opts: FakeOptions = {}): { ports: PciPorts; rec: Recorder } {
  const rec: Recorder = { dbWrites: [], logs: [], outbound: [], order: [], sessions: new Map(), audit: [], paymentRequests: new Map(), charges: 0, finalized: 0 };
  let seq = 0;
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const w = (label: string, payload: unknown) => rec.dbWrites.push(`${label} ${JSON.stringify(payload)}`);
  let balance = opts.balanceCents ?? 12_500;

  const ports: PciPorts = {
    db: {
      async getJob() { return { id: JOB, customer_name: "Pat Customer", customer_phone: "+15551230000" }; },
      async getBalanceCents() { return balance; },
      async getConnectDestination() { return opts.connect === undefined ? "acct_test123" : opts.connect; },
      async expireStale() { rec.order.push("db.expireStale"); },
      async findActiveSession(_u, callId) {
        for (const s of rec.sessions.values()) if (s.vapi_call_id === callId && !["succeeded", "failed", "cancelled", "expired"].includes(s.status)) return s;
        return null;
      },
      async createPaymentRequest(row) { const rid = id(); w("payment_requests.insert", row); rec.paymentRequests.set(rid, { status: "pending", amount: row.amount }); return { id: rid }; },
      async setPaymentRequestStatus(rid, status) { w("payment_requests.update", { rid, status }); const r = rec.paymentRequests.get(rid); if (r) r.status = status; },
      async insertSession(row) {
        for (const s of rec.sessions.values()) if (s.vapi_call_id === row.vapi_call_id && !["succeeded", "failed", "cancelled", "expired"].includes(s.status) && row.provider_call_sid !== "unsupported") {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        const s = { id: id(), ...row } as PhonePaymentRow; w("sessions.insert", s); rec.sessions.set(s.id, s); return { ...s };
      },
      async getSession(sid) { const s = rec.sessions.get(sid); return s ? { ...s } : null; },
      async transition(sid, from, patch: SessionPatch) {
        const s = rec.sessions.get(sid);
        if (!s || !from.includes(s.status)) return null;
        const next = { ...s, ...patch } as PhonePaymentRow;
        // mirror of the DB CHECK: capture states require a verified recording pause
        if (["capturing", "tokenized", "charging", "succeeded"].includes(next.status) && !next.recording_paused_at) throw new Error("check violation: recording_paused_at required");
        w("sessions.update", patch); rec.order.push(`session:${next.status}`); rec.sessions.set(sid, next); return { ...next };
      },
      async appendAudit(sid, _u, event) { w("audit.insert", event); rec.audit.push({ sessionId: sid, event }); },
      async markRecordingResumed(sid, at) { w("sessions.resumed", { sid, at }); const s = rec.sessions.get(sid); if (s) s.recording_resumed_at = at; },
    },
    twilio: {
      async pauseRecordings(sid) { rec.order.push("twilio.pause"); rec.outbound.push(`pause ${sid}`); if (opts.pauseFails) throw new Error("twilio 500"); return { paused: 1 }; },
      async resumeRecordings(sid) { rec.order.push("twilio.resume"); rec.outbound.push(`resume ${sid}`); return { resumed: 1 }; },
      async redirect(sid, twiml) { rec.order.push("twilio.redirect"); rec.outbound.push(`redirect ${sid} ${twiml}`); if (opts.redirectFails) throw new Error("twilio 500"); },
    },
    stripe: {
      async charge(a): Promise<ChargeResult> {
        rec.order.push("stripe.charge"); rec.charges++;
        rec.outbound.push(`stripe ${JSON.stringify(a)}`);
        if (opts.chargeError) throw new ChargeError(opts.chargeError);
        const pi = { id: "pi_test_1", status: opts.chargeStatus ?? "succeeded", amount: a.amountCents, currency: "usd", metadata: a.metadata };
        return { id: pi.id, status: pi.status, amount: pi.amount, currency: "usd", brand: "visa", last4: "1111", paymentIntent: pi };
      },
    },
    async finalizeRequestFromIntent() { rec.finalized++; return { handled: true, status: "paid" }; },
    async resolveCallLeg() { return opts.callSid === undefined ? CALL_SID : opts.callSid; },
    urls: { async action(sid) { return `https://x.test/phone-payment-webhook?sid=${sid}&step=action&t=tok`; }, async status(sid) { return `https://x.test/phone-payment-webhook?sid=${sid}&step=status&t=tok`; } },
    config: { payConnector: "Vireek_Stripe", tokenType: "one-time", motoEnabled: opts.motoEnabled ?? true },
    log(event, data) { rec.logs.push(JSON.stringify({ event, ...data })); },
    now: opts.now ?? (() => new Date("2027-11-02T12:00:00Z")),
  };
  void balance;
  return { ports, rec };
}
