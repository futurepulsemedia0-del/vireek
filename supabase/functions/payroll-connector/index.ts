// supabase/functions/payroll-connector/index.ts
//
// Server side of /dashboard/payroll-connectors for the Gusto API connection (the file providers
// ADP / Paychex / Rippling need no server: files are rendered in the browser from the saved export).
//
// Actions (POST JSON, caller must hold a user JWT and can_manage_payroll_connectors()):
//   { action: "oauth_start", provider: "gusto" }                      -> { url }
//   { action: "select_company", connection_id, company_id }           -> { ok }
//   { action: "list_employees", connection_id }                       -> { employees: [{id,name,email,jobId,terminated}] }
//   { action: "deliver", export_id, overwrite_existing?: boolean }    -> { status, counts, lines }
//   { action: "disconnect", connection_id }                           -> { ok }
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET   Gusto developer app > Client ID / Secret
//   PAYROLL_STATE_SECRET                    $(openssl rand -hex 32)      signs the OAuth `state` (10 minutes)
//   PAYROLL_TOKEN_ENCRYPTION_KEY            $(openssl rand -base64 32)   AES-256 key for tokens at rest
//   SITE_URL                                https://vireek.com
// OPTIONAL:
//   GUSTO_ENVIRONMENT                       "production" (default) or "sandbox" (api.gusto-demo.com)
//   GUSTO_API_VERSION                       pins X-Gusto-API-Version (default in engine.ts)
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() and filters every query on top of the service-role client.
//   - Tokens are AES-GCM encrypted at rest and only ever sent to the allow-listed Gusto hosts.
//   - Delivery SETS values (never adds), so retrying is idempotent. Different non-zero values already in Gusto are
//     left alone unless the owner explicitly ticks "overwrite".
//   - One delivery per export at a time (compare-and-set lock with a 5-minute expiry).
//
// Deploy: supabase functions deploy payroll-connector

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { decryptSecret, encryptSecret, signOAuthState } from "../_shared/quickbooks/engine.ts";
import {
  GUSTO_DEFAULT_API_VERSION,
  GUSTO_MAX_COMPENSATIONS_PER_REQUEST,
  buildGustoAuthorizeUrl,
  buildGustoTokenRequest,
  chunk,
  classifyGustoStatus,
  gustoBaseFor,
  gustoErrorMessage,
  gustoHeaders,
  isAllowedGustoBase,
  normalizeLine,
  parseGustoEmployees,
  parseGustoTokens,
  pickGustoPayroll,
  planGustoUpdates,
  type ExportLine,
  type GustoEmployeeComp,
  type GustoEnvironment,
  type LineOutcome,
} from "../_shared/payroll-connectors/engine.ts";

// deno-lint-ignore no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const LOCK_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
class GustoAuthError extends Error {}

interface ConnRow {
  id: string;
  user_id: string;
  mode: string;
  status: string;
  environment: GustoEnvironment;
  external_company_id: string | null;
  meta: { companies?: { id: string; name: string }[] } | null;
}

interface GustoCtx {
  admin: AnyClient;
  conn: ConnRow;
  base: string;
  version: string;
  encKey: string;
  token: string;
}

// ------------------------------------------------------------------
// Gusto HTTP
// ------------------------------------------------------------------

