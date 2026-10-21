// Maintenance-agreement renewal pipeline. Called once per daily run of membership-lifecycle-agent.
//
//   A. Close memberships that were set NOT to renew once their paid period ends (-> win-back).
//   B. Open one renewal cycle per membership as the renewal enters its 60-day (yearly) / 7-day (monthly) window.
//   C. Advance each open cycle (60 -> 30 -> 7 -> due), re-check card-on-file readiness, send the renewal
//      quote / reminders. Notices are transactional (legally required pre-renewal notice), like the agent's invoice SMS.
//   D. Charge the card on file for renewals that are due (retry +3 and +7 days), roll the period on success,
//      flag past_due on failure, fall back to the SCA pay link when the bank wants the customer present.
//
// Money rides on payment_requests + the existing finalize_paid_payment_request RPC, so the ledger, receipts and
// dunning behave exactly like every other payment. Nothing here imports Deno or Stripe: both are injected, which
// keeps the whole pipeline unit-testable.

import {
  addInterval,
  authRequiredMessage,
  cardLabel,
  cardUsable,
  chargeDecision,
  chargeFailedMessage,
  cycleLeadDays,
  daysUntil,
  DAY_MS,
  escapeHtml,
  GRACE_PERIOD_DAYS,
  MAX_CHARGE_ATTEMPTS,
  noticeToSend,
  paymentRoute,
  renewalChargeIdempotencyKey,
  renewalNoticeMessage,
  renewalPricing,
  renewalReceiptMessage,
  renewalUrl,
  stageForDaysLeft,
  winBackEventData,
  type BillingInterval,
} from "./logic.ts";
import { finalizePaymentRequestFromIntent } from "../payments/finalizeIntent.ts";
import { buildIntentMetadata } from "../payments/paymentIntent.ts";

export type ChargeResult =
  | { outcome: "succeeded"; intent: any }
  | { outcome: "requires_action" }
  | { outcome: "declined"; message: string }
  /** Transient (network / 5xx / still processing): leave the attempt count alone, same idempotency key next run. */
  | { outcome: "retry" };

