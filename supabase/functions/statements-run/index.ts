// Customer statements of account — email delivery.
//
//   POST { action: "tick" }
//        Called by pg_cron every ~10 min (see the cron snippet in migration
//        20271206000000_customer_statements.sql). Auth: X-Cron-Secret == CRON_SECRET,
//        or Bearer == service role key. Claims due schedules atomically (at-most-once)
//        and sends one statement per payer account.
//   POST { action: "send_now", customer_id, period_from, period_to, consolidate?, recipient? }
//        Manual send from the dashboard. Auth: user JWT + can_view_billing.
//   POST { action: "run_schedule", schedule_id }
//        "Run now" for a schedule. Auth: user JWT + can_view_billing. 1 run / 60 s.
//
// The service role bypasses RLS, so every query is explicitly scoped by the
// account-owner id. Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL (optional),
// SITE_URL (optional), CRON_SECRET (recommended).
// Deploy: supabase functions deploy statements-run

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PER_RUN = 200;
const TICK_BUDGET_MS = 100_000;
const MANUAL_COOLDOWN_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_EMAIL_LINES = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);

const fmtDate = (iso: string) =>
  new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ------------------------------------------------------------------ period
function localDate(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function resolvePeriod(mode: string, tz: string, now = new Date()): { from: string; to: string } {
  const today = localDate(tz, now);
  const [y, m, d] = today.split("-").map(Number);
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  if (mode === "previous_month") return { from: iso(y, m - 2, 1), to: iso(y, m - 1, 0) };
  if (mode === "year_to_date") return { from: iso(y, 0, 1), to: today };
  return { from: iso(y, m - 1, d - 29), to: today };
}

// ------------------------------------------------------------------ access
// deno-lint-ignore no-explicit-any
type Admin = SupabaseClient<any, "public", any>;

async function resolveCaller(admin: Admin, user: { id: string; email?: string | null }) {
  const { data: profile } = await admin.from("profiles").select("id, role, company_name").eq("id", user.id).maybeSingle();
  if (profile?.role === "owner") return { ownerId: profile.id as string, canBill: true, companyName: profile.company_name as string | null };

  const { data: member } = await admin
    .from("team_members")
    .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
    .eq("member_email", user.email ?? "")
    .maybeSingle();
  if (!member) return { ownerId: profile?.id ?? user.id, canBill: Boolean(profile), companyName: profile?.company_name ?? null };

  const custom = member.custom_role?.permissions?.can_view_billing;
  const canBill = custom !== undefined ? Boolean(custom) : Boolean(member.permissions?.can_view_billing);
  const { data: owner } = await admin.from("profiles").select("company_name").eq("id", member.account_owner_id).maybeSingle();
  return { ownerId: member.account_owner_id as string, canBill, companyName: (owner?.company_name as string | null) ?? null };
}

// ------------------------------------------------------------------ email
interface Statement {
  customer: { id: string; name: string; email: string | null };
  period_from: string;
  period_to: string;
  consolidated: boolean;
  members: Array<{ id: string; name: string }>;
  opening_cents: number;
  charges_cents: number;
  payments_cents: number;
  refunds_cents: number;
  closing_cents: number;
  lines: Array<{ date: string; kind: string; description: string; customer_name: string; charge_cents: number; credit_cents: number; balance_cents: number }>;
  open_invoices: Array<{ invoice_number: string | null; invoice_token: string; customer_name: string; due_date: string | null; balance_cents: number; days_past_due: number; bucket: string }>;
  aging: Record<"current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus", number>;
}

function buildEmail(st: Statement, business: string, siteUrl: string) {
  const subject = `Statement of account from ${business} — ${fmtDate(st.period_from)} to ${fmtDate(st.period_to)}`;
  const td = "padding:8px 10px;border-bottom:1px solid #e1e1e8;font-size:13px;";
  const num = `${td}text-align:right;white-space:nowrap;`;
  const shown = st.lines.slice(0, MAX_EMAIL_LINES);
  const more = st.lines.length - shown.length;

  const lines = shown.map((l) =>
    `<tr><td style="${td}white-space:nowrap">${esc(fmtDate(l.date))}</td><td style="${td}">${esc(l.description)}${st.consolidated && l.customer_name ? `<br><span style="color:#6e6e78;font-size:12px">${esc(l.customer_name)}</span>` : ""}</td><td style="${num}">${l.charge_cents ? esc(money(l.charge_cents)) : ""}</td><td style="${num}">${l.credit_cents ? esc(money(l.credit_cents)) : ""}</td><td style="${num}">${esc(money(l.balance_cents))}</td></tr>`).join("");

  const open = st.open_invoices.slice(0, 40).map((o) =>
    `<tr><td style="${td}"><a href="${esc(`${siteUrl}/invoice/${o.invoice_token}`)}" style="color:#203ad8;text-decoration:none">${esc(o.invoice_number ?? "Invoice")}</a></td><td style="${td}">${o.due_date ? esc(fmtDate(o.due_date)) : "—"}</td><td style="${td}">${o.days_past_due > 0 ? `${o.days_past_due} days past due` : "Current"}</td><td style="${num}">${esc(money(o.balance_cents))}</td></tr>`).join("");

  const ag = st.aging;
  const aging = [["Current", ag.current], ["1–30", ag.d1_30], ["31–60", ag.d31_60], ["61–90", ag.d61_90], ["90+", ag.d90_plus]]
    .map(([k, v]) => `<td style="padding:8px 6px;text-align:center;border:1px solid #e1e1e8;font-size:12px"><div style="color:#6e6e78">${esc(k)}</div><div style="font-weight:600;margin-top:2px">${esc(money(Number(v)))}</div></td>`).join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#171717">
<p style="font-size:15px">Hello ${esc(st.customer.name)},</p>
<p style="font-size:14px;line-height:1.5">Here is your statement of account from <strong>${esc(business)}</strong> for ${esc(fmtDate(st.period_from))} – ${esc(fmtDate(st.period_to))}${st.consolidated ? `, covering ${st.members.length} linked accounts` : ""}.</p>
<table style="width:100%;border:1px solid #e1e1e8;border-radius:12px;border-collapse:separate;padding:12px;margin:16px 0">
<tr><td style="padding:4px 0;color:#6e6e78;font-size:13px">Opening balance</td><td style="text-align:right;font-size:13px">${esc(money(st.opening_cents))}</td></tr>
<tr><td style="padding:4px 0;color:#6e6e78;font-size:13px">New charges</td><td style="text-align:right;font-size:13px">${esc(money(st.charges_cents + st.refunds_cents))}</td></tr>
<tr><td style="padding:4px 0;color:#6e6e78;font-size:13px">Payments received</td><td style="text-align:right;font-size:13px">−${esc(money(st.payments_cents))}</td></tr>
<tr><td style="padding:8px 0 0;font-weight:700;font-size:15px;border-top:1px solid #e1e1e8">Balance due</td><td style="text-align:right;font-weight:700;font-size:15px;padding-top:8px;border-top:1px solid #e1e1e8">${esc(money(st.closing_cents))}</td></tr></table>
<table style="width:100%;border-collapse:collapse;margin:0 0 20px"><tr>${aging}</tr></table>
${open ? `<h3 style="font-size:14px;margin:20px 0 6px">Open invoices</h3><table style="width:100%;border-collapse:collapse"><tr style="text-align:left;color:#6e6e78;font-size:12px"><th style="padding:6px 10px">Invoice</th><th style="padding:6px 10px">Due</th><th style="padding:6px 10px">Status</th><th style="padding:6px 10px;text-align:right">Balance</th></tr>${open}</table>` : ""}
${lines ? `<h3 style="font-size:14px;margin:24px 0 6px">Activity</h3><table style="width:100%;border-collapse:collapse"><tr style="text-align:left;color:#6e6e78;font-size:12px"><th style="padding:6px 10px">Date</th><th style="padding:6px 10px">Description</th><th style="padding:6px 10px;text-align:right">Charges</th><th style="padding:6px 10px;text-align:right">Credits</th><th style="padding:6px 10px;text-align:right">Balance</th></tr>${lines}</table>${more > 0 ? `<p style="color:#6e6e78;font-size:12px">+ ${more} more entries — open an invoice link above for full detail.</p>` : ""}` : ""}
<p style="color:#6e6e78;font-size:13px;margin-top:28px">Questions about this statement? Just reply to this email.<br/>${esc(business)}</p></div>`;

  const text = [
    `Hello ${st.customer.name},`, "",
    `Statement of account from ${business}: ${fmtDate(st.period_from)} – ${fmtDate(st.period_to)}`,
    `Opening balance: ${money(st.opening_cents)}`,
    `New charges: ${money(st.charges_cents + st.refunds_cents)}`,
    `Payments received: ${money(st.payments_cents)}`,
    `Balance due: ${money(st.closing_cents)}`, "",
    ...st.open_invoices.slice(0, 40).map((o) => `${o.invoice_number ?? "Invoice"}  due ${o.due_date ? fmtDate(o.due_date) : "—"}  ${money(o.balance_cents)}  ${siteUrl}/invoice/${o.invoice_token}`),
    "", business,
  ].join("\n");

  return { subject, html, text };
}

// ------------------------------------------------------------------ core send
interface SendCtx {
  admin: Admin;
  ownerId: string;
  business: string;
  siteUrl: string;
  trigger: "schedule" | "manual";
  scheduleId: string | null;
  sentBy: { id: string; email: string | null } | null;
}

type Outcome = "sent" | "failed" | "skipped";

async function sendStatement(
  ctx: SendCtx,
  customerId: string,
  period: { from: string; to: string },
  opts: { consolidate: boolean; minBalanceCents: number; recipientOverride?: string; skipIfNoBalance: boolean },
): Promise<{ outcome: Outcome; detail?: string; recipient?: string; closing?: number }> {
  const { admin, ownerId } = ctx;
  const { data, error } = await admin.rpc("_statement_build", {
    p_owner: ownerId, p_customer_id: customerId, p_from: period.from, p_to: period.to, p_consolidate: opts.consolidate,
  });
  if (error || !data) return { outcome: "failed", detail: error?.message ?? "Could not build the statement." };
  const st = data as Statement;

  const log = async (status: Outcome, recipient: string | null, errText: string | null) => {
    const { error: logErr } = await admin.from("statement_sends").insert({
      user_id: ownerId, schedule_id: ctx.scheduleId, customer_id: customerId, customer_name: st.customer.name, trigger: ctx.trigger,
      status, recipient, period_from: period.from, period_to: period.to, closing_balance_cents: st.closing_cents,
      consolidated: st.consolidated, error: errText ? errText.slice(0, 500) : null,
      sent_by: ctx.sentBy?.id ?? null, sent_by_email: ctx.sentBy?.email ?? null,
    });
    // 23505 = already sent for this schedule + customer + period (idempotency index) — not an error.
    if (logErr && logErr.code !== "23505") console.error("statement_sends insert failed", logErr.message);
  };

  if (opts.skipIfNoBalance && (st.closing_cents <= 0 || st.closing_cents < opts.minBalanceCents)) {
    return { outcome: "skipped", detail: "No balance due.", closing: st.closing_cents };
  }

  const to = (opts.recipientOverride ?? st.customer.email ?? "").trim();
  if (!EMAIL_RE.test(to)) {
    await log("skipped", null, "No valid email on file for this customer.");
    return { outcome: "skipped", detail: "No valid email on file.", closing: st.closing_cents };
  }

  if (ctx.trigger === "schedule" && ctx.scheduleId) {
    const { data: dup } = await admin.from("statement_sends").select("id")
      .eq("user_id", ownerId).eq("schedule_id", ctx.scheduleId).eq("customer_id", customerId).eq("period_to", period.to).eq("status", "sent").limit(1).maybeSingle();
    if (dup) return { outcome: "skipped", detail: "Already sent for this period.", recipient: to, closing: st.closing_cents };
  }

  const { subject, html, text } = buildEmail(st, ctx.business, ctx.siteUrl);
  const res = await sendEmail(to, subject, html, text);
  await log(res.ok ? "sent" : "failed", to, res.ok ? null : (res.error ?? "Unknown error"));
  if (!res.ok) return { outcome: "failed", detail: res.error ?? "Email provider rejected the message.", recipient: to, closing: st.closing_cents };

  await admin.from("audit_log").insert({
    user_id: ownerId, actor_id: ctx.sentBy?.id ?? null, actor_email: ctx.sentBy?.email ?? null,
    action: "customer_statement_sent", target_table: "customers", target_id: customerId,
    details: { recipient: to, period_from: period.from, period_to: period.to, closing_cents: st.closing_cents, trigger: ctx.trigger },
  });
  return { outcome: "sent", recipient: to, closing: st.closing_cents };
}

// ------------------------------------------------------------------ schedules
interface ScheduleRow {
  id: string; user_id: string; name: string; scope: "all_open" | "overdue_only" | "selected"; customer_ids: string[];
  period_mode: string; timezone: string; min_balance_cents: number; consolidate: boolean; consecutive_failures: number;
}

async function runSchedule(admin: Admin, sch: ScheduleRow, siteUrl: string, deadline: number, sentBy: SendCtx["sentBy"], trigger: "schedule" | "manual") {
  const ownerId = sch.user_id;
  const { data: prof } = await admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
  const business = (prof?.company_name as string | null) || "Your service provider";
  const period = resolvePeriod(sch.period_mode, sch.timezone);
  const today = localDate(sch.timezone);
  const ctx: SendCtx = { admin, ownerId, business, siteUrl, trigger, scheduleId: sch.id, sentBy };

  const { data: accounts, error: accErr } = await admin.rpc("_statement_accounts", { p_owner: ownerId, p_as_of: today });
  if (accErr) return { status: "failed" as const, summary: { error: accErr.message, period_from: period.from, period_to: period.to } };
  // deno-lint-ignore no-explicit-any
  let targets: string[] = ((accounts ?? []) as any[]).filter((a) => {
    if (sch.scope === "selected") return true;
    const bal = Number(a.balance_cents), over = Number(a.overdue_cents);
    return sch.scope === "overdue_only" ? over > 0 && over >= sch.min_balance_cents : bal > 0 && bal >= sch.min_balance_cents;
  }).map((a) => a.customer_id as string);

  if (sch.scope === "selected") {
    // A selected child account resolves to its payer when consolidating.
    const { data: sel } = await admin.from("customers").select("id, bill_to_customer_id").eq("user_id", ownerId).in("id", sch.customer_ids);
    const ids = new Set<string>();
    for (const c of sel ?? []) ids.add(sch.consolidate && c.bill_to_customer_id ? c.bill_to_customer_id : c.id);
    targets = [...ids];
  } else if (!sch.consolidate && targets.length) {
    const { data: kids } = await admin.from("customers").select("id").eq("user_id", ownerId).not("bill_to_customer_id", "is", null);
    targets = [...new Set([...targets, ...(kids ?? []).map((k: { id: string }) => k.id)])];
  }
  targets = targets.slice(0, MAX_PER_RUN);

  let sent = 0, failed = 0, skipped = 0;
  const problems: string[] = [];
  for (const id of targets) {
    if (Date.now() > deadline) { problems.push("Stopped early: time budget reached — remaining accounts go out on the next run."); break; }
    try {
      const r = await sendStatement(ctx, id, period, { consolidate: sch.consolidate, minBalanceCents: Math.max(1, sch.min_balance_cents), skipIfNoBalance: true });
      if (r.outcome === "sent") sent++; else if (r.outcome === "failed") { failed++; problems.push(r.detail ?? "failed"); } else skipped++;
    } catch (e) {
      failed++; problems.push(e instanceof Error ? e.message : "Unexpected error");
    }
  }
  const status = targets.length === 0 ? "empty" : failed === 0 ? (sent > 0 ? "sent" : "skipped") : sent > 0 ? "partial" : "failed";
  return { status: status as "sent" | "partial" | "failed" | "skipped" | "empty", summary: { sent, failed, skipped, total: targets.length, period_from: period.from, period_to: period.to, problems: problems.slice(0, 5) } };
}

async function finishSchedule(admin: Admin, sch: ScheduleRow, res: Awaited<ReturnType<typeof runSchedule>>) {
  const failures = res.status === "failed" ? sch.consecutive_failures + 1 : 0;
  const pause = failures >= MAX_CONSECUTIVE_FAILURES;
  await admin.from("statement_schedules").update({
    last_run_at: new Date().toISOString(), last_status: res.status, last_summary: res.summary, consecutive_failures: failures,
    ...(pause ? { is_active: false, next_run_at: null, paused_reason: `Paused after ${MAX_CONSECUTIVE_FAILURES} failed runs in a row — fix the cause and resume.` } : {}),
  }).eq("id", sch.id).eq("user_id", sch.user_id);
}

const SCHEDULE_COLS = "id, user_id, name, scope, customer_ids, period_mode, timezone, min_balance_cents, consolidate, consecutive_failures, last_run_at";

// ------------------------------------------------------------------ handler
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

    // -------------------------------------------------------- cron tick
    if (action === "tick") {
      const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
      const okSecret = cronSecret !== "" && safeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret);
      const okService = serviceKey !== "" && safeEqual(bearer, serviceKey);
      if (!okSecret && !okService) return json({ error: "Unauthorized" }, 401);

      const deadline = Date.now() + TICK_BUDGET_MS;
      const { data: claimed, error } = await admin.rpc("statement_schedule_claim_due", { p_limit: 10 });
      if (error) return json({ error: error.message }, 500);
      const results: Array<{ schedule_id: string; status: string }> = [];
      for (const c of (claimed ?? []) as Array<{ o_schedule_id: string }>) {
        const { data: sch } = await admin.from("statement_schedules").select(SCHEDULE_COLS).eq("id", c.o_schedule_id).maybeSingle();
        if (!sch) continue;
        const res = await runSchedule(admin, sch as ScheduleRow, siteUrl, deadline, null, "schedule");
        await finishSchedule(admin, sch as ScheduleRow, res);
        results.push({ schedule_id: sch.id, status: res.status });
      }
      return json({ ok: true, ran: results.length, results });
    }

    // -------------------------------------------------------- user actions
    if (!bearer) return json({ error: "Missing Authorization header." }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;
    const { ownerId, canBill, companyName } = await resolveCaller(admin, caller);
    if (!canBill) return json({ error: "You don't have permission to send statements." }, 403);
    const sentBy = { id: caller.id, email: caller.email ?? null };

    if (action === "send_now") {
      const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
      const from = String(body.period_from ?? ""), to = String(body.period_to ?? "");
      if (!customerId) return json({ error: "customer_id is required." }, 400);
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return json({ error: "Invalid statement period." }, 400);
      const override = typeof body.recipient === "string" && body.recipient.trim() ? body.recipient.trim() : undefined;
      if (override && !EMAIL_RE.test(override)) return json({ error: "That recipient email isn't valid." }, 400);

      const { data: cust } = await admin.from("customers").select("id").eq("id", customerId).eq("user_id", ownerId).maybeSingle();
      if (!cust) return json({ error: "Customer not found." }, 404);

      const { data: last } = await admin.from("statement_sends").select("created_at")
        .eq("user_id", ownerId).eq("customer_id", customerId).eq("trigger", "manual").eq("status", "sent")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - new Date(last.created_at).getTime() < MANUAL_COOLDOWN_MS) {
        return json({ error: "A statement was just sent to this customer. Wait a minute and try again.", code: "COOLDOWN" }, 429);
      }

      const r = await sendStatement(
        { admin, ownerId, business: companyName || "Your service provider", siteUrl, trigger: "manual", scheduleId: null, sentBy },
        customerId, { from, to }, { consolidate: body.consolidate !== false, minBalanceCents: 0, recipientOverride: override, skipIfNoBalance: false },
      );
      if (r.outcome === "sent") return json({ ok: true, recipient: r.recipient, closing_cents: r.closing });
      if (r.outcome === "skipped") return json({ error: r.detail ?? "Nothing to send.", code: "SKIPPED" }, 422);
      return json({ error: "Could not send the statement.", detail: r.detail }, 422);
    }

    if (action === "run_schedule") {
      const scheduleId = typeof body.schedule_id === "string" ? body.schedule_id : "";
      if (!scheduleId) return json({ error: "schedule_id is required." }, 400);
      const { data: sch } = await admin.from("statement_schedules").select(SCHEDULE_COLS).eq("id", scheduleId).eq("user_id", ownerId).maybeSingle();
      if (!sch) return json({ error: "Schedule not found." }, 404);
      if (sch.last_run_at && Date.now() - new Date(sch.last_run_at).getTime() < MANUAL_COOLDOWN_MS) {
        return json({ error: "This schedule just ran. Wait a minute and try again.", code: "COOLDOWN" }, 429);
      }
      // Claim the cooldown before sending so a double-click can't run it twice.
      await admin.from("statement_schedules").update({ last_run_at: new Date().toISOString() }).eq("id", sch.id).eq("user_id", ownerId);
      // Manual runs send as "manual": they never block (or are blocked by) the idempotency index of the real run.
      const res = await runSchedule(admin, sch as ScheduleRow, siteUrl, Date.now() + TICK_BUDGET_MS, sentBy, "manual");
      await finishSchedule(admin, sch as ScheduleRow, res);
      return json({ ok: true, status: res.status, summary: res.summary });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
