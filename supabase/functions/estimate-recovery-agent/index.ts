// supabase/functions/estimate-recovery-agent/index.ts
//
// Estimate-to-Cash Recovery Agent
//
// Cron-driven scanner that finds estimates stalling anywhere between
// "quote sent" and "cash collected" and does two things for each new
// risk it finds:
//   1. Opens/updates a row in revenue_recovery_events (the existing
//      recovery ledger — surfaces in /dashboard/recovery once the UI
//      label edit below is applied).
//   2. Appends a business_activity_events row, which the existing
//      match_workflow_definitions trigger uses to auto-enroll the
//      matching playbook from src/lib/workflowPlaybooks.ts.
//
// Detection is deliberately deterministic (days-stalled + dollar value
// = risk_score), same "AI only reasons over real numbers, never
// invents them" philosophy as business-decision-engine — this keeps
// the agent fast, cheap, and impossible to hallucinate a false risk.
//
// DEPLOYMENT: supabase functions deploy estimate-recovery-agent
// --no-verify-jwt, then point your existing cron at it every 15-30
// minutes, same X-Cron-Secret header / CRON_SECRET value already used
// by workflow-engine-executor.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Thresholds — tune freely, nothing else in the system depends on these exact numbers.
const FINANCING_MIN_HOURS = 72;        // quote sent 3+ days, still unanswered
const FINANCING_MIN_VALUE_CENTS = 50000; // $500+ — worth mentioning financing for
const BOOKING_MIN_HOURS = 24;          // accepted 1+ day, still no job on the calendar
const INVOICE_MIN_HOURS = 24;          // completed 1+ day, still not invoiced
const COLLECTION_MIN_DAYS = 14;        // matches OVERDUE_AFTER_DAYS in send-payment-reminders

function riskScore(hoursStalled: number, valueCents: number): number {
  const timeComponent = Math.min(60, Math.round(hoursStalled / 4));
  const valueComponent = Math.min(40, Math.round(valueCents / 5000));
  return Math.min(100, timeComponent + valueComponent);
}

async function upsertLedgerEntry(admin: ReturnType<typeof createClient>, row: Record<string, unknown>) {
  // Idempotent by (source_table, source_id) — the unique constraint already
  // on revenue_recovery_events. ignoreDuplicates leaves an entry a human
  // already triaged (contacted/recovered/written_off) untouched.
  await admin.from("revenue_recovery_events").upsert(row, {
    onConflict: "source_table,source_id",
    ignoreDuplicates: true,
  });
}

