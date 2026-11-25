// supabase/functions/dnc-registry-import/index.ts
//
// Import a Do-Not-Call registry list (a FILE the account obtained itself) into the account's tenant-scoped tables.
// Three steps so a big file can be sent in chunks and only goes live when complete:
//
//   { action: "create_list", jurisdiction: "US" | "US-TX", name, source_label?, version_label?, effective_date?, expires_at? }
//        -> { list_id }                       status "importing", not used by any dial path yet
//   { action: "add_numbers", list_id, text } -> counts            one number per line (optionally "number,note"), <= 10 000 rows per call
//   { action: "activate",    list_id, expected_rows? }            atomic: supersedes the previous active list of the same jurisdiction
//   { action: "discard",     list_id }                            drops an unfinished ("importing") list and its rows
//
// Security: caller must be signed in AND pass public.blocklist_can_manage(); the account is ALWAYS derived from the JWT
// (get_account_owner_id), never from the body. Writes use the service role only after those checks. Phone numbers are
// never logged. No registry is contacted: this function only stores what the user uploads.
//
// Deploy: supabase functions deploy dnc-registry-import   (verify_jwt stays ON)
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-provided).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { withCors } from "../_shared/http/cors.ts";
import { parseNumberList } from "../_shared/compliance/callBlockEngine.ts";
import { normalizeState } from "../_shared/compliance-rules/jurisdiction.ts";

const MAX_BODY_BYTES = 2_000_000;
const INSERT_CHUNK = 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, error: string) => json({ success: false, error }, status);

/** "US" stays "US"; "tx" / "US-tx" / "TX" -> "US-TX"; anything else -> null. */
export function normalizeJurisdiction(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (v === "US") return "US";
  const s = normalizeState(v);
  return s ? `US-${s}` : null;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  return t || null;
};
const isoDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

Deno.serve(withCors(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return fail(401, "Unauthorized");

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return fail(401, "Unauthorized");
  const actorId = userData.user.id;

  const [{ data: ownerId, error: ownerErr }, { data: canManage, error: permErr }] = await Promise.all([
    userClient.rpc("get_account_owner_id"),
    userClient.rpc("blocklist_can_manage"),
  ]);
  if (ownerErr || permErr || typeof ownerId !== "string") return fail(403, "Forbidden");
  if (canManage !== true) return fail(403, "You need number-management access to import registry lists.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "Payload too large; send at most 10 000 numbers per call.");
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return fail(400, "Invalid JSON"); }
  if (typeof body !== "object" || body === null) return fail(400, "Invalid JSON");

  const action = body.action;

  if (action === "create_list") {
    const jurisdiction = normalizeJurisdiction(body.jurisdiction);
    const name = clean(body.name, 120);
    if (!jurisdiction) return fail(422, "jurisdiction must be \"US\" or a US state code such as \"TX\".");
    if (!name) return fail(422, "name is required.");
    const expires = typeof body.expires_at === "string" && !Number.isNaN(Date.parse(body.expires_at)) ? new Date(body.expires_at).toISOString() : null;
    const { data, error } = await admin.from("dnc_registry_lists").insert({
      account_owner_id: ownerId, jurisdiction, name, source_label: clean(body.source_label, 200), version_label: clean(body.version_label, 80),
      effective_date: isoDate(body.effective_date), expires_at: expires, created_by: actorId,
    }).select("id").single();
    if (error || !data) return fail(500, "Could not create the list.");
    return json({ success: true, list_id: data.id, status: "importing" });
  }

  if (!isUuid(body.list_id)) return fail(422, "list_id is required.");
  const listId = body.list_id;
  // Tenant check: the list must belong to THIS account (service role bypasses RLS, so it is enforced here).
  const { data: list, error: listErr } = await admin.from("dnc_registry_lists").select("id, status").eq("id", listId).eq("account_owner_id", ownerId).maybeSingle();
  if (listErr) return fail(500, "Lookup failed.");
  if (!list) return fail(404, "List not found.");

  if (action === "add_numbers") {
    if (list.status !== "importing") return fail(409, "Only a list that is still importing can receive numbers.");
    if (typeof body.text !== "string" || !body.text.trim()) return fail(422, "text is required.");
    const parsed = parseNumberList(body.text, 10_000);
    if (parsed.valid.length === 0) return fail(422, "No valid numbers found.");
    for (let i = 0; i < parsed.valid.length; i += INSERT_CHUNK) {
      const rows = parsed.valid.slice(i, i + INSERT_CHUNK).map((r) => ({ list_id: listId, account_owner_id: ownerId, phone_e164: r.phone }));
      const { error } = await admin.from("dnc_registry_entries").upsert(rows, { onConflict: "list_id,phone_e164", ignoreDuplicates: true });
      if (error) return fail(500, "Could not store the numbers; the list is unchanged from the last successful chunk. Retry the same text.");
    }
    return json({
      success: true, accepted: parsed.valid.length, duplicates_in_text: parsed.duplicates, truncated: parsed.truncated,
      invalid: parsed.invalid.length, invalid_examples: parsed.invalid.slice(0, 20).map((x) => ({ line: x.line, reason: x.reason })),
    });
  }

  if (action === "activate") {
    const expected = Number.isInteger(body.expected_rows) && (body.expected_rows as number) > 0 ? (body.expected_rows as number) : null;
    const { data, error } = await admin.rpc("dnc_registry_activate", { p_list: listId, p_expected_rows: expected });
    if (error) {
      const m = error.message ?? "";
      if (m.includes("row_count_mismatch")) return fail(422, "Row count does not match what was uploaded.");
      if (m.includes("list_empty")) return fail(422, "The list has no numbers.");
      if (m.includes("list_too_large")) return fail(422, "The list is too large for one account list (limit 2 000 000).");
      if (m.includes("list_not_importing")) return fail(409, "The list is not in the importing state.");
      return fail(500, "Activation failed; the previous list (if any) is still in force.");
    }
    return json({ success: true, ...(data as Record<string, unknown>) });
  }

  if (action === "discard") {
    if (list.status !== "importing") return fail(409, "Only an unfinished import can be discarded.");
    const { error } = await admin.from("dnc_registry_lists").delete().eq("id", listId).eq("account_owner_id", ownerId).eq("status", "importing");
    if (error) return fail(500, "Could not discard the list.");
    return json({ success: true });
  }

  return fail(400, "Unknown action.");
}));
