// supabase/functions/mcp-server/index.ts
//
// Vireek Agent Network — one governed door for external AI agents.
//
//   POST /mcp-server        MCP (Model Context Protocol) over Streamable HTTP, JSON responses
//   POST /mcp-server/a2a    A2A (Agent2Agent) JSON-RPC: message/send, tasks/get, tasks/cancel
//   GET  /mcp-server/a2a/agent-card   public A2A agent card (also served at /.well-known/agent-card.json via vercel.json)
//
// Auth: Authorization: Bearer vrk_agent_...  (Dashboard > Agent Network). Per-tool scopes,
// expiry, 60 calls/min and a daily quota are enforced in agent_network_begin().
//
// Safety model
//   * Every query is pinned to the key's owner (user_id) — a key can never see another business.
//   * Reads are narrow: one customer by exact id/phone/email, never "list all".
//   * Every WRITE goes through authorizeAgentAction() (Agent Governance) and defaults to
//     "needs human approval". Writes require an idempotency_key; the same key never repeats an action.
//   * Every call is recorded in agent_network_calls.
//
// Deploy:  supabase functions deploy mcp-server --no-verify-jwt

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { authorizeAgentAction, recordAgentActionOutcome } from "../_shared/governance/agentGovernance.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import { stripeRequest } from "../_shared/stripe/client.ts";
import {
  RPC, parseRpcBody, rpcError, rpcResult, mcpInitializeResult, mcpToolsList, mcpToolResult,
  buildAgentCard, a2aTask, a2aSkillListMessage, extractA2aInvocation, type RpcRequest, type ToolOutcome,
} from "../_shared/agent-network/protocol.ts";
import {
  getTool, hasScope, canonicalJson, escapeLike, quoteTotals, computeAvailability, summarizeStock,
  type ToolDef, type QuoteLine,
} from "../_shared/agent-network/tools.ts";

const MAX_BODY_BYTES = 64 * 1024;
const AGENT_SOURCE = "mcp-server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Ctx {
  admin: SupabaseClient;
  ownerId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  protocol: "mcp" | "a2a";
  siteUrl: string;
}

interface CallResult {
  outcome: ToolOutcome;
  /** agent_network_calls.status */
  status: string;
  callId: string | null;
}

const err = (code: string, message: string): ToolOutcome => ({ ok: false, code, message });

// ------------------------------------------------------------------
// Call log
// ------------------------------------------------------------------

async function logCall(
  ctx: Ctx, def: ToolDef, args: unknown,
  fields: { status: string; errorCode?: string; latencyMs?: number; result?: unknown },
): Promise<string | null> {
  try {
    const { data, error } = await ctx.admin.from("agent_network_calls").insert({
      user_id: ctx.ownerId, client_id: ctx.clientId, protocol: ctx.protocol, tool: def.name, is_write: def.write,
      args_hash: await sha256Hex(canonicalJson(args)),
      args: def.write ? args : {},
      status: fields.status, error_code: fields.errorCode ?? null, latency_ms: fields.latencyMs ?? null,
      result: fields.result ?? null,
    }).select("id").single();
    if (error) throw error;
    return data.id as string;
  } catch (e) {
    console.error(JSON.stringify({ event: "agent_network_log_failed", tool: def.name, error: String((e as Error)?.message ?? e) }));
    return null;
  }
}

// ------------------------------------------------------------------
// Read tools
// ------------------------------------------------------------------

const CUSTOMER_COLS = "id, name, phone, email, address, customer_type, lifecycle_stage, tags, last_contacted_at, created_at";

