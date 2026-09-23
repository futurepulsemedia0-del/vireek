// supabase/functions/data-retention-sweep/index.ts
//
// Scheduled job (suggested: daily). Two jobs in one pass:
//
//   1. RETENTION POLICIES — for every data_retention_policies row with
//      auto_delete_enabled = true and legal_hold = false, delete (or
//      anonymize) rows in the matching dataset table older than
//      retention_days.
//   2. DELETION REQUESTS — for every deletion_requests row whose grace
//      period has elapsed (scheduled_for <= now, status = 'grace_period'),
//      execute the erasure (full account / one customer / one dataset)
//      and mark it completed.
//
// Both paths defer to has_active_legal_hold() and never touch a held
// account — this is enforced twice (once by the DB trigger on insert,
// once here again defensively in case a hold was placed mid-grace-period).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { OWNED_TABLES } from "../_shared/compliance/ownedTables.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const summary = { policiesSwept: 0, rowsAffected: 0, deletionRequestsProcessed: 0, errors: [] as string[] };

  // ---------- 1. Retention policies ----------
  const { data: policies, error: policiesError } = await admin
    .from("data_retention_policies")
    .select("*")
    .eq("auto_delete_enabled", true)
    .eq("legal_hold", false);

  if (policiesError) summary.errors.push(`load policies: ${policiesError.message}`);

  for (const policy of policies ?? []) {
    try {
      const owned = OWNED_TABLES.find((t) => t.table === policy.dataset);
      if (!owned?.dateColumn) {
        summary.errors.push(`dataset "${policy.dataset}" is not sweepable (unknown table or no date column)`);
        continue;
      }
      if (!policy.retention_days) continue;

      // Defensive re-check: a hold placed after this row was loaded.
      const stillClear = !(await admin.rpc("has_active_legal_hold", {
        p_user_id: policy.user_id,
        p_dataset: policy.dataset,
      })).data;
      if (!stillClear) continue;

      const cutoff = new Date(Date.now() - policy.retention_days * 86_400_000).toISOString();

      if (policy.anonymize_instead_of_delete && owned.pii?.length) {
        const patch: Record<string, null> = {};
        for (const col of owned.pii) patch[col] = null;
        const { data: rows, error } = await admin
          .from(owned.table)
          .update(patch)
          .eq("user_id", policy.user_id)
          .lt(owned.dateColumn, cutoff)
          .select("id");
        if (error) throw error;
        summary.rowsAffected += rows?.length ?? 0;
      } else {
        const { data: rows, error } = await admin
          .from(owned.table)
          .delete()
          .eq("user_id", policy.user_id)
          .lt(owned.dateColumn, cutoff)
          .select("id");
        if (error) throw error;
        summary.rowsAffected += rows?.length ?? 0;
      }

      await admin
        .from("data_retention_policies")
        .update({ last_swept_at: new Date().toISOString() })
        .eq("id", policy.id);

      await admin.rpc("log_audit_event", {
        p_user_id: policy.user_id,
        p_action: "retention_sweep_applied",
        p_target_table: policy.dataset,
        p_target_id: null,
      });

      summary.policiesSwept += 1;
    } catch (err) {
      summary.errors.push(`policy ${policy.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- 2. Due deletion requests ----------
  const { data: dueRequests, error: dueError } = await admin
    .from("deletion_requests")
    .select("*")
    .eq("status", "grace_period")
    .lte("scheduled_for", new Date().toISOString());

  if (dueError) summary.errors.push(`load deletion_requests: ${dueError.message}`);

  for (const request of dueRequests ?? []) {
    try {
      const stillClear = !(await admin.rpc("has_active_legal_hold", {
        p_user_id: request.user_id,
        p_dataset: request.target_dataset,
      })).data;
      if (!stillClear) {
        await admin.from("deletion_requests").update({ status: "blocked_legal_hold" }).eq("id", request.id);
        continue;
      }

      await admin.from("deletion_requests").update({ status: "processing" }).eq("id", request.id);

      let result: Record<string, number> = {};

      if (request.request_type === "full_account") {
        for (const owned of OWNED_TABLES) {
          const { data: rows, error } = await admin
            .from(owned.table)
            .delete()
            .eq("user_id", request.user_id)
            .select("id");
          if (error) throw error;
          result[owned.table] = rows?.length ?? 0;
        }
      } else if (request.request_type === "customer_record" && request.target_customer_id) {
        // Anonymize, don't delete — jobs/quotes/payment history tied to a
        // customer are financial/legal records, not just contact data.
        const custPatch = { name: "Redacted Customer", phone: null, email: null, address: null, notes: null };
        const { error: custErr } = await admin
          .from("customers")
          .update(custPatch)
          .eq("id", request.target_customer_id)
          .eq("user_id", request.user_id);
        if (custErr) throw custErr;
        for (const table of ["leads", "calls"] as const) {
          const owned = OWNED_TABLES.find((t) => t.table === table);
          if (!owned?.pii) continue;
          const patch: Record<string, null> = {};
          for (const col of owned.pii) patch[col] = null;
          const { data: rows, error } = await admin
            .from(table)
            .update(patch)
            .eq("customer_id", request.target_customer_id)
            .eq("user_id", request.user_id)
            .select("id");
          if (error) throw error;
          result[table] = rows?.length ?? 0;
        }
        result["customers"] = 1;
      } else if (request.request_type === "dataset" && request.target_dataset) {
        const owned = OWNED_TABLES.find((t) => t.table === request.target_dataset);
        if (!owned) throw new Error(`unknown dataset "${request.target_dataset}"`);
        const { data: rows, error } = await admin
          .from(owned.table)
          .delete()
          .eq("user_id", request.user_id)
          .select("id");
        if (error) throw error;
        result[owned.table] = rows?.length ?? 0;
      }

      await admin
        .from("deletion_requests")
        .update({ status: "completed", completed_at: new Date().toISOString(), result })
        .eq("id", request.id);

      await admin.rpc("log_audit_event", {
        p_user_id: request.user_id,
        p_action: `deletion_request_completed:${request.request_type}`,
        p_target_table: "deletion_requests",
        p_target_id: request.id,
      });

      summary.deletionRequestsProcessed += 1;
    } catch (err) {
      summary.errors.push(`request ${request.id}: ${err instanceof Error ? err.message : String(err)}`);
      await admin.from("deletion_requests").update({ status: "grace_period" }).eq("id", request.id);
    }
  }

  return json(summary, summary.errors.length ? 207 : 200);
});