async function gustoFetch(ctx: GustoCtx, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
  if (!isAllowedGustoBase(ctx.base)) throw new Error("Blocked: not a Gusto host.");
  const res = await fetch(`${ctx.base}${path}`, {
    method: init.method ?? "GET",
    headers: gustoHeaders(ctx.token, ctx.version),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 401) throw new GustoAuthError("Gusto rejected the saved connection.");
  return { status: res.status, json: body, headers: res.headers };
}

/** Returns a valid access token, refreshing (and rotating the stored refresh token) when it is about to expire. */
async function loadToken(admin: AnyClient, conn: ConnRow, base: string, encKey: string): Promise<string> {
  const read = () => admin.from("payroll_connection_secrets").select("access_token_enc, refresh_token_enc, expires_at, updated_at").eq("connection_id", conn.id).maybeSingle();
  const { data: sec } = await read();
  if (!sec) throw new GustoAuthError("This Gusto connection has no saved credentials. Reconnect Gusto.");
  const expires = sec.expires_at ? Date.parse(sec.expires_at as string) : 0;
  if (expires && expires - Date.now() > 60_000) return await decryptSecret(sec.access_token_enc as string, encKey);

  const clientId = Deno.env.get("GUSTO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) throw new HttpError(500, "Gusto isn't configured on the server yet. Ask your administrator to set the Gusto secrets.");
  const refreshToken = await decryptSecret(sec.refresh_token_enc as string, encKey);
  const req = buildGustoTokenRequest("refresh", { base, clientId, clientSecret, refreshToken });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Gusto rotates refresh tokens: a concurrent request may have just refreshed. Use its result if so.
    const { data: again } = await read();
    if (again && again.updated_at !== sec.updated_at) return await decryptSecret(again.access_token_enc as string, encKey);
    throw new GustoAuthError("Gusto no longer accepts this connection. Reconnect Gusto.");
  }
  const t = parseGustoTokens(body);
  await admin.from("payroll_connection_secrets").upsert(
    {
      connection_id: conn.id,
      user_id: conn.user_id,
      access_token_enc: await encryptSecret(t.accessToken, encKey),
      refresh_token_enc: await encryptSecret(t.refreshToken ?? refreshToken, encKey),
      expires_at: t.expiresInSec ? new Date(Date.now() + t.expiresInSec * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" },
  );
  return t.accessToken;
}

async function openGusto(admin: AnyClient, conn: ConnRow): Promise<GustoCtx> {
  const encKey = Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY") ?? "";
  if (!encKey) throw new HttpError(500, "Gusto isn't configured on the server yet. Ask your administrator to set the Gusto secrets.");
  const base = gustoBaseFor(conn.environment === "sandbox" ? "sandbox" : "production");
  const token = await loadToken(admin, conn, base, encKey);
  return { admin, conn, base, version: Deno.env.get("GUSTO_API_VERSION") || GUSTO_DEFAULT_API_VERSION, encKey, token };
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

async function getConnection(admin: AnyClient, ownerId: string, id: unknown): Promise<ConnRow> {
  if (typeof id !== "string" || !UUID.test(id)) throw new HttpError(400, "Invalid connection.");
  const { data } = await admin
    .from("payroll_connections")
    .select("id, user_id, mode, status, environment, external_company_id, meta")
    .eq("id", id)
    .eq("user_id", ownerId)
    .eq("provider", "gusto")
    .maybeSingle();
  if (!data) throw new HttpError(404, "Connection not found.");
  return data as ConnRow;
}

async function oauthStart(ownerId: string, userId: string) {
  const clientId = Deno.env.get("GUSTO_CLIENT_ID");
  const stateSecret = Deno.env.get("PAYROLL_STATE_SECRET");
  if (!clientId || !stateSecret || !Deno.env.get("GUSTO_CLIENT_SECRET") || !Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY")) {
    throw new HttpError(500, "Gusto isn't configured on the server yet. Ask your administrator to set the Gusto secrets.");
  }
  const env: GustoEnvironment = Deno.env.get("GUSTO_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
  const state = await signOAuthState({ owner: ownerId, user: userId }, stateSecret);
  return {
    url: buildGustoAuthorizeUrl({
      base: gustoBaseFor(env),
      clientId,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/payroll-connector-oauth-callback`,
      state,
    }),
  };
}

async function selectCompany(admin: AnyClient, ownerId: string, body: Record<string, unknown>) {
  const conn = await getConnection(admin, ownerId, body.connection_id);
  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!UUID.test(companyId)) throw new HttpError(400, "A Gusto company ID is a UUID.");
  const name = conn.meta?.companies?.find((c) => c.id === companyId)?.name ?? null;
  const { error } = await admin.from("payroll_connections").update({ external_company_id: companyId, company_name: name, last_error: null }).eq("id", conn.id);
  if (error) throw error;
  return { ok: true };
}

async function listEmployees(admin: AnyClient, ownerId: string, body: Record<string, unknown>) {
  const conn = await getConnection(admin, ownerId, body.connection_id);
  if (conn.mode !== "api" || !conn.external_company_id) throw new HttpError(409, "Connect Gusto and choose a company first.");
  const ctx = await openGusto(admin, conn);
  const all: ReturnType<typeof parseGustoEmployees> = [];
  for (let page = 1; page <= 20; page++) {
    const r = await gustoFetch(ctx, `/v1/companies/${conn.external_company_id}/employees?page=${page}&per=100`);
    if (classifyGustoStatus(r.status) !== "ok") throw new HttpError(502, gustoErrorMessage(r.json, `Gusto returned ${r.status} while loading employees.`));
    const batch = parseGustoEmployees(r.json);
    all.push(...batch);
    if (!Array.isArray(r.json) || (r.json as unknown[]).length < 100) break;
  }
  return { employees: all };
}

async function disconnect(admin: AnyClient, ownerId: string, body: Record<string, unknown>) {
  const conn = await getConnection(admin, ownerId, body.connection_id);
  await admin.from("payroll_connection_secrets").delete().eq("connection_id", conn.id);
  const { error } = await admin
    .from("payroll_connections")
    .update({ mode: "file", status: "connected", external_company_id: null, company_name: null, meta: {}, last_error: null })
    .eq("id", conn.id);
  if (error) throw error;
  return { ok: true };
}

interface LineRow extends ExportLine {
  row_id: string;
}

async function deliver(admin: AnyClient, ownerId: string, userId: string, body: Record<string, unknown>) {
  const exportId = body.export_id;
  if (typeof exportId !== "string" || !UUID.test(exportId)) throw new HttpError(400, "Invalid export.");
  const overwrite = body.overwrite_existing === true;

  // Compare-and-set lock: only a ready / failed / partial export (or one whose lock expired) can start.
  const lockUntil = new Date(Date.now() + LOCK_MS).toISOString();
  const { data: locked } = await admin
    .from("payroll_exports")
    .update({ status: "delivering", lock_until: lockUntil, last_error: null })
    .eq("id", exportId)
    .eq("user_id", ownerId)
    .eq("delivery", "api")
    .eq("provider", "gusto")
    .or(`status.in.(ready,failed,partial),and(status.eq.delivering,lock_until.lt.${new Date().toISOString()})`)
    .select("id, connection_id, period_start, period_end")
    .maybeSingle();
  if (!locked) throw new HttpError(409, "This export can't be sent right now (already sent, in progress, voided or not an API export).");

  await admin.from("payroll_export_events").insert({ user_id: ownerId, export_id: exportId, event: "delivery_started", message: overwrite ? "overwrite on" : null, actor: userId });

  const finish = async (status: "delivered" | "partial" | "failed", error: string | null, externalRef: string | null) => {
    await admin
      .from("payroll_exports")
      .update({
        status,
        last_error: error,
        lock_until: null,
        ...(status !== "failed" ? { delivered_at: new Date().toISOString(), delivered_by: userId } : {}),
        ...(externalRef ? { external_ref: externalRef } : {}),
      })
      .eq("id", exportId);
    await admin.from("payroll_export_events").insert({
      user_id: ownerId,
      export_id: exportId,
      event: status === "delivered" ? "delivered" : status === "partial" ? "delivery_partial" : "delivery_failed",
      message: error,
      actor: userId,
    });
  };

  try {
    const { data: connData } = await admin
      .from("payroll_connections")
      .select("id, user_id, mode, status, environment, external_company_id, meta")
      .eq("id", locked.connection_id as string)
      .eq("user_id", ownerId)
      .maybeSingle();
    const conn = connData as ConnRow | null;
    if (!conn || conn.mode !== "api" || conn.status !== "connected" || !conn.external_company_id) {
      throw new HttpError(409, "Gusto isn't connected (or no company is selected). Reconnect in the Connections tab.");
    }
    const ctx = await openGusto(admin, conn);
    const cid = conn.external_company_id;

    const { data: rows } = await admin
      .from("payroll_export_lines")
      .select("id, employee_id, employee_name, external_id, external_job_id, regular_hours, overtime_hours, commission_cents, tip_cents")
      .eq("export_id", exportId);
    const lines: LineRow[] = (rows ?? []).map((r: Record<string, unknown>) => ({ ...normalizeLine(r), row_id: String(r.id) }));
    if (!lines.length) throw new HttpError(409, "This export has no lines.");

    const start = locked.period_start as string;
    const end = locked.period_end as string;
    const list = await gustoFetch(
      ctx,
      `/v1/companies/${cid}/payrolls?processing_statuses=unprocessed&payroll_types=regular&start_date=${start}&end_date=${end}`,
    );
    if (classifyGustoStatus(list.status) !== "ok") throw new HttpError(502, gustoErrorMessage(list.json, `Gusto returned ${list.status} while looking for the payroll.`));
    const payroll = pickGustoPayroll(list.json, start, end);
    if (!payroll) {
      throw new HttpError(409, `No open regular payroll in Gusto for ${start} to ${end}. Create that pay period in Gusto first (or change the export dates), then try again.`);
    }

    const loadComps = async (): Promise<unknown> => {
      const r = await gustoFetch(ctx, `/v1/companies/${cid}/payrolls/${payroll.id}?include=employee_compensations`);
      if (classifyGustoStatus(r.status) !== "ok") throw new HttpError(502, gustoErrorMessage(r.json, `Gusto returned ${r.status} while reading the payroll.`));
      return (r.json as Record<string, unknown> | null)?.employee_compensations ?? [];
    };

    const plan = planGustoUpdates(lines, await loadComps(), { overwrite });
    const byExternal = new Map(lines.map((l) => [l.external_id.toLowerCase(), l] as const));
    const outcomes = plan.outcomes;
    const setOutcome = (u: GustoEmployeeComp, o: LineOutcome) => {
      const l = byExternal.get(u.employee_uuid.toLowerCase());
      if (l) outcomes.set(l.employee_id, o);
    };

    const put = (updates: GustoEmployeeComp[]) =>
      gustoFetch(ctx, `/v1/companies/${cid}/payrolls/${payroll.id}`, { method: "PUT", body: { employee_compensations: updates } });

    // One employee, one retry on a stale version (409), so a single bad row never blocks the batch.
    const putOne = async (u: GustoEmployeeComp) => {
      let attempt = u;
      for (let i = 0; i < 2; i++) {
        const r = await put([attempt]);
        const kind = classifyGustoStatus(r.status);
        if (kind === "ok") return setOutcome(u, { status: "pending", message: "Sent to Gusto." });
        if (kind === "conflict" && i === 0) {
          const l = byExternal.get(u.employee_uuid.toLowerCase());
          const fresh = l ? planGustoUpdates([l], await loadComps(), { overwrite }) : null;
          const next = fresh?.updates[0];
          if (!next) return setOutcome(u, { status: "unchanged", message: "Gusto already has these values." });
          attempt = next;
          continue;
        }
        if (kind === "throttle") return setOutcome(u, { status: "error", message: "Gusto is rate-limiting requests. Try again in a minute." });
        return setOutcome(u, { status: "error", message: gustoErrorMessage(r.json, `Gusto returned ${r.status}.`) });
      }
    };

    for (const group of chunk(plan.updates, GUSTO_MAX_COMPENSATIONS_PER_REQUEST)) {
      const r = await put(group);
      if (classifyGustoStatus(r.status) === "ok") {
        for (const u of group) setOutcome(u, { status: "pending", message: "Sent to Gusto." });
      } else {
        // Isolate the failing employee(s) instead of failing the whole batch.
        for (const u of group) await putOne(u);
      }
    }

    // Persist per-line results. "pending" here means "sent" (the PUT succeeded).
    const counts = { sent: 0, unchanged: 0, conflict: 0, error: 0 };
    const resultLines = [];
    for (const l of lines) {
      const o = outcomes.get(l.employee_id) ?? { status: "error" as const, message: "Not processed." };
      const status = o.status === "pending" ? "sent" : o.status;
      counts[status as keyof typeof counts]++;
      resultLines.push({ employee_id: l.employee_id, status, message: o.message });
      await admin.from("payroll_export_lines").update({ delivery_status: status, delivery_message: o.message }).eq("id", l.row_id);
    }

    const done = counts.sent + counts.unchanged;
    const status = counts.conflict + counts.error === 0 ? "delivered" : done > 0 ? "partial" : "failed";
    const errorText = status === "delivered" ? null : `${counts.conflict} left untouched, ${counts.error} failed. Review the lines and send again.`;
    await finish(status, errorText, payroll.id);
    if (done > 0) await admin.from("payroll_connections").update({ last_exported_at: new Date().toISOString(), last_error: null }).eq("id", conn.id);
    return { status, counts, lines: resultLines };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GustoAuthError) {
      await admin.from("payroll_connections").update({ status: "error", last_error: message }).eq("id", locked.connection_id as string);
    }
    await finish("failed", message.slice(0, 500), null);
    throw error;
  }
}

// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

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
    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_payroll_connectors");
    if (allowed !== true) return json({ error: "You don't have permission to manage payroll connectors." }, 403);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const owner = ownerId as string;
    const uid = userData.user.id;

    switch (body.action) {
      case "oauth_start":
        if (body.provider !== "gusto") return json({ error: "Only Gusto uses a live connection." }, 400);
        return json(await oauthStart(owner, uid));
      case "select_company":
        return json(await selectCompany(admin, owner, body));
      case "list_employees":
        return json(await listEmployees(admin, owner, body));
      case "deliver":
        return json(await deliver(admin, owner, uid, body));
      case "disconnect":
        return json(await disconnect(admin, owner, body));
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof GustoAuthError) return json({ error: error.message }, 502);
    console.error(JSON.stringify({ event: "payroll_connector_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: error instanceof Error && error.message ? error.message.slice(0, 300) : "Something went wrong." }, 500);
  }
});