async function runRead(ctx: Ctx, def: ToolDef, a: Record<string, unknown>): Promise<ToolOutcome> {
  const db = ctx.admin;
  const owner = ctx.ownerId;

  switch (def.name) {
    case "get_customer": {
      let q = db.from("customers").select(CUSTOMER_COLS).eq("user_id", owner).limit(2);
      if (a.customer_id) q = q.eq("id", a.customer_id as string);
      else if (a.phone) q = q.in("phone", [...new Set([String(a.phone).trim(), normalizePhone(String(a.phone))])]);
      else q = q.ilike("email", escapeLike(String(a.email)));
      const { data, error } = await q;
      if (error) return err("query_failed", "Could not look up the customer.");
      if (!data || data.length === 0) return err("not_found", "No matching customer.");
      if (data.length > 1) return err("ambiguous", "More than one customer matches; use customer_id.");
      return { ok: true, data: { customer: data[0] } };
    }

    case "get_equipment": {
      let q = db.from("equipment")
        .select("id, equipment_type, make, model, serial_number, install_date, warranty_expires_at, status, expected_lifespan_years, service_interval_months, last_service_date")
        .eq("user_id", owner).eq("customer_id", a.customer_id as string)
        .order("created_at", { ascending: false }).limit(50);
      if (a.status !== "all") q = q.eq("status", a.status as string);
      const { data, error } = await q;
      if (error) return err("query_failed", "Could not load equipment.");
      return { ok: true, data: { equipment: data ?? [] } };
    }

    case "get_job": {
      const { data, error } = await db.from("jobs")
        .select("id, customer_name, service_type, address, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status, customer_type, created_at")
        .eq("user_id", owner).eq("id", a.job_id as string).maybeSingle();
      if (error) return err("query_failed", "Could not load the job.");
      if (!data) return err("not_found", "Job not found.");
      let technician: { id: string; name: string | null } | null = null;
      if (data.assigned_technician_id) {
        const { data: t } = await db.from("team_members").select("id, member_name")
          .eq("account_owner_id", owner).eq("id", data.assigned_technician_id).maybeSingle();
        if (t) technician = { id: t.id, name: t.member_name };
      }
      return { ok: true, data: { job: data, technician } };
    }

    case "check_schedule": {
      const from = a.from as string;
      const to = a.to as string;
      let jq = db.from("jobs").select("id, scheduled_datetime, job_status, assigned_technician_id, service_type")
        .eq("user_id", owner).gte("scheduled_datetime", from).lt("scheduled_datetime", to)
        .order("scheduled_datetime", { ascending: true }).limit(500);
      let tq = db.from("team_members").select("id, member_name, max_jobs_per_day")
        .eq("account_owner_id", owner).eq("role", "technician").eq("invite_status", "active").eq("dispatch_enabled", true).limit(100);
      if (a.technician_id) {
        jq = jq.eq("assigned_technician_id", a.technician_id as string);
        tq = tq.eq("id", a.technician_id as string);
      }
      const [{ data: jobs, error: je }, { data: techs, error: te }] = await Promise.all([jq, tq]);
      if (je || te) return err("query_failed", "Could not load the schedule.");
      const list = jobs ?? [];
      return {
        ok: true,
        data: {
          from, to,
          jobs: list.slice(0, 200),
          truncated: list.length > 200,
          technicians: computeAvailability(list, techs ?? [], from, to),
          note: "Days are UTC calendar days; capacity counts scheduled, en_route and in_progress jobs.",
        },
      };
    }

    case "check_inventory": {
      let pq = db.from("inventory_parts").select("id, part_number, name, unit_label, reorder_point")
        .eq("user_id", owner).eq("active", true).limit(20);
      pq = a.part_number ? pq.eq("part_number", a.part_number as string) : pq.ilike("name", `%${escapeLike(String(a.query))}%`);
      const { data: parts, error: pe } = await pq;
      if (pe) return err("query_failed", "Could not search inventory.");
      if (!parts || parts.length === 0) return { ok: true, data: { parts: [] } };
      const ids = parts.map((p: { id: string }) => p.id);
      const [{ data: levels, error: le }, { data: locs, error: lce }] = await Promise.all([
        db.from("inventory_stock_levels").select("part_id, location_id, quantity_on_hand, quantity_reserved").eq("user_id", owner).in("part_id", ids),
        db.from("inventory_locations").select("id, name, location_type, active").eq("user_id", owner),
      ]);
      if (le || lce) return err("query_failed", "Could not load stock levels.");
      return { ok: true, data: { parts: summarizeStock(parts, levels ?? [], locs ?? []) } };
    }

    default:
      return err("unknown_tool", "Unknown tool.");
  }
}

// ------------------------------------------------------------------
// Write tools: preflight (validate against real data BEFORE asking a human)
// ------------------------------------------------------------------

interface Preflight {
  error?: ToolOutcome;
  /** Plain-language context shown to the human approver (Agent Governance). */
  human: Record<string, unknown>;
}

