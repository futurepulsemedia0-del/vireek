// supabase/functions/revenue-realization-action/index.ts
//
// Governed fixes for revenue leaks. Lifecycle: propose → approve (account OWNER, a human) → execute → undo.
//   body: { op: "propose"|"approve"|"reject"|"execute"|"undo"|"feedback"|"dismiss", leakId, actionId?, verdict?, reason? }
//
// SAFETY
//   • Executors create DRAFTS only (draft quote, draft invoice) or move an INTERNAL warranty claim to
//     "packet_pending". Nothing is sent, charged or billed to a customer here — sending stays a human
//     step in the existing quote / invoice screens.
//   • The fix kind comes from the stored leak, never from the client; the payload is built server-side.
//   • approve / execute / undo require the account owner; the DB also refuses executed/undone rows
//     without approved_by.
//   • Service role bypasses RLS → every query is scoped by user_id (the caller's account owner).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { followupDraft, type FixKind } from "../_shared/revenue-realization/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Db = SupabaseClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Leak {
  id: string; user_id: string; detector: string; status: string; fix_kind: FixKind | null; amount_cents: number;
  customer_name: string | null; evidence: { table: string; id: string; label: string }[];
}
interface Action { id: string; leak_id: string; kind: FixKind; status: string; payload: Record<string, unknown>; result: Record<string, unknown> | null }

class Refusal extends Error { constructor(public code: string, public http = 409) { super(code); } }

const one = async <T,>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as T | null) ?? null;
};

// ------------------------------------------------------------------ executors (drafts only)

async function execute(db: Db, userId: string, leak: Leak, action: Action): Promise<Record<string, unknown>> {
  const ev = (t: string) => leak.evidence.find((e) => e.table === t);
  switch (action.kind) {
    case "draft_followup":
      return { draftOnly: true }; // the draft text lives in payload; a human copies/sends it from their own channel

    case "create_quote": {
      const item = ev("findings_package_items");
      if (!item) throw new Refusal("no_source_finding");
      const it = await one<{ package_id: string; options: { id?: string; line_items?: unknown; recommended?: boolean }[]; recommended_option_id: string | null }>(
        db.from("findings_package_items").select("package_id,options,recommended_option_id").eq("id", item.id).eq("user_id", userId).maybeSingle());
      if (!it) throw new Refusal("source_missing", 404);
      const pkg = await one<{ customer_name: string; customer_email: string | null; customer_phone: string | null; tax_percent: number }>(
        db.from("findings_packages").select("customer_name,customer_email,customer_phone,tax_percent").eq("id", it.package_id).eq("user_id", userId).maybeSingle());
      if (!pkg) throw new Refusal("source_missing", 404);
      const opts = Array.isArray(it.options) ? it.options : [];
      const chosen = opts.find((o) => o.id === it.recommended_option_id) ?? opts.find((o) => o.recommended) ?? opts[0];
      if (!chosen || !Array.isArray(chosen.line_items) || chosen.line_items.length === 0) throw new Refusal("no_option_lines");
      const q = await one<{ id: string }>(db.from("quotes").insert({
        user_id: userId, customer_name: pkg.customer_name, customer_email: pkg.customer_email, customer_phone: pkg.customer_phone,
        line_items: chosen.line_items, tax_percent: pkg.tax_percent, status: "draft",
      }).select("id").single());
      return { quoteId: q?.id };
    }

    case "invoice_correction": {
      const job = ev("jobs");
      if (!job) throw new Refusal("no_source_job");
      const j = await one<{ id: string; customer_name: string }>(db.from("jobs").select("id,customer_name").eq("id", job.id).eq("user_id", userId).maybeSingle());
      if (!j) throw new Refusal("source_missing", 404);
      const inv = await one<{ id: string }>(db.from("invoices").insert({
        user_id: userId, job_id: j.id, customer_name: j.customer_name, tax_percent: 0, status: "draft",
        line_items: [{ description: "Additional work / parts not previously invoiced", quantity: 1, unit_price_cents: leak.amount_cents }],
        notes: "Draft created from Revenue Radar. Review the lines and amount before sending.",
      }).select("id").single());
      return { invoiceId: inv?.id };
    }

    case "file_warranty_claim": {
      const c = ev("warranty_claims");
      if (!c) throw new Refusal("no_source_claim");
      const { data, error } = await db.from("warranty_claims").update({ status: "packet_pending" })
        .eq("id", c.id).eq("user_id", userId).eq("status", "eligible").select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Refusal("claim_not_eligible");
      return { claimId: c.id, previousStatus: "eligible" };
    }
  }
}

async function undo(db: Db, userId: string, action: Action): Promise<void> {
  const r = action.result ?? {};
  if (action.kind === "create_quote" && typeof r.quoteId === "string") {
    const { data, error } = await db.from("quotes").delete().eq("id", r.quoteId).eq("user_id", userId).eq("status", "draft").select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Refusal("already_sent_cannot_undo");
  } else if (action.kind === "invoice_correction" && typeof r.invoiceId === "string") {
    const { data, error } = await db.from("invoices").delete().eq("id", r.invoiceId).eq("user_id", userId).eq("status", "draft").select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Refusal("already_sent_cannot_undo");
  } else if (action.kind === "file_warranty_claim" && typeof r.claimId === "string") {
    const { data, error } = await db.from("warranty_claims").update({ status: "eligible" }).eq("id", r.claimId).eq("user_id", userId).eq("status", "packet_pending").select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Refusal("claim_moved_cannot_undo");
  }
}

