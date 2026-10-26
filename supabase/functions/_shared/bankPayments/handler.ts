// Pay by Bank — Stripe event handler. Pure orchestration over an injected Supabase admin client and injected I/O,
// so it is unit-tested with fakes (no Deno / network). Runtime wiring lives in runtime.ts.
//
// Contract: NEVER throws for "not ours" events; DOES throw on database errors so the webhook returns 5xx and Stripe retries
// (every RPC below is idempotent, keyed by the Stripe event id).
import { classifyBankFailure, classifyBankReturn, estimateSettlementDate } from "./logic.ts";

export interface BankContact { name?: string | null; email?: string | null; phone?: string | null; link_kind?: "pay" | "installment"; link_id?: string }

export interface BankEventDeps {
  fetchPaymentMethod(id: string): Promise<any>;
  activateMembership(admin: any, membershipId: string): Promise<void>;
  notifyCustomer(contact: { customer_phone?: string | null; customer_email?: string | null }, subject: string, text: string): Promise<void>;
  buildLink(kind: "pay" | "installment", id: string): string;
  log(event: string, data: Record<string, unknown>): void;
}

export interface BankEventResult { handled: boolean; result?: string; status?: string }

type Target = "processing" | "verification_required" | "succeeded" | "failed" | "canceled";