export interface ChargeInput {
  amountCents: number;
  customerId: string;
  paymentMethodId: string;
  destinationAccountId: string;
  description: string;
  receiptEmail: string | null;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface PipelineDeps {
  now: Date;
  siteUrl: string;
  sendSms: (phone: string, text: string) => Promise<unknown>;
  sendEmail: (to: string, subject: string, html: string, text: string) => Promise<unknown>;
  enroll: (args: {
    aggregateId: string;
    eventType: string;
    userId: string;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    extra?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Omit to run everything except card charges (e.g. STRIPE_SECRET_KEY not configured). */
  charge?: (input: ChargeInput) => Promise<ChargeResult>;
  finalize?: (admin: any, intent: any) => Promise<{ handled: boolean; status?: string }>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface RenewalCounts {
  closed_non_renewing: number;
  cycles_opened: number;
  notices_sent: number;
  charged: number;
  charge_declined: number;
  charge_requires_action: number;
  errors: number;
}

const ROW_CAP = 500;
const NON_RENEWING_LOOKBACK_DAYS = 30;

const MEMBER_COLS =
  "status, auto_renew, customer_name, customer_phone, customer_email, current_period_start, current_period_end, last_payment_request_id, dunning_stage, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, auto_renew_consent_at";
const PLAN_COLS = "name, price_cents, renewal_price_cents, billing_interval, visits_included_per_period, public_slug";
const CYCLE_COLS = `id, user_id, membership_id, period_end, stage, amount_cents, previous_amount_cents, payment_route, quote_token, quote_status, notices_sent, charge_attempts, last_charge_attempt_at, payment_request_id, memberships:membership_id(${MEMBER_COLS}), membership_plans:plan_id(${PLAN_COLS})`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sameInstant = (a: string | Date, b: string | Date) => new Date(a).getTime() === new Date(b).getTime();

function autolink(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

/** Best-effort customer message: SMS + email, each isolated so one failing channel never blocks the other. */
async function notify(deps: PipelineDeps, to: { phone?: string | null; email?: string | null }, subject: string, text: string): Promise<boolean> {
  let attempted = false;
  if (to.phone) {
    attempted = true;
    try { await deps.sendSms(to.phone, text); } catch (e) { deps.log?.("membership_renewal_sms_failed", { error: errMsg(e) }); }
  }
  if (to.email) {
    attempted = true;
    const html = `<p style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5">${autolink(escapeHtml(text))}</p>`;
    try { await deps.sendEmail(to.email, subject, html, text); } catch (e) { deps.log?.("membership_renewal_email_failed", { error: errMsg(e) }); }
  }
  return attempted;
}

/**
 * Rolls a paid membership into its next period. Guarded on the period end we read, so the agent's own
 * "roll after paid invoice" step and this one can never both advance the same period.
 */
export async function rollMembershipPeriod(
  admin: any,
  membershipId: string,
  currentPeriodEnd: string,
  plan: { billing_interval: BillingInterval; visits_included_per_period?: number | null },
  requestId: string | null,
): Promise<{ rolled: boolean; nextEnd: Date }> {
  const start = new Date(currentPeriodEnd);
  const nextEnd = addInterval(start, plan.billing_interval);
  const { data } = await admin
    .from("memberships")
    .update({
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: nextEnd.toISOString(),
      visits_included_current_period: plan.visits_included_per_period ?? 0,
      visits_used_current_period: 0,
      dunning_stage: 0,
      payment_failed_at: null,
      payment_grace_period_ends_at: null,
      ...(requestId ? { last_payment_request_id: requestId } : {}),
    })
    .eq("id", membershipId)
    .eq("current_period_end", currentPeriodEnd)
    .in("status", ["active", "past_due"])
    .select("id");
  return { rolled: Array.isArray(data) && data.length > 0, nextEnd };
}

// -----------------------------------------------------------------
// A. Non-renewing memberships reach the end of the paid period
// -----------------------------------------------------------------
async function closeNonRenewing(admin: any, deps: PipelineDeps, counts: RenewalCounts) {
  const { now } = deps;
  const { data: rows } = await admin
    .from("memberships")
    .select("id, user_id, plan_id, lead_id, customer_name, customer_phone, customer_email, current_period_end, membership_plans:plan_id(name, price_cents, public_slug)")
    .eq("status", "active")
    .eq("auto_renew", false)
    .lte("current_period_end", now.toISOString())
    // Rows that expired long ago are legacy data, not a fresh decision: never win-back-text those.
    .gte("current_period_end", new Date(now.getTime() - NON_RENEWING_LOOKBACK_DAYS * DAY_MS).toISOString())
    .limit(ROW_CAP);

  for (const m of rows ?? []) {
    try {
      const { data: closed } = await admin
        .from("memberships")
        .update({ status: "cancelled", cancelled_at: now.toISOString() })
        .eq("id", m.id)
        .eq("status", "active")
        .select("id");
      if (!closed || closed.length === 0) continue; // someone else closed it first

      const plan = m.membership_plans as { name: string; price_cents: number; public_slug: string | null } | null;
      await admin.from("revenue_recovery_events").upsert(
        {
          user_id: m.user_id, source_type: "membership_cancelled", source_table: "memberships", source_id: m.id,
          lead_id: m.lead_id, customer_name: m.customer_name, customer_phone: m.customer_phone,
          estimated_value_cents: plan?.price_cents ?? 0, estimated_value_basis: plan?.price_cents ? "membership_plan" : "none",
        },
        { onConflict: "source_table,source_id", ignoreDuplicates: true },
      );
      // Same event the existing win-back playbook listens to: churned and cancelled-at-term members get one sequence.
      await deps.enroll({
        aggregateId: m.id, eventType: "membership.churned", userId: m.user_id,
        customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: m.customer_email,
        extra: { reason: "did_not_renew", ...winBackEventData(plan, deps.siteUrl) },
      });
      counts.closed_non_renewing++;
    } catch (e) {
      counts.errors++;
      deps.log?.("membership_renewal_error", { step: "close_non_renewing", id: m.id, error: errMsg(e) });
    }
  }
}

// -----------------------------------------------------------------
// B. Open a renewal cycle as the renewal enters its notice window
// -----------------------------------------------------------------
async function openCycles(admin: any, deps: PipelineDeps, counts: RenewalCounts) {
  const { now } = deps;
  const horizon = new Date(now.getTime() + cycleLeadDays("yearly") * DAY_MS);
  // period_end must still be in the future: an already-overdue legacy membership never gets a surprise charge.
  const { data: members } = await admin
    .from("memberships")
    .select(`id, user_id, plan_id, ${MEMBER_COLS}, membership_plans:plan_id(${PLAN_COLS})`)
    .eq("status", "active")
    .gt("current_period_end", now.toISOString())
    .lte("current_period_end", horizon.toISOString())
    .limit(ROW_CAP);
  if (!members?.length) return;

  const { data: existing } = await admin.from("membership_renewal_cycles").select("membership_id, period_end").in("membership_id", members.map((m: any) => m.id));
  const have = new Set((existing ?? []).map((c: any) => `${c.membership_id}|${new Date(c.period_end).getTime()}`));

  const rows: Record<string, unknown>[] = [];
  for (const m of members) {
    const plan = m.membership_plans as { price_cents: number; renewal_price_cents: number | null; billing_interval: BillingInterval } | null;
    if (!plan || !m.current_period_end) continue;
    const end = new Date(m.current_period_end);
    if (daysUntil(end, now) > cycleLeadDays(plan.billing_interval)) continue;
    if (have.has(`${m.id}|${end.getTime()}`)) continue;
    const pricing = renewalPricing(plan);
    if (pricing.amountCents <= 0) continue; // free plan: nothing to renew
    rows.push({
      user_id: m.user_id,
      membership_id: m.id,
      plan_id: m.plan_id,
      period_end: end.toISOString(),
      stage: stageForDaysLeft(daysUntil(end, now), plan.billing_interval),
      amount_cents: pricing.amountCents,
      previous_amount_cents: pricing.previousCents,
      payment_route: paymentRoute(m, end),
      quote_status: m.auto_renew ? "sent" : "declined",
    });
  }
  if (!rows.length) return;
  const { error } = await admin.from("membership_renewal_cycles").upsert(rows, { onConflict: "membership_id,period_end", ignoreDuplicates: true });
  if (error) throw error;
  counts.cycles_opened += rows.length;
}

// -----------------------------------------------------------------
// C. Advance open cycles and send the renewal quote / reminders
// -----------------------------------------------------------------
async function advanceCycles(admin: any, deps: PipelineDeps, counts: RenewalCounts) {
  const { now } = deps;
  const { data: cycles } = await admin.from("membership_renewal_cycles").select(CYCLE_COLS).is("outcome", null).limit(ROW_CAP);

  for (const c of cycles ?? []) {
    try {
      const m = c.memberships;
      const plan = c.membership_plans;
      if (!m || !plan || m.status !== "active") continue;
      const periodEnd = new Date(c.period_end);

      // The renewal date was edited after the cycle opened: this cycle no longer describes a real renewal.
      if (m.current_period_end && !sameInstant(m.current_period_end, periodEnd)) {
        await admin.from("membership_renewal_cycles").delete().eq("id", c.id).is("outcome", null);
        continue;
      }

      const interval = plan.billing_interval as BillingInterval;
      const daysLeft = daysUntil(periodEnd, now);
      const patch: Record<string, unknown> = {};
      const stage = stageForDaysLeft(daysLeft, interval);
      if (stage !== c.stage) patch.stage = stage;
      const route = paymentRoute(m, periodEnd);
      if (route !== c.payment_route) patch.payment_route = route;

      let toSend: ReturnType<typeof noticeToSend>["send"] = null;
      if (m.auto_renew) {
        const n = noticeToSend(daysLeft, interval, c.notices_sent ?? []);
        if (n.mark.length) patch.notices_sent = [...(c.notices_sent ?? []), ...n.mark];
        // Pay-link members get the agent's real invoice at T-7; a second "7 days" text would just be noise.
        if (n.send && !(n.send === "7" && route === "pay_link")) toSend = n.send;
      }

      if (Object.keys(patch).length) {
        await admin.from("membership_renewal_cycles").update({ ...patch, updated_at: now.toISOString() }).eq("id", c.id);
      }
      if (toSend) {
        const msg = renewalNoticeMessage(toSend, {
          customerName: m.customer_name, planName: plan.name,
          amountCents: c.amount_cents, previousCents: c.previous_amount_cents,
          periodEnd, route, cardLabel: cardLabel(m.card_brand, m.card_last4),
          url: renewalUrl(deps.siteUrl, c.quote_token),
        });
        if (await notify(deps, { phone: m.customer_phone, email: m.customer_email }, msg.subject, msg.text)) counts.notices_sent++;
      }
    } catch (e) {
      counts.errors++;
      deps.log?.("membership_renewal_error", { step: "advance", id: c.id, error: errMsg(e) });
    }
  }
}

// -----------------------------------------------------------------
// D. Charge the card on file for due renewals
// -----------------------------------------------------------------
async function ensurePaymentRequest(admin: any, deps: PipelineDeps, c: any, m: any): Promise<{ id: string; token: string; paid: boolean } | null> {
  if (c.payment_request_id) {
    const { data: existing } = await admin.from("payment_requests").select("id, status, public_token").eq("id", c.payment_request_id).maybeSingle();
    if (existing && existing.status !== "canceled") return { id: existing.id, token: existing.public_token, paid: existing.status === "paid" };
  }
  const { data: created, error } = await admin
    .from("payment_requests")
    .insert({ user_id: c.user_id, customer_name: m.customer_name, customer_email: m.customer_email ?? null, customer_phone: m.customer_phone ?? null, amount: c.amount_cents / 100, status: "pending" })
    .select("id, public_token")
    .single();
  if (error || !created) throw error ?? new Error("Could not create the renewal payment request.");
  await admin
    .from("payment_requests")
    .update({ status: "sent", payment_link_url: `${deps.siteUrl}/pay/${created.public_token}`, last_reminder_sent_at: deps.now.toISOString() })
    .eq("id", created.id);
  return { id: created.id, token: created.public_token, paid: false };
}

async function chargeDueCycles(admin: any, deps: PipelineDeps, counts: RenewalCounts) {
  if (!deps.charge) return;
  const { now } = deps;
  const finalize = deps.finalize ?? finalizePaymentRequestFromIntent;
  const { data: cycles } = await admin
    .from("membership_renewal_cycles")
    .select(CYCLE_COLS)
    .is("outcome", null)
    .lte("period_end", now.toISOString())
    .limit(ROW_CAP);
  const connectCache = new Map<string, { stripe_account_id: string | null; charges_enabled: boolean } | null>();

  for (const c of cycles ?? []) {
    try {
      const m = c.memberships;
      const plan = c.membership_plans;
      if (!m || !plan || !["active", "past_due"].includes(m.status)) continue;
      if (!m.current_period_end || !sameInstant(m.current_period_end, c.period_end)) continue;
      if (!cardUsable(m, now)) continue;
      const decision = chargeDecision({ now, periodEnd: c.period_end, attempts: c.charge_attempts ?? 0, lastAttemptAt: c.last_charge_attempt_at, quoteStatus: c.quote_status });
      if (decision !== "charge") continue;

      if (!connectCache.has(c.user_id)) {
        const { data } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", c.user_id).maybeSingle();
        connectCache.set(c.user_id, data ?? null);
      }
      const connect = connectCache.get(c.user_id);
      if (!connect?.stripe_account_id || !connect.charges_enabled) continue; // can't charge for a business without Stripe ready

      const request = await ensurePaymentRequest(admin, deps, c, m);
      if (!request) continue;
      const attempts: number = c.charge_attempts ?? 0;
      const interval = plan.billing_interval as BillingInterval;

      if (request.paid) {
        // Paid (e.g. through the pay link) but the period wasn't rolled yet: just roll.
        await rollMembershipPeriod(admin, c.membership_id, m.current_period_end, { billing_interval: interval, visits_included_per_period: plan.visits_included_per_period }, request.id);
        continue;
      }

      await admin.from("membership_renewal_cycles").update({ payment_request_id: request.id, updated_at: now.toISOString() }).eq("id", c.id);
      await admin.from("memberships").update({ last_payment_request_id: request.id }).eq("id", c.membership_id);

      const result = await deps.charge({
        amountCents: c.amount_cents,
        customerId: m.stripe_customer_id,
        paymentMethodId: m.stripe_payment_method_id,
        destinationAccountId: connect.stripe_account_id,
        description: `${plan.name} membership renewal`,
        receiptEmail: m.customer_email ?? null,
        metadata: {
          ...buildIntentMetadata({ requestId: request.id, userId: c.user_id, baseCents: c.amount_cents, tipCents: 0, membershipId: c.membership_id }),
          renewal_cycle_id: c.id,
          source: "membership_renewal",
        },
        idempotencyKey: renewalChargeIdempotencyKey(c.id, attempts),
      });

      const attemptPatch = { charge_attempts: attempts + 1, last_charge_attempt_at: now.toISOString(), updated_at: now.toISOString() };
      const payUrl = `${deps.siteUrl}/pay/${request.token}`;
      const to = { phone: m.customer_phone, email: m.customer_email };

      if (result.outcome === "retry") {
        deps.log?.("membership_renewal_charge_retry", { cycle: c.id });
        continue;
      }

      if (result.outcome === "succeeded") {
        const fin = await finalize(admin, result.intent);
        if (fin.status === "paid" || fin.status === "already_paid") {
          const { nextEnd } = await rollMembershipPeriod(admin, c.membership_id, m.current_period_end, { billing_interval: interval, visits_included_per_period: plan.visits_included_per_period }, request.id);
          await admin.from("membership_renewal_cycles").update({ ...attemptPatch, last_charge_error: null }).eq("id", c.id);
          const msg = renewalReceiptMessage({ customerName: m.customer_name, planName: plan.name, amountCents: c.amount_cents, nextEnd });
          await notify(deps, to, msg.subject, msg.text);
          counts.charged++;
        } else {
          // Money moved but the ledger disagrees: surface for a human, never roll silently.
          await admin.from("membership_renewal_cycles").update({ ...attemptPatch, charge_attempts: MAX_CHARGE_ATTEMPTS, last_charge_error: `ledger_${fin.status ?? "unhandled"}` }).eq("id", c.id);
          deps.log?.("membership_renewal_ledger_mismatch", { cycle: c.id, status: fin.status });
          counts.errors++;
        }
        continue;
      }

      if (result.outcome === "requires_action") {
        // The bank wants the customer present (SCA): stop retrying, hand them the pay link.
        await admin.from("membership_renewal_cycles").update({ ...attemptPatch, charge_attempts: MAX_CHARGE_ATTEMPTS, last_charge_error: "authentication_required", payment_route: "pay_link" }).eq("id", c.id);
        const msg = authRequiredMessage({ customerName: m.customer_name, planName: plan.name, amountCents: c.amount_cents, payUrl });
        await notify(deps, to, msg.subject, msg.text);
        counts.charge_requires_action++;
        continue;
      }

      // Declined
      await admin.from("membership_renewal_cycles").update({ ...attemptPatch, last_charge_error: result.message.slice(0, 200) }).eq("id", c.id);
      if (m.status === "active") {
        await admin
          .from("memberships")
          .update({
            status: "past_due",
            dunning_stage: (m.dunning_stage ?? 0) + 1,
            payment_failed_at: now.toISOString(),
            payment_grace_period_ends_at: new Date(now.getTime() + GRACE_PERIOD_DAYS * DAY_MS).toISOString(),
          })
          .eq("id", c.membership_id)
          .eq("status", "active");
      }
      // First failure and the final attempt get a message; the middle retry stays quiet.
      if (attempts === 0 || attempts + 1 >= MAX_CHARGE_ATTEMPTS) {
        const msg = chargeFailedMessage({ customerName: m.customer_name, planName: plan.name, amountCents: c.amount_cents, payUrl });
        await notify(deps, to, msg.subject, msg.text);
      }
      counts.charge_declined++;
    } catch (e) {
      counts.errors++;
      deps.log?.("membership_renewal_error", { step: "charge", id: c.id, error: errMsg(e) });
    }
  }
}

export async function runRenewalPipeline(admin: any, deps: PipelineDeps): Promise<RenewalCounts> {
  const counts: RenewalCounts = { closed_non_renewing: 0, cycles_opened: 0, notices_sent: 0, charged: 0, charge_declined: 0, charge_requires_action: 0, errors: 0 };
  const steps: [string, () => Promise<void>][] = [
    ["close_non_renewing", () => closeNonRenewing(admin, deps, counts)],
    ["open_cycles", () => openCycles(admin, deps, counts)],
    ["advance_cycles", () => advanceCycles(admin, deps, counts)],
    ["charge_due", () => chargeDueCycles(admin, deps, counts)],
  ];
  // One failing step never blocks the next: a bad query in B must not stop due cards being charged in D.
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (e) {
      counts.errors++;
      deps.log?.("membership_renewal_error", { step, error: errMsg(e) });
    }
  }
  return counts;
}