async function enroll(
  admin: ReturnType<typeof createClient>,
  args: {
    aggregateType: string; aggregateId: string; eventType: string; userId: string;
    customerName: string | null; customerPhone: string | null; customerEmail: string | null;
    extra: Record<string, unknown>;
  },
) {
  await admin.rpc("append_activity_event", {
    p_aggregate_type: args.aggregateType,
    p_aggregate_id: args.aggregateId,
    p_event_type: args.eventType,
    p_event_data: {
      customer_name: args.customerName,
      customer_phone: args.customerPhone,
      customer_email: args.customerEmail,
      ...args.extra,
    },
    p_actor_type: "ai",
    p_user_id: args.userId,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const now = Date.now();
  const counts = { financing: 0, booking: 0, invoice: 0, collection: 0 };

  // -----------------------------------------------------------------
  // 1. FINANCING RISK — quote sent, high value, stalled 72h+
  // -----------------------------------------------------------------
  {
    const cutoff = new Date(now - FINANCING_MIN_HOURS * 3600_000).toISOString();
    const { data: quotes } = await admin
      .from("quotes")
      .select("id, user_id, lead_id, customer_name, customer_phone, customer_email, line_items, tax_percent, sent_at")
      .eq("status", "sent")
      .lte("sent_at", cutoff);

    for (const q of quotes ?? []) {
      const { data: subtotal } = await admin.rpc("quote_line_items_subtotal_cents", { p_line_items: q.line_items });
      const valueCents = Math.round(Number(subtotal ?? 0) * (1 + Number(q.tax_percent ?? 0) / 100));
      if (valueCents < FINANCING_MIN_VALUE_CENTS) continue;

      const hoursStalled = (now - new Date(q.sent_at).getTime()) / 3600_000;
      await upsertLedgerEntry(admin, {
        user_id: q.user_id, source_type: "quote_financing_stalled", source_table: "quotes", source_id: q.id,
        lead_id: q.lead_id, customer_name: q.customer_name, customer_phone: q.customer_phone,
        estimated_value_cents: valueCents, estimated_value_basis: "quote_amount",
      });
      await enroll(admin, {
        aggregateType: "quote", aggregateId: q.id, eventType: "quote.financing_needed", userId: q.user_id,
        customerName: q.customer_name, customerPhone: q.customer_phone, customerEmail: q.customer_email,
        extra: { risk_score: riskScore(hoursStalled, valueCents), amount_cents: valueCents },
      });
      counts.financing++;
    }
  }

  // -----------------------------------------------------------------
  // 2. BOOKING RISK — accepted, no job scheduled 24h+ later
  // -----------------------------------------------------------------
  {
    const cutoff = new Date(now - BOOKING_MIN_HOURS * 3600_000).toISOString();
    const { data: quotes } = await admin
      .from("quotes")
      .select("id, user_id, lead_id, customer_name, customer_phone, customer_email, line_items, tax_percent, responded_at")
      .eq("status", "accepted")
      .lte("responded_at", cutoff)
      .not("lead_id", "is", null);

    for (const q of quotes ?? []) {
      const { data: existingJob } = await admin.from("jobs").select("id").eq("lead_id", q.lead_id).maybeSingle();
      if (existingJob) continue;

      const { data: subtotal } = await admin.rpc("quote_line_items_subtotal_cents", { p_line_items: q.line_items });
      const valueCents = Math.round(Number(subtotal ?? 0) * (1 + Number(q.tax_percent ?? 0) / 100));
      const hoursStalled = (now - new Date(q.responded_at).getTime()) / 3600_000;

      await upsertLedgerEntry(admin, {
        user_id: q.user_id, source_type: "quote_accepted_unbooked", source_table: "quotes", source_id: q.id,
        lead_id: q.lead_id, customer_name: q.customer_name, customer_phone: q.customer_phone,
        estimated_value_cents: valueCents, estimated_value_basis: "quote_amount",
      });
      await enroll(admin, {
        aggregateType: "quote", aggregateId: q.id, eventType: "quote.accepted_not_booked", userId: q.user_id,
        customerName: q.customer_name, customerPhone: q.customer_phone, customerEmail: q.customer_email,
        extra: { risk_score: riskScore(hoursStalled, valueCents), amount_cents: valueCents },
      });
      counts.booking++;
    }
  }

  // -----------------------------------------------------------------
  // 3. INVOICE RISK — job completed, never invoiced, 24h+ later
  //    (completion time comes from the activity ledger — jobs has no
  //    updated_at column, so job.completed's occurred_at is the source
  //    of truth, same pattern the workflow engine itself relies on)
  // -----------------------------------------------------------------
  {
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, user_id, lead_id, customer_name, invoice_amount, job_status, invoice_status")
      .eq("job_status", "completed")
      .eq("invoice_status", "not_sent");

    for (const j of jobs ?? []) {
      const { data: completedEvent } = await admin
        .from("business_activity_events")
        .select("occurred_at")
        .eq("aggregate_type", "job").eq("aggregate_id", j.id).eq("event_type", "job.completed")
        .order("occurred_at", { ascending: false }).limit(1).maybeSingle();
      if (!completedEvent) continue;

      const hoursStalled = (now - new Date(completedEvent.occurred_at).getTime()) / 3600_000;
      if (hoursStalled < INVOICE_MIN_HOURS) continue;

      let phone: string | null = null;
      if (j.lead_id) {
        const { data: lead } = await admin.from("leads").select("phone, email").eq("id", j.lead_id).maybeSingle();
        phone = lead?.phone ?? null;
      }
      const valueCents = Math.round(Number(j.invoice_amount ?? 0) * 100);

      await upsertLedgerEntry(admin, {
        user_id: j.user_id, source_type: "job_completed_unbilled", source_table: "jobs", source_id: j.id,
        lead_id: j.lead_id, customer_name: j.customer_name, customer_phone: phone,
        estimated_value_cents: valueCents, estimated_value_basis: valueCents > 0 ? "job_invoice" : "none",
      });
      await enroll(admin, {
        aggregateType: "job", aggregateId: j.id, eventType: "job.completed_not_invoiced", userId: j.user_id,
        customerName: j.customer_name, customerPhone: phone, customerEmail: null,
        extra: { risk_score: riskScore(hoursStalled, valueCents), amount_cents: valueCents },
      });
      counts.invoice++;
    }
  }

  // -----------------------------------------------------------------
  // 4. COLLECTION RISK — invoiced, unpaid past the collection window
  // -----------------------------------------------------------------
  {
    const cutoff = new Date(now - COLLECTION_MIN_DAYS * 86400_000).toISOString();
    const { data: requests } = await admin
      .from("payment_requests")
      .select("id, user_id, job_id, customer_name, customer_phone, customer_email, amount, status, created_at")
      .in("status", ["sent", "overdue"])
      .lte("created_at", cutoff);

    for (const r of requests ?? []) {
      let leadId: string | null = null;
      if (r.job_id) {
        const { data: job } = await admin.from("jobs").select("lead_id").eq("id", r.job_id).maybeSingle();
        leadId = job?.lead_id ?? null;
      }
      const valueCents = Math.round(Number(r.amount ?? 0) * 100);
      const daysStalled = (now - new Date(r.created_at).getTime()) / 86400_000;

      await upsertLedgerEntry(admin, {
        user_id: r.user_id, source_type: "invoice_overdue", source_table: "payment_requests", source_id: r.id,
        lead_id: leadId, customer_name: r.customer_name, customer_phone: r.customer_phone,
        estimated_value_cents: valueCents, estimated_value_basis: "job_invoice",
      });
      await enroll(admin, {
        aggregateType: "payment_request", aggregateId: r.id, eventType: "invoice.payment_overdue", userId: r.user_id,
        customerName: r.customer_name, customerPhone: r.customer_phone, customerEmail: r.customer_email,
        extra: { risk_score: riskScore(daysStalled * 24, valueCents), amount_cents: valueCents },
      });
      counts.collection++;
    }
  }

  return json({ ok: true, flagged: counts });
});