async function preflight(ctx: Ctx, def: ToolDef, a: Record<string, unknown>): Promise<Preflight> {
  const db = ctx.admin;
  const owner = ctx.ownerId;

  switch (def.name) {
    case "create_quote": {
      const t = quoteTotals(a.line_items as QuoteLine[], a.tax_percent as number);
      return { human: { customer: a.customer_name, line_items: (a.line_items as unknown[]).length, total_cents: t.totalCents } };
    }
    case "dispatch_technician": {
      const [{ data: job }, { data: tech }] = await Promise.all([
        db.from("jobs").select("id, customer_name, service_type, scheduled_datetime, job_status").eq("user_id", owner).eq("id", a.job_id as string).maybeSingle(),
        db.from("team_members").select("id, member_name").eq("account_owner_id", owner).eq("id", a.technician_id as string).eq("role", "technician").maybeSingle(),
      ]);
      if (!job) return { error: err("not_found", "Job not found."), human: {} };
      if (!tech) return { error: err("not_found", "Technician not found."), human: {} };
      return {
        human: {
          job: `${job.service_type ?? "Job"} for ${job.customer_name}`, scheduled: job.scheduled_datetime,
          technician: tech.member_name, reason: a.reason ?? null,
        },
      };
    }
    case "send_customer_message": {
      const { data: c } = await db.from("customers").select("id, name, phone").eq("user_id", owner).eq("id", a.customer_id as string).maybeSingle();
      if (!c) return { error: err("not_found", "Customer not found."), human: {} };
      if (!c.phone) return { error: err("no_phone", "This customer has no phone number on file."), human: {} };
      return { human: { customer: c.name, channel: "sms", message: a.body } };
    }
    case "collect_payment": {
      const { data: job } = await db.from("jobs").select("id, customer_name, service_type, invoice_amount").eq("user_id", owner).eq("id", a.job_id as string).maybeSingle();
      if (!job) return { error: err("not_found", "Job not found."), human: {} };
      if (!job.invoice_amount || Number(job.invoice_amount) <= 0) return { error: err("no_invoice_amount", "Set an invoice amount on this job first."), human: {} };
      const { data: connect } = await db.from("stripe_connect_accounts").select("charges_enabled").eq("user_id", owner).maybeSingle();
      if (!connect?.charges_enabled) return { error: err("payments_not_ready", "The business has not finished connecting Stripe."), human: {} };
      return { human: { customer: job.customer_name, job: job.service_type, amount_usd: Number(job.invoice_amount) } };
    }
    default:
      return { error: err("unknown_tool", "Unknown tool."), human: {} };
  }
}

// ------------------------------------------------------------------
// Write tools: execution (only ever reached after governance approval)
// ------------------------------------------------------------------

