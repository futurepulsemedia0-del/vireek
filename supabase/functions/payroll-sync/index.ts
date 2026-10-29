// supabase/functions/payroll-sync/index.ts
//
// All payroll-provider actions after connecting. Every call needs the user's JWT and can_manage_payroll_sync().
//
//   { action: "employees",  connectionId }                     list provider employees + store unconfirmed name suggestions
//   { action: "payrolls",   connectionId, start, end }         open (unprocessed) provider payrolls covering a period
//   { action: "run",        batchId, payrollId? }              send an APPROVED batch (claim -> push -> record -> finish)
//   { action: "disconnect", connectionId }                     delete tokens, cancel unsent batches
//
// Same secrets as payroll-connect. NOT LIVE-VERIFIED: see the notes in _shared/payroll/gusto.ts.
// Deploy: supabase functions deploy payroll-sync

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ProviderError,
  PROVIDER_ERROR_COPY,
  isProviderLive,
  runSync,
  suggestLinks,
  type ClaimedBatch,
  type LineOutcome,
  type SyncStore,
} from "../_shared/payroll/engine.ts";
import { createGustoAdapter, gustoBase } from "../_shared/payroll/gusto.ts";
import { createTokenManager } from "../_shared/payroll/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,80}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header." }, 401);
    const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const { data: ownerData } = await caller.rpc("get_account_owner_id");
    const owner = ownerData as string | null;
    if (!owner) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_payroll_sync");
    if (allowed !== true) return json({ error: "You don't have permission to manage payroll integrations." }, 403);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const encKey = Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY") ?? "";
    const clientId = Deno.env.get("GUSTO_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET") ?? "";
    if (!encKey || !clientId || !clientSecret) return json({ error: "The payroll provider isn't configured on the server yet." }, 500);

    const connectionFor = async (id: unknown) => {
      if (typeof id !== "string" || !UUID.test(id)) return null;
      const { data } = await admin.from("payroll_connections").select("id, user_id, provider, environment, status, external_company_id").eq("id", id).eq("user_id", owner).maybeSingle();
      return data as { id: string; provider: string; environment: "production" | "sandbox"; status: string; external_company_id: string | null } | null;
    };
    const adapterFor = (c: { id: string; environment: "production" | "sandbox"; external_company_id: string | null }) => {
      const tokens = createTokenManager({
        admin: admin as never, connectionId: c.id, owner, encKey, clientId, clientSecret, environment: c.environment,
        redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/payroll-connect`,
      });
      return createGustoAdapter({ fetch, baseUrl: gustoBase(c.environment), companyId: c.external_company_id ?? "", ...tokens });
    };
    const providerFail = (e: unknown) => {
      if (e instanceof ProviderError) return json({ error: e.detail ? `${e.message} (${e.detail})` : e.message, code: e.code }, e.code === "unauthorized" ? 401 : 502);
      throw e;
    };

    switch (body.action) {
      case "employees": {
        const conn = await connectionFor(body.connectionId);
        if (!conn || conn.status === "disconnected") return json({ error: "Payroll connection not found." }, 404);
        if (!isProviderLive(conn.provider as never) || !conn.external_company_id) return json({ error: "That payroll provider is not available yet." }, 400);
        try {
          const external = await adapterFor(conn).listEmployees();
          const [{ data: emps }, { data: links }] = await Promise.all([
            admin.from("employees").select("id, full_name").eq("user_id", owner).eq("active", true),
            admin.from("payroll_employee_links").select("employee_id, external_employee_id").eq("connection_id", conn.id),
          ]);
          const suggestions = suggestLinks(
            (emps ?? []) as { id: string; full_name: string }[],
            external,
            new Set((links ?? []).map((l) => l.employee_id as string)),
            new Set((links ?? []).map((l) => l.external_employee_id as string)),
          );
          if (suggestions.length > 0) await admin.rpc("payroll_sync_suggest_links", { p_owner: owner, p_connection_id: conn.id, p_suggestions: suggestions });
          await admin.from("payroll_connections").update({ status: "connected", last_error: null, last_verified_at: new Date().toISOString() }).eq("id", conn.id);
          return json({ employees: external.filter((e) => !e.terminated).map((e) => ({ id: e.id, name: e.name, email: e.email })), suggested: suggestions.length });
        } catch (e) {
          return providerFail(e);
        }
      }

      case "payrolls": {
        const conn = await connectionFor(body.connectionId);
        if (!conn || conn.status !== "connected") return json({ error: "Payroll connection not found." }, 404);
        if (typeof body.start !== "string" || typeof body.end !== "string" || !DAY.test(body.start) || !DAY.test(body.end)) return json({ error: "Invalid period." }, 400);
        try {
          return json({ payrolls: await adapterFor(conn).listOpenPayrolls(body.start, body.end) });
        } catch (e) {
          return providerFail(e);
        }
      }

      case "run": {
        if (typeof body.batchId !== "string" || !UUID.test(body.batchId)) return json({ error: "Invalid batch." }, 400);
        const payrollId = typeof body.payrollId === "string" && body.payrollId ? body.payrollId : null;
        if (payrollId && !PROVIDER_ID.test(payrollId)) return json({ error: "Invalid provider payroll." }, 400);

        const { data: claimedRaw, error: claimErr } = await admin.rpc("payroll_sync_claim", { p_owner: owner, p_batch_id: body.batchId });
        if (claimErr || !claimedRaw) {
          const msg = claimErr?.message ?? "Could not start the send.";
          return json({ error: msg.replace(/^sync_in_progress:\s*/, "") }, /sync_in_progress/.test(msg) ? 409 : 400);
        }
        const claimed = claimedRaw as ClaimedBatch;
        const conn = await connectionFor(claimed.batch.connection_id);
        const store: SyncStore = {
          async record(o: LineOutcome) {
            await admin.rpc("payroll_sync_record_line", {
              p_owner: owner, p_batch_id: claimed.batch.id, p_line_id: o.line_id, p_status: o.status,
              p_external_ref: o.external_ref ?? null, p_error_code: o.error_code ?? null, p_error_message: o.error_message ?? null,
            });
          },
          async finish(error, externalPayrollId) {
            const { data } = await admin.rpc("payroll_sync_finish", { p_owner: owner, p_batch_id: claimed.batch.id, p_error: error, p_external_payroll_id: externalPayrollId });
            return String(data ?? "failed");
          },
        };
        if (!conn || !isProviderLive(conn.provider as never) || !conn.external_company_id) {
          for (const l of claimed.lines) await store.record({ line_id: l.line_id, status: "failed", error_code: "unavailable", error_message: "This payroll provider is not available yet." });
          const status = await store.finish("This payroll provider is not available yet.", null);
          return json({ status, error: "This payroll provider is not available yet." });
        }
        try {
          const result = await runSync(claimed, adapterFor(conn), store, payrollId);
          return json({ status: result.status, error: result.error, counts: result.counts, payroll: result.payroll });
        } catch (e) {
          // runSync records everything it can; this only fires if the store itself failed. Release the lock.
          console.error(JSON.stringify({ event: "payroll_sync_run_failed", batch: claimed.batch.id, error: e instanceof Error ? e.message : String(e) }));
          await admin.rpc("payroll_sync_finish", { p_owner: owner, p_batch_id: claimed.batch.id, p_error: PROVIDER_ERROR_COPY.server_error, p_external_payroll_id: null });
          return json({ error: "The send was interrupted. Open the batch to see which lines were recorded, then send again." }, 500);
        }
      }

      case "disconnect": {
        const conn = await connectionFor(body.connectionId);
        if (!conn) return json({ error: "Payroll connection not found." }, 404);
        const { data, error } = await admin.rpc("payroll_sync_disconnect", { p_owner: owner, p_connection_id: conn.id });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, cancelledBatches: data ?? 0 });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "payroll_sync_unhandled", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