export function mapIntentEvent(type: string, pi: any): Target | null {
  switch (type) {
    case "payment_intent.processing": return "processing";
    case "payment_intent.requires_action": return pi?.next_action?.type === "verify_with_microdeposits" ? "verification_required" : null;
    case "payment_intent.succeeded": return "succeeded";
    case "payment_intent.payment_failed": return "failed";
    case "payment_intent.canceled": return "canceled";
    default: return null;
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const idOf = (v: any): string | null => (typeof v === "string" ? v : typeof v?.id === "string" ? v.id : null);

export async function processBankIntentEvent(admin: any, event: any, deps: BankEventDeps): Promise<BankEventResult> {
  const pi = event?.data?.object;
  if (!pi || typeof event?.type !== "string" || !event.type.startsWith("payment_intent.")) return { handled: false };
  const meta = pi.metadata ?? {};
  if (!meta.payment_request_id && !meta.installment_id) return { handled: false };
  // Cheap pre-filter: accounts without ACH enabled never list us_bank_account, so card payments cost no extra API call.
  if (!Array.isArray(pi.payment_method_types) || !pi.payment_method_types.includes("us_bank_account")) return { handled: false };

  const target = mapIntentEvent(event.type, pi);
  const pmRef = pi.payment_method ?? pi.last_payment_error?.payment_method ?? null;
  const pmId = idOf(pmRef);
  if (!pmId) return { handled: false };
  const pm = typeof pmRef === "object" && pmRef?.type ? pmRef : await deps.fetchPaymentMethod(pmId);
  if (pm?.type !== "us_bank_account") return { handled: false };
  if (!target) return { handled: true, result: "ignored" };

  const amount = Number(pi.amount);
  if (!Number.isInteger(amount) || amount <= 0) return { handled: true, result: "invalid_amount" };
  const failureCode: string | null = pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? null;
  const failure = classifyBankFailure(failureCode);
  const bank = pm.us_bank_account ?? {};
  const created = Number.isFinite(event.created) ? Number(event.created) : Math.floor(Date.now() / 1000);
  const verification = target === "verification_required" ? "microdeposits" : bank.financial_connections_account ? "instant" : undefined;

  const payload: Record<string, unknown> = {
    provider_payment_id: pi.id,
    status: target,
    provider_event_id: event.id ?? null,
    event_created: created,
    event_type: event.type,
    rail: "ach_debit",
    amount_cents: amount,
    tip_cents: Number.parseInt(meta.tip_cents ?? "0", 10) || 0,
    payment_request_id: meta.payment_request_id || null,
    installment_id: meta.installment_id || null,
    membership_id: meta.membership_id || null,
    membership_signup: meta.membership_signup === "true" ? "true" : null,
    payment_method_id: pmId,
    verification_method: verification ?? null,
    bank_name: bank.bank_name ?? null,
    account_last4: bank.last4 ?? null,
    expected_settlement_date: target === "processing" ? estimateSettlementDate(new Date(created * 1000), "ach_debit") : null,
    failure_code: target === "failed" ? failureCode : null,
    failure_message: target === "failed" ? (pi.last_payment_error?.message ?? failure.customerMessage) : null,
    retryable: target === "failed" ? failure.retryable : null,
  };

  const { data, error } = await admin.rpc("bank_attempt_apply", { p: payload });
  if (error) throw error;
  const applied = data?.result === "applied";
  deps.log("bank_payment_event", { type: event.type, pi: pi.id, result: data?.result, status: data?.status });
  if (!applied) return { handled: true, result: data?.result ?? "unknown", status: data?.status };

  if (target === "succeeded" && data.attempt_id) {
    const { error: e } = await admin.rpc("bank_attempt_post_accounting", { p_attempt_id: data.attempt_id });
    if (e) deps.log("bank_accounting_failed", { attempt: data.attempt_id, error: e.message }); // the reconcile cron retries
  }

  if (data.provisional_allowed && meta.membership_id) {
    try {
      await deps.activateMembership(admin, meta.membership_id);
      await admin.rpc("bank_attempt_mark_provisional", { p_attempt_id: data.attempt_id });
    } catch (e) {
      deps.log("bank_provisional_access_failed", { attempt: data.attempt_id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (target === "failed" && failure.invalidatesMethod) {
    const { error: e } = await admin.rpc("bank_method_set_status", { p_pm: pmId, p_status: "blocked", p_reason: failureCode });
    if (e) deps.log("bank_method_status_failed", { pm: pmId, error: e.message });
  }

  // Customer messages: best effort, only on the first (applied) delivery of the event.
  const contact = data.contact as BankContact | null;
  if (contact?.link_id && (contact.email || contact.phone)) {
    try {
      const link = deps.buildLink(contact.link_kind === "installment" ? "installment" : "pay", contact.link_id);
      const who = contact.name ? `Hi ${contact.name}, ` : "";
      if (target === "failed") {
        await deps.notifyCustomer(
          { customer_email: contact.email, customer_phone: contact.phone },
          `Your ${dollars(amount)} bank payment didn’t go through`,
          `${who}your ${dollars(amount)} bank payment didn’t go through: ${failure.customerMessage} You can pay again here: ${link}`,
        );
      } else if (target === "verification_required") {
        const url = pi.next_action?.verify_with_microdeposits?.hosted_verification_url;
        await deps.notifyCustomer(
          { customer_email: contact.email, customer_phone: contact.phone },
          "Verify your bank account to finish paying",
          `${who}to finish your ${dollars(amount)} payment, verify your bank account${url ? ` here: ${url}` : ` using the small deposits your bank will show in 1–2 business days (continue at ${link})`}`,
        );
      }
    } catch (e) {
      deps.log("bank_customer_notice_failed", { pi: pi.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { handled: true, result: "applied", status: target };
}

/** charge.dispute.* for a bank debit: a bank return or a customer dispute after the debit showed as succeeded. */
export async function processBankDisputeEvent(admin: any, event: any, deps: Pick<BankEventDeps, "log">): Promise<BankEventResult> {
  if (event?.type !== "charge.dispute.created" && event?.type !== "charge.dispute.funds_withdrawn") return { handled: false };
  const d = event.data?.object;
  const pid = idOf(d?.payment_intent);
  if (!pid) return { handled: false };
  // "warning_*" = a proof-of-authorization enquiry: no money has moved back yet (answer it in the Disputes centre).
  if (typeof d.status === "string" && d.status.startsWith("warning_")) return { handled: true, result: "enquiry" };
  const info = classifyBankReturn(d.reason);
  const { data, error } = await admin.rpc("bank_attempt_apply", {
    p: {
      provider_payment_id: pid,
      status: info.status,
      return_code: d.reason ?? null,
      provider_event_id: event.id ? `${event.id}:bank` : null,
      event_created: Number.isFinite(event.created) ? Number(event.created) : null,
      event_type: event.type,
    },
  });
  if (error) throw error;
  if (data?.result === "applied") {
    const { error: e } = await admin.rpc("bank_attempt_post_accounting", { p_attempt_id: data.attempt_id });
    if (e) deps.log("bank_reversal_failed", { attempt: data.attempt_id, error: e.message });
    deps.log("bank_payment_returned", { pi: pid, reason: d.reason, status: info.status });
  }
  return { handled: true, result: data?.result ?? "unknown", status: info.status };
}

/** payment_method.automatically_updated: Stripe blocks (or unblocks) a bank account after Nacha-relevant returns. */
export async function processBankMethodEvent(admin: any, event: any, deps: Pick<BankEventDeps, "log">): Promise<BankEventResult> {
  if (event?.type !== "payment_method.automatically_updated") return { handled: false };
  const pm = event.data?.object;
  if (pm?.type !== "us_bank_account" || !pm.id) return { handled: false };
  const blocked = pm.us_bank_account?.status_details?.blocked;
  const reason = blocked ? String(blocked.reason ?? blocked.network_code ?? "blocked") : null;
  const { data, error } = await admin.rpc("bank_method_set_status", { p_pm: pm.id, p_status: blocked ? "blocked" : "active", p_reason: reason });
  if (error) throw error;
  deps.log("bank_method_updated", { pm: pm.id, blocked: !!blocked, changed: data });
  return { handled: true, result: blocked ? "blocked" : "unblocked" };
}
