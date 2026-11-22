// supabase/functions/results-plan-statement/index.ts
//
// Monthly Results Plan statement.
//   POST {action:"sweep"}  X-Cron-Secret = RESULTS_PLAN_CRON_SECRET (hourly cron): for every account with charges in a closed month,
//        creates ONE immutable snapshot per (account, month) and emails the PDF to the owner.
//
// Idempotency: statements are UNIQUE (user_id, month) and inserted with ON CONFLICT DO NOTHING, so re-running a sweep, overlapping
// runs and catch-up months never create a second statement. The email step is claimed atomically (rp_statement_claim_email), so two
// workers never send concurrently and a delivery failure is retried (max 5) without regenerating anything.
// Opt-out: results_plan_accounts.statement_email_enabled = false => the statement is still stored (dashboard + PDF) but never emailed.
// Service role: EVERY query is scoped by user_id. Secrets: RESULTS_PLAN_CRON_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL (optional).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@2.5.2";
import {
  buildMonthlyStatementPdf, buildSnapshot, canonicalJson, dueMonths, formatMoneyPlain, isSnapshot, statementFilename, type ConfirmationTotals, type StatementSnapshot,
} from "../_shared/results-plan/monthlyStatement.ts";
import type { StatementLine } from "../_shared/results-plan/statement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const BATCH = 25;
const BUDGET_MS = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
type Admin = SupabaseClient;

interface ChargeRow { id: string; job_id: string; status: StatementLine["status"]; job_type: string | null; verified_at: string; list_price_cents: number | null; amount_cents: number | null }
interface TermsRow { id: string; name: string; currency: string; model: string; base_fee_cents: number }

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function generate(admin: Admin, userId: string, month: string, termsId: string | null): Promise<boolean> {
  // Already generated? (cheap exit; the UNIQUE constraint is the real guard)
  const { data: have } = await admin.from("results_plan_statements").select("id").eq("user_id", userId).eq("month", month).maybeSingle();
  if (have) return false;

  const { data: chargeData, error } = await admin.from("results_plan_charges").select("id,job_id,status,job_type,verified_at,list_price_cents,amount_cents")
    .eq("user_id", userId).eq("month", month).order("verified_at", { ascending: true }).limit(2000);
  if (error) throw new Error(`charges:${error.message}`);
  const charges = (chargeData ?? []) as ChargeRow[];
  if (charges.length === 0) return false; // no activity => no statement

  const jobIds = charges.map((c) => c.job_id);
  const names = new Map<string, { name: string | null; invoice: number | null }>();
  for (let i = 0; i < jobIds.length; i += 200) {
    const { data } = await admin.from("jobs").select("id,customer_name,invoice_amount").eq("user_id", userId).in("id", jobIds.slice(i, i + 200));
    for (const j of (data ?? []) as Array<{ id: string; customer_name: string | null; invoice_amount: number | null }>) names.set(j.id, { name: j.customer_name, invoice: j.invoice_amount });
  }
  const confirmations: ConfirmationTotals = { asked: 0, confirmed: 0, denied: 0, noResponse: 0 };
  for (let i = 0; i < jobIds.length; i += 200) {
    const { data } = await admin.from("results_plan_confirmations").select("status").eq("user_id", userId).in("job_id", jobIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ status: string }>) {
      if (["sent", "confirmed", "denied", "no_response"].includes(r.status)) confirmations.asked++;
      if (r.status === "confirmed") confirmations.confirmed++;
      else if (r.status === "denied") confirmations.denied++;
      else if (r.status === "no_response") confirmations.noResponse++;
    }
  }

  let terms: TermsRow | null = null;
  if (termsId) {
    const { data } = await admin.from("results_plan_pricing_terms").select("id,name,currency,model,base_fee_cents").eq("id", termsId).maybeSingle();
    terms = (data as TermsRow | null) ?? null;
  }
  const { data: prof } = await admin.from("profiles").select("company_name,invoice_currency").eq("id", userId).maybeSingle();
  const profile = prof as { company_name: string | null; invoice_currency: string | null } | null;
  const currency = terms?.currency ?? (profile?.invoice_currency && /^[A-Z]{3}$/.test(profile.invoice_currency) ? profile.invoice_currency : "USD");

  const lines: StatementLine[] = charges.map((c) => ({
    chargeId: c.id, jobId: c.job_id, verifiedAt: c.verified_at, customerLabel: (names.get(c.job_id)?.name ?? "").trim().slice(0, 60) || "Customer",
    jobType: c.job_type, ruleVersion: "", status: c.status, amountCents: c.amount_cents ?? 0, listPriceCents: c.list_price_cents ?? c.amount_cents ?? 0,
    estimatedRevenueCents: names.get(c.job_id)?.invoice != null ? Math.round(Number(names.get(c.job_id)!.invoice) * 100) : null,
  }));
  // Base fee belongs to the month only if the account actually had a hybrid base fee approved; read from the terms, never invented.
  const baseFee = terms?.model === "hybrid" ? terms.base_fee_cents : 0;
  const snapshot = buildSnapshot({ month, currency, companyName: profile?.company_name ?? null, generatedAt: new Date().toISOString(), termsName: terms?.name ?? null, baseFeeCents: baseFee, lines, confirmations });
  const hash = await sha256Hex(canonicalJson(snapshot));
  const { data: ins, error: insErr } = await admin.from("results_plan_statements").upsert(
    { user_id: userId, month, currency, terms_id: terms?.id ?? null, snapshot, snapshot_sha256: hash, line_count: lines.length },
    { onConflict: "user_id,month", ignoreDuplicates: true },
  ).select("id");
  if (insErr) throw new Error(`statement:${insErr.message}`);
  return (ins?.length ?? 0) > 0;
}