// ------------------------------------------------------------------ handler

async function handle(db: Db, authUserId: string, ownerId: string, body: Record<string, unknown>) {
  const op = String(body.op ?? "");
  const leakId = String(body.leakId ?? "");
  if (!UUID.test(leakId)) throw new Refusal("invalid_leak", 400);
  const isOwner = authUserId === ownerId;

  const leak = await one<Leak>(db.from("revenue_leaks").select("id,user_id,detector,status,fix_kind,amount_cents,customer_name,evidence").eq("id", leakId).eq("user_id", ownerId).maybeSingle());
  if (!leak) throw new Refusal("not_found", 404);

  const live = () => one<Action>(db.from("revenue_leak_actions").select("id,leak_id,kind,status,payload,result").eq("leak_id", leakId).eq("user_id", ownerId).in("status", ["proposed", "approved", "executed"]).maybeSingle());
  const setLeak = (status: string) => db.from("revenue_leaks").update({ status }).eq("id", leakId).eq("user_id", ownerId);

  if (op === "propose") {
    if (!["open", "in_progress"].includes(leak.status)) throw new Refusal("leak_closed");
    if (!leak.fix_kind) throw new Refusal("no_fix_available");
    const draft = followupDraft({ detector: leak.detector as never, customerName: leak.customer_name });
    const { data, error } = await db.from("revenue_leak_actions").insert({
      user_id: ownerId, leak_id: leakId, kind: leak.fix_kind, status: "proposed", proposed_by: authUserId,
      payload: { amountCents: leak.amount_cents, draft },
    }).select("id,leak_id,kind,status,payload,result").single();
    if (error) throw new Refusal(error.code === "23505" ? "action_already_live" : "propose_failed"); // unique live-action index
    await setLeak("in_progress");
    return data;
  }

  if (op === "feedback" || op === "dismiss") {
    const verdict = op === "dismiss" ? null : String(body.verdict ?? "");
    if (op === "feedback" && verdict !== "false_positive" && verdict !== "true_positive") throw new Refusal("invalid_verdict", 400);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    if (verdict) {
      const { error } = await db.from("revenue_leak_feedback").insert({ user_id: ownerId, leak_id: leakId, detector: leak.detector, verdict, reason, created_by: authUserId });
      if (error) throw new Error(error.message);
    }
    if (op === "dismiss" || verdict === "false_positive") {
      const a = await live();
      if (a && a.status === "executed") throw new Refusal("undo_first");
      if (a) await db.from("revenue_leak_actions").update({ status: "rejected" }).eq("id", a.id).eq("user_id", ownerId);
      await setLeak(op === "dismiss" ? "dismissed" : "false_positive");
    }
    return { ok: true };
  }

  // Everything below changes records → owner only.
  if (!isOwner) throw new Refusal("owner_required", 403);
  const action = await live();
  const needAction = () => { if (!action) throw new Refusal("no_live_action", 404); return action; };

  if (op === "approve") {
    const a = needAction();
    if (a.status !== "proposed") throw new Refusal("not_proposed");
    const { data, error } = await db.from("revenue_leak_actions").update({ status: "approved", approved_by: authUserId, approved_at: new Date().toISOString() })
      .eq("id", a.id).eq("user_id", ownerId).eq("status", "proposed").select("id,leak_id,kind,status,payload,result");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Refusal("not_proposed");
    return data[0];
  }

  if (op === "reject") {
    const a = needAction();
    if (a.status === "executed") throw new Refusal("undo_first");
    await db.from("revenue_leak_actions").update({ status: "rejected" }).eq("id", a.id).eq("user_id", ownerId);
    await setLeak("open");
    return { ok: true };
  }

  if (op === "execute") {
    const a = needAction();
    if (a.status !== "approved") throw new Refusal("not_approved");
    // Atomic claim: only one caller can move approved → executed.
    const { data: claimed, error: ce } = await db.from("revenue_leak_actions").update({ status: "executed", executed_at: new Date().toISOString() })
      .eq("id", a.id).eq("user_id", ownerId).eq("status", "approved").select("id");
    if (ce) throw new Error(ce.message);
    if (!claimed?.length) throw new Refusal("not_approved");
    try {
      const result = await execute(db, ownerId, leak, a);
      const { data } = await db.from("revenue_leak_actions").update({ result }).eq("id", a.id).eq("user_id", ownerId).select("id,leak_id,kind,status,payload,result").single();
      return data;
    } catch (e) {
      await db.from("revenue_leak_actions").update({ status: "failed", executed_at: null, error: (e instanceof Error ? e.message : "failed").slice(0, 500) }).eq("id", a.id).eq("user_id", ownerId);
      await setLeak("open");
      throw e;
    }
  }

  if (op === "undo") {
    const a = needAction();
    if (a.status !== "executed") throw new Refusal("nothing_to_undo");
    await undo(db, ownerId, a);
    await db.from("revenue_leak_actions").update({ status: "undone", undone_at: new Date().toISOString() }).eq("id", a.id).eq("user_id", ownerId);
    await setLeak("open");
    return { ok: true };
  }

  throw new Refusal("unknown_op", 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: ownerId, error } = await authClient.rpc("get_account_owner_id");
    if (error || typeof ownerId !== "string") return json({ error: "account_not_found" }, 403);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return json({ ok: true, data: await handle(admin, user.id, ownerId, body) });
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.code }, e.http);
    console.error(JSON.stringify({ event: "rr_action_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "action_failed" }, 500);
  }
});