async function execWrite(ctx: Ctx, def: ToolDef, a: Record<string, unknown>): Promise<ToolOutcome> {
  const db = ctx.admin;
  const owner = ctx.ownerId;

  switch (def.name) {
    case "create_quote": {
      const lines = a.line_items as QuoteLine[];
      const totals = quoteTotals(lines, a.tax_percent as number);
      const validUntil = new Date(Date.now() + (a.valid_days as number) * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await db.from("quotes").insert({
        user_id: owner,
        customer_name: a.customer_name,
        customer_phone: a.customer_phone ?? null,
        customer_email: a.customer_email ?? null,
        line_items: lines,
        tax_percent: a.tax_percent,
        status: "draft",
        valid_until: validUntil,
      }).select("id").single();
      if (error || !data) return err("insert_failed", "Could not create the quote.");
      return {
        ok: true,
        data: {
          quote_id: data.id, status: "draft", valid_until: validUntil,
          subtotal_cents: totals.subtotalCents, tax_cents: totals.taxCents, total_cents: totals.totalCents,
          note: "Draft only. A person reviews and sends it from Vireek.",
        },
      };
    }

    case "dispatch_technician": {
      const { data, error } = await db.rpc("agent_network_assign_technician", {
        p_owner: owner, p_job_id: a.job_id, p_technician_id: a.technician_id,
      });
      if (error || !data) return err("assign_failed", "Could not assign the technician.");
      if (data.status !== "assigned") return err(String(data.status), String(data.reason ?? "Could not assign the technician."));
      return { ok: true, data: data as Record<string, unknown> };
    }

    case "send_customer_message": {
      const { data: c } = await db.from("customers").select("id, phone").eq("user_id", owner).eq("id", a.customer_id as string).maybeSingle();
      if (!c?.phone) return err("no_phone", "This customer has no phone number on file.");
      const res = await sendCompliantSms(db, owner, c.phone, String(a.body));
      if (!res.ok) return err(res.reason.toLowerCase(), res.detail ? `${res.reason}: ${res.detail}` : res.reason);
      await db.from("customers").update({ last_contacted_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", owner);
      return { ok: true, data: { sent: true, channel: "sms", customer_id: c.id } };
    }

    case "collect_payment": {
      const { data: job } = await db.from("jobs").select("id, customer_name, service_type, invoice_amount").eq("user_id", owner).eq("id", a.job_id as string).maybeSingle();
      if (!job || !job.invoice_amount || Number(job.invoice_amount) <= 0) return err("no_invoice_amount", "Set an invoice amount on this job first.");

      // Reuse an open payment link instead of creating a second one for the same job.
      const { data: open } = await db.from("payment_requests").select("id, amount, payment_link_url, status")
        .eq("user_id", owner).eq("job_id", job.id).in("status", ["pending", "sent"]).not("payment_link_url", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (open?.payment_link_url) {
        return { ok: true, data: { payment_request_id: open.id, amount: Number(open.amount), payment_link_url: open.payment_link_url, reused: true } };
      }

      const { data: connect } = await db.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", owner).maybeSingle();
      const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (!connect?.stripe_account_id || !connect.charges_enabled) return err("payments_not_ready", "The business has not finished connecting Stripe.");
      if (!secretKey) return err("payments_not_configured", "Payments are not configured on this server.");

      // No customer phone/email is stored on the request on purpose: this tool only creates the
      // link, it never contacts the customer (that is send_customer_message, separately governed).
      const { data: pr, error: pe } = await db.from("payment_requests")
        .insert({ user_id: owner, job_id: job.id, customer_name: job.customer_name, amount: job.invoice_amount, status: "pending" })
        .select("id").single();
      if (pe || !pr) return err("insert_failed", "Could not create the payment request.");

      try {
        const description = job.service_type ? `${job.service_type} — ${job.customer_name}` : `Invoice for ${job.customer_name}`;
        const session = await stripeRequest("checkout/sessions", {
          mode: "payment",
          success_url: `${ctx.siteUrl}/pay-result?status=success`,
          cancel_url: `${ctx.siteUrl}/pay-result?status=cancel`,
          line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(Number(job.invoice_amount) * 100), product_data: { name: description } } }],
          payment_intent_data: { transfer_data: { destination: connect.stripe_account_id } },
          metadata: { payment_request_id: pr.id, job_id: job.id, user_id: owner },
        }, secretKey);
        await db.from("payment_requests").update({ stripe_checkout_session_id: session.id, payment_link_url: session.url }).eq("id", pr.id);
        return { ok: true, data: { payment_request_id: pr.id, amount: Number(job.invoice_amount), payment_link_url: session.url, reused: false } };
      } catch (e) {
        await db.from("payment_requests").update({ status: "failed" }).eq("id", pr.id);
        console.error(JSON.stringify({ event: "agent_network_stripe_failed", error: String((e as Error)?.message ?? e) }));
        return err("stripe_failed", "The payment provider rejected the request.");
      }
    }

    default:
      return err("unknown_tool", "Unknown tool.");
  }
}

// ------------------------------------------------------------------
// Write orchestration: idempotency -> preflight -> governance -> claim -> execute
// ------------------------------------------------------------------

interface CallRow {
  id: string;
  tool: string;
  is_write: boolean;
  args: Record<string, unknown>;
  args_hash: string;
  status: string;
  result: Record<string, unknown> | null;
  error_code: string | null;
  created_at: string;
}

const CALL_COLS = "id, tool, is_write, args, args_hash, status, result, error_code, created_at";

function rowOutcome(row: CallRow): CallResult {
  const base = { call_id: row.id, tool: row.tool, status: row.status, created_at: row.created_at };
  switch (row.status) {
    case "executed":
      return { status: row.status, callId: row.id, outcome: { ok: true, data: { ...base, result: row.result ?? {} } } };
    case "ok":
      return { status: row.status, callId: row.id, outcome: { ok: true, data: { ...base, result: row.result ?? {} } } };
    case "pending_approval":
    case "received":
      return {
        status: "pending_approval", callId: row.id,
        outcome: {
          ok: true,
          data: {
            ...base, status: "pending_approval",
            message: "A person must approve this action in Vireek (Dashboard > Agent Governance). After approval, call get_action_status with this call_id to run it and receive the result.",
          },
        },
      };
    case "executing":
      return { status: row.status, callId: row.id, outcome: { ok: true, data: base } };
    case "rejected":
      return { status: row.status, callId: row.id, outcome: err("rejected", "This action was rejected by the business.") };
    case "canceled":
      return { status: row.status, callId: row.id, outcome: err("canceled", "This action was canceled.") };
    default: {
      const r = row.result ?? {};
      return { status: row.status, callId: row.id, outcome: err(String(r.code ?? row.error_code ?? "failed"), String(r.message ?? "The action failed.")) };
    }
  }
}

async function setStatus(ctx: Ctx, id: string, patch: Record<string, unknown>, onlyFrom?: string[]): Promise<boolean> {
  let q = ctx.admin.from("agent_network_calls").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("client_id", ctx.clientId);
  if (onlyFrom) q = q.in("status", onlyFrom);
  const { data, error } = await q.select("id");
  return !error && !!data && data.length > 0;
}

async function fetchRow(ctx: Ctx, id: string): Promise<CallRow | null> {
  const { data } = await ctx.admin.from("agent_network_calls").select(CALL_COLS).eq("id", id).eq("client_id", ctx.clientId).maybeSingle();
  return (data as CallRow | null) ?? null;
}

async function advance(ctx: Ctx, def: ToolDef, row: CallRow): Promise<CallResult> {
  if (!["received", "pending_approval"].includes(row.status)) return rowOutcome(row);

  const pf = await preflight(ctx, def, row.args);
  if (pf.error && !pf.error.ok) {
    await setStatus(ctx, row.id, { status: "failed", error_code: pf.error.code, result: { code: pf.error.code, message: pf.error.message } }, ["received", "pending_approval"]);
    return { status: "failed", callId: row.id, outcome: pf.error };
  }

  let auth;
  try {
    auth = await authorizeAgentAction(ctx.admin, {
      userId: ctx.ownerId,
      actionSlug: def.actionSlug!,
      agentSource: AGENT_SOURCE,
      targetTable: "agent_network_calls",
      targetId: row.id,
      reasoning: `External agent "${ctx.clientName}" via ${ctx.protocol.toUpperCase()} requested: ${def.title}`,
      payload: { ...pf.human, client: ctx.clientName, protocol: ctx.protocol },
      correlationId: row.id,
    });
  } catch {
    // Fails closed: no governance answer means no action.
    return { status: "error", callId: row.id, outcome: err("governance_unavailable", "Could not reach the approval system. Nothing was executed; retry later.") };
  }

  await ctx.admin.from("agent_network_calls").update({ governance_log_id: auth.logId }).eq("id", row.id).eq("client_id", ctx.clientId);

  if (auth.decision === "pending_approval") {
    await setStatus(ctx, row.id, { status: "pending_approval" }, ["received", "pending_approval"]);
    return rowOutcome({ ...row, status: "pending_approval" });
  }
  if (auth.decision === "rejected") {
    await setStatus(ctx, row.id, { status: "rejected", error_code: "rejected" }, ["received", "pending_approval"]);
    return rowOutcome({ ...row, status: "rejected" });
  }

  // approved / auto_approved: claim exactly once, then execute.
  const claimed = await setStatus(ctx, row.id, { status: "executing" }, ["received", "pending_approval"]);
  if (!claimed) {
    const current = await fetchRow(ctx, row.id);
    return current ? rowOutcome(current) : { status: "error", callId: row.id, outcome: err("not_found", "Call not found.") };
  }

  let outcome: ToolOutcome;
  try {
    outcome = await execWrite(ctx, def, row.args);
  } catch (e) {
    console.error(JSON.stringify({ event: "agent_network_exec_failed", tool: def.name, error: String((e as Error)?.message ?? e) }));
    outcome = err("internal_error", "The action failed unexpectedly.");
  }

  if (outcome.ok) {
    await setStatus(ctx, row.id, { status: "executed", result: outcome.data });
    await recordAgentActionOutcome(ctx.admin, auth.logId, { status: "executed", afterState: { call_id: row.id, tool: def.name } });
    return { status: "executed", callId: row.id, outcome: { ok: true, data: { call_id: row.id, tool: def.name, status: "executed", result: outcome.data } } };
  }
  await setStatus(ctx, row.id, { status: "failed", error_code: outcome.code, result: { code: outcome.code, message: outcome.message } });
  await recordAgentActionOutcome(ctx.admin, auth.logId, { status: "failed", error: `${outcome.code}: ${outcome.message}` });
  return { status: "failed", callId: row.id, outcome };
}

async function processWrite(ctx: Ctx, def: ToolDef, args: Record<string, unknown>): Promise<CallResult> {
  const key = args.idempotency_key as string;
  const argsHash = await sha256Hex(canonicalJson(args));

  const find = async () => {
    const { data } = await ctx.admin.from("agent_network_calls").select(CALL_COLS)
      .eq("client_id", ctx.clientId).eq("tool", def.name).eq("idempotency_key", key).maybeSingle();
    return (data as CallRow | null) ?? null;
  };

  let row = await find();
  if (row) {
    if (row.args_hash !== argsHash) {
      return { status: "error", callId: row.id, outcome: err("idempotency_conflict", "This idempotency_key was already used with different arguments. Use a new key.") };
    }
    return advance(ctx, def, row);
  }

  // First time: reject junk before bothering a human.
  const pf = await preflight(ctx, def, args);
  if (pf.error && !pf.error.ok) {
    const id = await logCall(ctx, def, args, { status: "error", errorCode: pf.error.code });
    return { status: "error", callId: id, outcome: pf.error };
  }

  const { data: ins, error: insErr } = await ctx.admin.from("agent_network_calls").insert({
    user_id: ctx.ownerId, client_id: ctx.clientId, protocol: ctx.protocol, tool: def.name, is_write: true,
    idempotency_key: key, args_hash: argsHash, args, status: "received",
  }).select(CALL_COLS).single();

  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      row = await find(); // lost a race with an identical concurrent request
      if (row && row.args_hash === argsHash) return advance(ctx, def, row);
    }
    return { status: "error", callId: null, outcome: err("log_failed", "Could not record the request. Nothing was executed.") };
  }
  return advance(ctx, def, ins as CallRow);
}

