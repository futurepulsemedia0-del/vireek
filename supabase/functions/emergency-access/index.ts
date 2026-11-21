// Owner-incapacity emergency access: contact-facing API (JWT required).
// POST { action, ... }
//   my_designations                      -> what the signed-in user was designated for
//   accept       { contact_id }          -> bind the designation to this verified account
//   request      { contact_id, reason }  -> create request, e-mail a one-time code to the contact
//   verify       { request_id, code }    -> confirm the code; starts the mandatory waiting period
//   cancel       { request_id }
//   read         { request_id, scope, limit?, offset? }   (only after the grant opens)
//   export       { request_id, scope }                    -> CSV, audited
// Owner actions (designate / revoke / deny / audit view) are RPCs called from the dashboard directly.
// Secrets: EMERGENCY_CODE_PEPPER (>= 32 chars, required), RESEND_API_KEY (code e-mail).
// There is no write or payment capability anywhere in this function.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { generateCode, hashCode, MIN_PEPPER_LENGTH, normalizeCode } from "../_shared/emergency-access/codes.ts";
import { SCOPE_COLUMNS, toCsv } from "../_shared/emergency-access/csv.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const MAX_EXPORT_ROWS = 20_000;
const PAGE = 500;

// deno-lint-ignore no-explicit-any
function fail(e: any): Response {
  const code = String(e?.code ?? "");
  if (code === "42501") return json({ error: "Emergency access is not available for this request." }, 403);
  if (code === "53400") return json({ error: "Too many requests. Try again later." }, 429);
  if (code === "23505") return json({ error: "A request is already open." }, 409);
  if (code === "22023" || code === "23514") return json({ error: "Invalid input." }, 400);
  if (code === "P0002") return json({ error: "Not found." }, 404);
  console.error(JSON.stringify({ event: "emergency_access_failed", code, message: String(e?.message ?? e).slice(0, 200) }));
  return json({ error: "Something went wrong." }, 500);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    switch (action) {
      case "my_designations": {
        const { data, error } = await authClient.rpc("emergency_my_designations");
        return error ? fail(error) : json({ designations: data });
      }
      case "accept": {
        if (!isUuid(body.contact_id)) return json({ error: "Invalid input." }, 400);
        const { error } = await authClient.rpc("emergency_contact_accept", { p_contact_id: body.contact_id });
        return error ? fail(error) : json({ ok: true });
      }
      case "request": {
        const pepper = Deno.env.get("EMERGENCY_CODE_PEPPER") ?? "";
        if (pepper.length < MIN_PEPPER_LENGTH) { console.error(JSON.stringify({ event: "emergency_pepper_missing" })); return json({ error: "Emergency access is not configured." }, 503); }
        if (!isUuid(body.contact_id) || typeof body.reason !== "string") return json({ error: "Invalid input." }, 400);
        const requestId = crypto.randomUUID();
        const code = generateCode();
        const { data, error } = await db.rpc("emergency_request_create", {
          p_request_id: requestId, p_contact_id: body.contact_id, p_actor_id: user.id,
          p_reason: body.reason.slice(0, 2000), p_code_hash: await hashCode(pepper, requestId, code), p_code_ttl_minutes: 30,
        });
        if (error) return fail(error);
        const to = (Array.isArray(data) ? data[0] : data)?.contact_email as string | undefined;
        const sent = to ? await sendEmail(to, "Your Vireek emergency access code",
          `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>It expires in 30 minutes. If you did not request emergency access, ignore this message.</p>`,
          `Your Vireek verification code is ${code}. It expires in 30 minutes. If you did not request emergency access, ignore this message.`) : { ok: false };
        if (!sent.ok) {
          await authClient.rpc("emergency_request_cancel", { p_request_id: requestId }); // never leave a request nobody can verify
          return json({ error: "We could not send the verification code. Try again later." }, 502);
        }
        return json({ request_id: requestId, code_sent: true, code_valid_minutes: 30 });
      }
      case "verify": {
        const pepper = Deno.env.get("EMERGENCY_CODE_PEPPER") ?? "";
        if (pepper.length < MIN_PEPPER_LENGTH) return json({ error: "Emergency access is not configured." }, 503);
        const code = normalizeCode(body.code);
        if (!isUuid(body.request_id) || !code) return json({ error: "Invalid input." }, 400);
        const { data, error } = await db.rpc("emergency_request_verify", { p_request_id: body.request_id, p_actor_id: user.id, p_code_hash: await hashCode(pepper, body.request_id, code) });
        if (error) return fail(error);
        if (data === "verified") return json({ status: "waiting" });
        if (data === "locked") return json({ error: "Too many attempts. The request was cancelled." }, 429);
        if (data === "expired") return json({ error: "The code expired. Start a new request." }, 410);
        return json({ error: "That code is not correct." }, 400);
      }
      case "cancel": {
        if (!isUuid(body.request_id)) return json({ error: "Invalid input." }, 400);
        const { error } = await authClient.rpc("emergency_request_cancel", { p_request_id: body.request_id });
        return error ? fail(error) : json({ ok: true });
      }
      case "read": {
        if (!isUuid(body.request_id) || typeof body.scope !== "string") return json({ error: "Invalid input." }, 400);
        const { data, error } = await authClient.rpc("emergency_read", {
          p_request_id: body.request_id, p_scope: body.scope,
          p_limit: Math.min(Number(body.limit) || 100, PAGE), p_offset: Math.max(Number(body.offset) || 0, 0),
        });
        return error ? fail(error) : json(data);
      }
      case "export": {
        const scope = typeof body.scope === "string" ? body.scope : "";
        const columns = SCOPE_COLUMNS[scope];
        if (!isUuid(body.request_id) || !columns) return json({ error: "Invalid input." }, 400);
        const rows: Array<Record<string, unknown>> = [];
        let total = 0;
        for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += PAGE) {
          const { data, error } = await authClient.rpc("emergency_read", { p_request_id: body.request_id, p_scope: scope, p_limit: PAGE, p_offset: offset });
          if (error) return fail(error);
          total = Number(data.total);
          rows.push(...(data.rows as Array<Record<string, unknown>>));
          if (rows.length >= total || (data.rows as unknown[]).length < PAGE) break;
        }
        const { error: logErr } = await authClient.rpc("emergency_log_export", { p_request_id: body.request_id, p_scope: scope, p_rows: rows.length, p_format: "csv" });
        if (logErr) return fail(logErr);
        return json({ filename: `vireek-emergency-${scope}.csv`, content_type: "text/csv; charset=utf-8", csv: toCsv(columns, rows), rows: rows.length, total, truncated: rows.length < total });
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    return fail(e);
  }
});
