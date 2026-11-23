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
// 3. ERASURE CERTIFICATES — after a full_account erasure completes, a signed deletion certificate is issued
//    (supabase/functions/_shared/compliance/erasureCertificate.ts). Missing certificates are backfilled on
//    later runs. A certificate failure never reverts or re-opens a completed erasure.
//
// Both paths defer to has_active_legal_hold() and never touch a held
// account — this is enforced twice (once by the DB trigger on insert,
// once here again defensively in case a hold was placed mid-grace-period).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { OWNED_TABLES } from "../_shared/compliance/ownedTables.ts";
import { eraseProviderData } from "../_shared/compliance/providerErasure.ts";
import { sweepOwnedRows, type SweepRpcClient } from "../_shared/compliance/sweepBatches.ts";
import { eraseTrustPackData } from "../_shared/trust/vault.ts";
import { loadSigningKeys, parseBackupRetentionDays, type ErasureBaseline, type ErasureEvidence } from "../_shared/compliance/erasureCertificate.ts";
import { issueErasureCertificate, issueMissingCertificates, recordErasureEvidence } from "../_shared/compliance/erasureCertificateIssuer.ts";
import erasureBaseline from "../../../docs/compliance/erasure-coverage-baseline.json" with { type: "json" };

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

   const summary = { policiesSwept: 0, rowsAffected: 0, deletionRequestsProcessed: 0, certificatesIssued: 0, errors: [] as string[] };

  const signingKeys = loadSigningKeys((n) => Deno.env.get(n));
  const certOpts = () => ({
    baseline: erasureBaseline as unknown as ErasureBaseline,
    signingKey: signingKeys.current,
    backupRetentionDays: parseBackupRetentionDays(Deno.env.get("BACKUP_RETENTION_DAYS")),
    now: new Date(),
  });

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

            summary.rowsAffected += await sweepOwnedRows(admin as unknown as SweepRpcClient, {
        table: owned.table,
        userId: policy.user_id,
        dateColumn: owned.dateColumn,
        cutoff,
        pii: policy.anonymize_instead_of_delete && owned.pii?.length ? owned.pii : undefined,
      });

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
      let evidence: ErasureEvidence | null = null;
      if (request.request_type === "full_account") {
        const prov = await eraseProviderData(admin, request.user_id, {
          elevenLabsKey: Deno.env.get("ELEVENLABS_API_KEY") ?? undefined,
          vapiKey: Deno.env.get("VAPI_PRIVATE_KEY") ?? undefined,
        });
        result["provider_failed"] = prov.failed.length;
        const ev: ErasureEvidence = { provider: prov };
        evidence = ev;
        if (!prov.ok && Deno.env.get("PROVIDER_ERASURE_STRICT") === "true") {
          throw new Error(`provider_erasure_incomplete:${prov.failed.slice(0, 3).join(",")}`);
        }
        const trust = await eraseTrustPackData(admin, request.user_id);
        if (!trust.ok) throw new Error("trust_pack_erasure_incomplete");
        ev.trustPack = { ok: true };
        ev.ownedTables = {};
        for (const owned of OWNED_TABLES) {
          const { data: rows, error } = await admin
            .from(owned.table)
            .delete()
            .eq("user_id", request.user_id)
            .select("id");
          if (error) throw error;
          result[owned.table] = rows?.length ?? 0;
        }
        const { data: rest, error: restErr } = await admin.rpc("erase_user_rows", { p_user: request.user_id });
        if (restErr) throw restErr;
        const blockedTables = Object.keys((rest as { blocked?: Record<string, string> } | null)?.blocked ?? {});
        result["blocked_tables"] = blockedTables.length;
        ev.catalogErase = rest as ErasureEvidence["catalogErase"];
        if (blockedTables.length) throw new Error(`erasure_blocked_tables:${blockedTables.slice(0, 5).join(",")}`);
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

      // Persist what the job did BEFORE marking it completed, so a certificate can always be (re)issued from it.
      if (evidence) {
        const evErr = await recordErasureEvidence(admin, request, evidence);
        if (evErr) summary.errors.push(`erasure evidence ${request.id}: ${evErr}`);
      }

      const completedAt = new Date().toISOString();
      await admin
        .from("deletion_requests")
        .update({ status: "completed", completed_at: completedAt, result })
        .eq("id", request.id);

      await admin.rpc("log_audit_event", {
        p_user_id: request.user_id,
        p_action: `deletion_request_completed:${request.request_type}`,
        p_target_table: "deletion_requests",
        p_target_id: request.id,
      });

      summary.deletionRequestsProcessed += 1;

      // Deletion certificate. Best effort by design: the erasure is already done and must stay done.
      // Own try/catch: nothing here may reach the outer catch, which would re-open a completed request.
      if (evidence) {
        try {
          const cert = await issueErasureCertificate(admin, { ...request, status: "completed", completed_at: completedAt }, evidence, certOpts());
          if (cert.status === "issued") summary.certificatesIssued += 1;
          else if (cert.status === "error") summary.errors.push(`erasure certificate ${request.id}: ${cert.reason}`);
          else if (cert.status === "skipped" && cert.reason === "not_configured") {
            summary.errors.push(`erasure certificate ${request.id}: ERASURE_CERT_SIGNING_KEY is missing or shorter than 32 characters; it will be issued on a later run once configured`);
          }
        } catch (certErr) {
          summary.errors.push(`erasure certificate ${request.id}: ${certErr instanceof Error ? certErr.message : String(certErr)}`);
        }
      }
    } catch (err) {
      summary.errors.push(`request ${request.id}: ${err instanceof Error ? err.message : String(err)}`);
      await admin.from("deletion_requests").update({ status: "grace_period" }).eq("id", request.id);
    }
  }
  // ---------- 3. Certificates still missing (crash after completion, or signing key configured later) ----------
  const backfill = await issueMissingCertificates(admin, certOpts());
  summary.certificatesIssued += backfill.issued;
  summary.errors.push(...backfill.errors);
  return json(summary, summary.errors.length ? 207 : 200);
});