// ------------------------------------------------------------------
// get_action_status
// ------------------------------------------------------------------

async function getActionStatus(ctx: Ctx, args: Record<string, unknown>): Promise<CallResult> {
  const row = await fetchRow(ctx, args.call_id as string);
  if (!row) return { status: "error", callId: null, outcome: err("not_found", "No such call for this key.") };
  if (row.is_write && ["received", "pending_approval"].includes(row.status)) {
    const def = getTool(row.tool);
    if (def && hasScope(ctx.scopes, def)) return advance(ctx, def, row);
  }
  return rowOutcome(row);
}

// ------------------------------------------------------------------
// Dispatcher shared by MCP and A2A
// ------------------------------------------------------------------

type Invoke = { kind: "unknown_tool" } | { kind: "done"; result: CallResult };

async function invoke(ctx: Ctx, name: string, rawArgs: unknown): Promise<Invoke> {
  const def = getTool(name);
  if (!def || !hasScope(ctx.scopes, def)) return { kind: "unknown_tool" };
  const t0 = Date.now();

  const v = def.validate(rawArgs ?? {});
  if (!v.ok) {
    await logCall(ctx, def, {}, { status: "error", errorCode: "invalid_arguments", latencyMs: Date.now() - t0 });
    return { kind: "done", result: { status: "error", callId: null, outcome: err("invalid_arguments", v.error) } };
  }
  const args = v.value;

  try {
    if (def.name === "get_action_status") {
      const result = await getActionStatus(ctx, args);
      await logCall(ctx, def, args, { status: result.outcome.ok ? "ok" : "error", errorCode: result.outcome.ok ? undefined : result.outcome.code, latencyMs: Date.now() - t0 });
      return { kind: "done", result };
    }
    if (def.write) return { kind: "done", result: await processWrite(ctx, def, args) };

    const outcome = await runRead(ctx, def, args);
    const summary = outcome.ok
      ? Object.fromEntries(Object.entries(outcome.data).filter(([, x]) => Array.isArray(x)).map(([k, x]) => [`${k}_count`, (x as unknown[]).length]))
      : null;
    const callId = await logCall(ctx, def, args, {
      status: outcome.ok ? "ok" : "error", errorCode: outcome.ok ? undefined : outcome.code,
      latencyMs: Date.now() - t0, result: summary,
    });
    return { kind: "done", result: { status: outcome.ok ? "ok" : "error", callId, outcome } };
  } catch (e) {
    console.error(JSON.stringify({ event: "agent_network_tool_failed", tool: name, error: String((e as Error)?.message ?? e) }));
    return { kind: "done", result: { status: "error", callId: null, outcome: err("internal_error", "Something went wrong. Nothing was changed.") } };
  }
}