async function recipients(admin: Admin, userId: string): Promise<string[]> {
  const { data } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = (data as { email: string | null } | null)?.email?.trim();
  return email && EMAIL_RE.test(email) ? [email] : [];
}

async function sendMail(to: string, subject: string, html: string, text: string, filename: string, pdf: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { ok: false, error: "Email isn't configured yet (missing RESEND_API_KEY)." };
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text, attachments: [{ filename, content: toBase64(pdf) }] }),
    });
    return res.ok ? { ok: true } : { ok: false, error: (await res.text()).slice(0, 300) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function deliver(admin: Admin, userId: string, emailEnabled: boolean, row: { id: string; month: string; snapshot: unknown }): Promise<"sent" | "skipped" | "failed" | "busy"> {
  if (!emailEnabled) {
    await admin.from("results_plan_statements").update({ email_status: "skipped" }).eq("id", row.id).eq("user_id", userId).in("email_status", ["pending", "failed"]);
    return "skipped";
  }
  const { data: claimed, error: ce } = await admin.rpc("rp_statement_claim_email", { p_id: row.id });
  if (ce) throw new Error(`claim:${ce.message}`);
  if (claimed !== true) return "busy";
  const fail = async (reason: string) => {
    await admin.from("results_plan_statements").update({ email_status: "failed", email_error: reason.slice(0, 300) }).eq("id", row.id).eq("user_id", userId);
    return "failed" as const;
  };
  if (!isSnapshot(row.snapshot)) return fail("snapshot_invalid");
  const snap: StatementSnapshot = row.snapshot;
  const to = await recipients(admin, userId);
  if (to.length === 0) return fail("no_recipient");
  let pdf: Uint8Array;
  try { pdf = buildMonthlyStatementPdf(jsPDF as never, snap); } catch (e) { return fail(`pdf:${e instanceof Error ? e.message : "error"}`); }
  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const link = site ? `${site}/dashboard/results-plan` : "";
  const total = formatMoneyPlain(snap.summary.netCents, snap.currency);
  const subject = `Your Results Plan statement for ${snap.month}`;
  const text = `Your Results Plan statement for ${snap.month} is attached.\nVerified jobs: ${snap.summary.verifiedJobs}\nTotal: ${total}\n${link ? `Details and evidence: ${link}\n` : ""}`;
  const html = `<p>Your Results Plan statement for <strong>${esc(snap.month)}</strong> is attached.</p><p>Verified jobs: ${snap.summary.verifiedJobs}<br>Total: <strong>${esc(total)}</strong></p>${link ? `<p><a href="${esc(link)}">Open your Results Plan</a> to see the evidence behind every charge.</p>` : ""}`;
  let allOk = true; let lastErr = "";
  for (const addr of to) {
    const r = await sendMail(addr, subject, html, text, statementFilename(snap.month), pdf);
    if (!r.ok) { allOk = false; lastErr = r.error ?? "send_failed"; }
  }
  if (!allOk) return fail(lastErr);
  await admin.from("results_plan_statements").update({ email_status: "sent", emailed_at: new Date().toISOString(), email_error: null }).eq("id", row.id).eq("user_id", userId);
  return "sent";
}

interface Account { user_id: string; terms_id: string | null; statement_email_enabled: boolean }

async function sweepAccount(admin: Admin, a: Account, months: string[]) {
  const out = { generated: 0, sent: 0, skipped: 0, failed: 0 };
  for (const month of months) {
    if (await generate(admin, a.user_id, month, a.terms_id)) out.generated++;
  }
  // Deliver anything undelivered for the recent months (covers first send and retries).
  const { data } = await admin.from("results_plan_statements").select("id,month,snapshot,email_status").eq("user_id", a.user_id)
    .in("month", months).in("email_status", ["pending", "failed", "sending"]);
  for (const r of (data ?? []) as Array<{ id: string; month: string; snapshot: unknown }>) {
    const res = await deliver(admin, a.user_id, a.statement_email_enabled, r);
    if (res === "sent") out.sent++; else if (res === "skipped") out.skipped++; else if (res === "failed") out.failed++;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("RESULTS_PLAN_CRON_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);
  const body = await req.json().catch(() => ({})) as { action?: string };
  if (body.action !== "sweep") return json({ error: "Unknown action" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const months = dueMonths(new Date());
  if (months.length === 0) return json({ processed: 0, months });
  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (let from = 0; Date.now() - started <= BUDGET_MS; from += BATCH) {
    // paused/ended accounts keep receiving statements for months in which they had charges
    const { data: accounts, error } = await admin.from("results_plan_accounts").select("user_id,terms_id,statement_email_enabled")
      .in("status", ["active", "paused", "ended"]).not("opted_in_at", "is", null).order("user_id", { ascending: true }).range(from, from + BATCH - 1);
    if (error) return json({ error: error.message }, 500);
    const page = (accounts ?? []) as Account[];
    for (const a of page) {
      if (Date.now() - started > BUDGET_MS) break;
      try { results.push({ user_id: a.user_id, ...(await sweepAccount(admin, a, months)) }); }
      catch (e) { console.error("results-plan-statement account failed", a.user_id, e instanceof Error ? e.message : e); results.push({ user_id: a.user_id, error: true }); }
    }
    if (page.length < BATCH) break;
  }
  return json({ processed: results.length, months, results });
});
