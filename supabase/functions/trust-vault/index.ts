// supabase/functions/trust-vault/index.ts
//
// Opens sealed data for authorised users and runs vault maintenance.
//
// Actions (POST JSON):
//   USER (any account member who can already see the call under RLS)
//     { action: "open_field",     sealedId } -> { value }
//     { action: "open_recording", sealedId } -> binary (application/octet-stream; real type in X-Content-Type)
//   STAFF (profiles.is_staff)
//     { action: "migrate", userId, region?, isolation? } -> { moved, remaining, failed }
//        Moves a tenant's sealed items to its approved destination plane (no decryption).
//   SCHEDULER (header X-Cron-Secret = TRUST_CRON_SECRET)
//     { action: "purge_pending" } -> { purged, failed }   suggested: hourly
//
// Deploy: supabase functions deploy trust-vault

import { authenticate, audit, corsHeaders, cronAuthorized, json, readJson } from "../_shared/trust/http.ts";
import {
  VaultError, adminClient, currentTarget, migrateBatch, openField, openRecording, purgePending, type Target,
} from "../_shared/trust/vault.ts";
import { isRegionCode, isUuid } from "../../../src/lib/trustPack/regions.ts";

const STATUS: Record<VaultError["code"], number> = {
  NO_KEY: 409, KEY_UNAVAILABLE: 423, NOT_FOUND: 404, FORBIDDEN: 403, NOT_SEALABLE: 400, TOO_LARGE: 413,
  FETCH_FAILED: 502, PLANE_UNAVAILABLE: 503, INTEGRITY: 500, BAD_REQUEST: 400,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await readJson(req);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  try {
    // ------------------------------------------------------------ scheduler
    if (body.action === "purge_pending") {
      if (!cronAuthorized(req)) return json({ error: "Forbidden" }, 403);
      return json(await purgePending(adminClient(), { limit: 200 }));
    }

    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const { admin, caller, ownerId } = auth;

    // ------------------------------------------------------------ staff
    if (body.action === "migrate") {
      if (!auth.isStaff) return json({ error: "Staff only." }, 403);
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!isUuid(userId)) return json({ error: "Invalid userId" }, 400);

      // Destination = the approved region change if there is one, else the tenant's current plane
      // (used after a dedicated tenant is activated).
      let target: Target;
      const { data: approved } = await admin.from("residency_change_requests").select("to_region")
        .eq("user_id", userId).eq("status", "approved").maybeSingle();
      if (approved && isRegionCode(approved.to_region)) target = { region: approved.to_region, isolation: "shared" };
      else target = await currentTarget(admin, userId);

      const r = await migrateBatch(admin, userId, target, 25);
      await caller.rpc("log_audit_event", {
        p_user_id: userId, p_action: "migrated_sealed_data", p_target_table: "sealed_inventory", p_target_id: null,
        p_metadata: { to: target, moved: r.moved, remaining: r.remaining, failed: r.failed },
      });
      return json({ ...r, target });
    }

    // ------------------------------------------------------------ user reads
    if (body.action === "open_field" || body.action === "open_recording") {
      const sealedId = typeof body.sealedId === "string" ? body.sealedId : "";
      const opened = body.action === "open_field"
        ? await openField(admin, ownerId, sealedId)
        : await openRecording(admin, ownerId, sealedId);

      // The caller must be able to see the owning call under THEIR row-level security.
      const { data: visible } = await caller.from(opened.source.source_table).select("id").eq("id", opened.source.source_row_id).maybeSingle();
      if (!visible) return json({ error: "You do not have access to this item." }, 403);

      await audit(auth, body.action === "open_field" ? "opened_sealed_field" : "opened_sealed_recording", "sealed_inventory", opened.source.id);

      if ("value" in opened) return json({ value: opened.value });
      return new Response(opened.bytes as unknown as BodyInit, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/octet-stream", "X-Content-Type": opened.contentType, "Cache-Control": "no-store" },
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof VaultError) return json({ error: e.message, code: e.code }, STATUS[e.code] ?? 500);
    console.error("trust-vault error", e instanceof Error ? e.message : e);
    return json({ error: "Unexpected error" }, 500);
  }
});