// ------------------------------------------------------------------
// MCP
// ------------------------------------------------------------------

async function handleMcp(ctx: Ctx, rpc: RpcRequest): Promise<Record<string, unknown> | null> {
  const isNotification = rpc.id === undefined;
  const id = rpc.id ?? null;
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

  switch (rpc.method) {
    case "initialize":
      return rpcResult(id, mcpInitializeResult(params.protocolVersion));
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, mcpToolsList(ctx.scopes));
    case "tools/call": {
      if (typeof params.name !== "string") return rpcError(id, RPC.INVALID_PARAMS, "params.name is required");
      const r = await invoke(ctx, params.name, params.arguments);
      if (r.kind === "unknown_tool") return rpcError(id, RPC.INVALID_PARAMS, `Unknown tool: ${params.name.slice(0, 64)}`);
      return rpcResult(id, mcpToolResult(r.result.outcome));
    }
    default:
      return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${rpc.method.slice(0, 64)}`);
  }
}

// ------------------------------------------------------------------
// A2A
// ------------------------------------------------------------------

function taskFromResult(r: CallResult, contextId: string) {
  const data = r.outcome.ok ? r.outcome.data : { error: r.outcome.code, message: r.outcome.message };
  const statusText =
    r.status === "pending_approval" ? "Waiting for a person at the business to approve this action."
      : !r.outcome.ok ? r.outcome.message : undefined;
  return a2aTask({ id: r.callId ?? crypto.randomUUID(), contextId, status: r.status, data, statusText });
}

async function handleA2a(ctx: Ctx, rpc: RpcRequest): Promise<Record<string, unknown> | null> {
  if (rpc.id === undefined) return null;
  const id = rpc.id;
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  switch (rpc.method) {
    case "message/send": {
      const message = params.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") return rpcError(id, RPC.INVALID_PARAMS, "params.message is required");
      const contextId = typeof message.contextId === "string" && message.contextId.length <= 100 ? message.contextId : crypto.randomUUID();
      const inv = extractA2aInvocation(message);
      if (!inv) return rpcResult(id, a2aSkillListMessage(ctx.scopes));
      const r = await invoke(ctx, inv.skill, inv.args);
      if (r.kind === "unknown_tool") return rpcError(id, RPC.INVALID_PARAMS, `Unknown skill: ${inv.skill.slice(0, 64)}`);
      return rpcResult(id, taskFromResult(r.result, contextId));
    }
    case "tasks/get": {
      const taskId = params.id;
      if (typeof taskId !== "string") return rpcError(id, RPC.INVALID_PARAMS, "params.id is required");
      const v = getTool("get_action_status")!.validate({ call_id: taskId });
      if (!v.ok) return rpcError(id, RPC.TASK_NOT_FOUND, "Task not found");
      const r = await getActionStatus(ctx, v.value);
      if (r.callId === null) return rpcError(id, RPC.TASK_NOT_FOUND, "Task not found");
      return rpcResult(id, taskFromResult(r, crypto.randomUUID()));
    }
    case "tasks/cancel": {
      const taskId = params.id;
      if (typeof taskId !== "string") return rpcError(id, RPC.INVALID_PARAMS, "params.id is required");
      const v = getTool("get_action_status")!.validate({ call_id: taskId });
      const row = v.ok ? await fetchRow(ctx, v.value.call_id as string) : null;
      if (!row) return rpcError(id, RPC.TASK_NOT_FOUND, "Task not found");
      if (!["received", "pending_approval"].includes(row.status)) return rpcError(id, RPC.TASK_NOT_CANCELABLE, "Task can no longer be canceled");
      const ok = await setStatus(ctx, row.id, { status: "canceled" }, ["received", "pending_approval"]);
      if (!ok) return rpcError(id, RPC.TASK_NOT_CANCELABLE, "Task can no longer be canceled");
      return rpcResult(id, taskFromResult(rowOutcome({ ...row, status: "canceled" }), crypto.randomUUID()));
    }
    case "message/stream":
    case "tasks/resubscribe":
    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
      return rpcError(id, RPC.UNSUPPORTED_OPERATION, "Streaming and push notifications are not supported; poll tasks/get.");
    default:
      return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${rpc.method.slice(0, 64)}`);
  }
}

// ------------------------------------------------------------------
// HTTP entry
// ------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const path = new URL(req.url).pathname.replace(/^\/mcp-server/, "").replace(/\/+$/, "") || "/";
  const isCard = ["/a2a/agent-card", "/agent-card", "/.well-known/agent-card.json"].includes(path);

  if (req.method === "GET" && isCard) {
    return json(buildAgentCard({ endpointUrl: `${supabaseUrl}/functions/v1/mcp-server/a2a`, siteUrl }), 200, { "Cache-Control": "public, max-age=300" });
  }

  const protocol: "mcp" | "a2a" | null = path === "/" || path === "/mcp" ? "mcp" : path === "/a2a" ? "a2a" : null;
  if (!protocol) return json({ error: "Not found" }, 404);
  if (req.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC 2.0 messages." }, 405, { Allow: "POST, OPTIONS" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(rpcError(null, RPC.INVALID_REQUEST, "Request too large"), 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json(rpcError(null, RPC.INVALID_REQUEST, "Request too large"), 413);

  // ---- Authenticate ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const unauthorized = (msg: string) =>
    json({ error: msg }, 401, { "WWW-Authenticate": 'Bearer realm="vireek-agent-network"' });
  if (!rawKey.startsWith("vrk_agent_") || rawKey.length > 200) return unauthorized("Missing or invalid agent key. Use: Authorization: Bearer vrk_agent_...");

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: gate, error: gateErr } = await admin.rpc("agent_network_begin", { p_key_hash: await sha256Hex(rawKey) });
  if (gateErr || !gate) return json({ error: "Service unavailable" }, 503);
  if (!gate.ok) {
    if (gate.reason === "rate_limited" || gate.reason === "quota_exceeded") {
      return json({ error: gate.reason }, 429, { "Retry-After": String(gate.retry_after ?? 30) });
    }
    return unauthorized("Invalid, revoked or expired agent key");
  }

  const ctx: Ctx = {
    admin, ownerId: gate.user_id, clientId: gate.client_id, clientName: gate.name,
    scopes: Array.isArray(gate.scopes) ? gate.scopes : [], protocol, siteUrl,
  };

  // ---- Dispatch ----
  const parsed = parseRpcBody(text);
  if (parsed.kind === "invalid") return json(rpcError(null, parsed.error.code, parsed.error.message), 400);

  const handler = protocol === "mcp" ? handleMcp : handleA2a;
  const responses: Record<string, unknown>[] = [];
  for (const item of parsed.items) {
    if ("invalid" in item) {
      responses.push(rpcError(item.id, RPC.INVALID_REQUEST, "Invalid Request"));
      continue;
    }
    try {
      const res = await handler(ctx, item);
      if (res) responses.push(res);
    } catch (e) {
      console.error(JSON.stringify({ event: "agent_network_unhandled", method: item.method, error: String((e as Error)?.message ?? e) }));
      if (item.id !== undefined) responses.push(rpcError(item.id, RPC.INTERNAL_ERROR, "Internal error"));
    }
  }

  if (responses.length === 0) return new Response(null, { status: 202, headers: corsHeaders });
  return json(parsed.batch ? responses : responses[0]);
});
