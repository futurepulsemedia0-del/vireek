// supabase/functions/_shared/dispatch/jobSyncClaim.ts
//
// Idempotency for "push a booked job to an external FSM". job_external_syncs has UNIQUE (job_id, provider), so that
// pair is the idempotency key. Before pushing, a caller CLAIMS the pair:
//   - no row            -> INSERT a 'pending' row (unique constraint arbitrates concurrent callers)
//   - 'synced'          -> skip (already created externally; a webhook retry must not create a duplicate)
//   - fresh 'pending'   -> skip (another invocation is in flight)
//   - 'error' / 'not_connected' / stale 'pending' -> take over with a compare-and-swap on updated_at
// Only the winner proceeds. Never throws: any DB failure means "do not push" (fail closed against duplicates;
// the failure is logged and the job stays retryable).

export type ClaimDecision = "insert" | "skip_synced" | "skip_inflight" | "takeover";

export const PENDING_STALE_MS = 2 * 60 * 1000;

export function decideClaim(existing: { status: string; updated_at: string } | null, nowMs: number, staleMs = PENDING_STALE_MS): ClaimDecision {
  if (!existing) return "insert";
  if (existing.status === "synced") return "skip_synced";
  if (existing.status === "pending") {
    const age = nowMs - Date.parse(existing.updated_at);
    return Number.isFinite(age) && age < staleMs ? "skip_inflight" : "takeover";
  }
  return "takeover";
}

// Minimal structural type so this module has no npm: import (unit-testable).
interface Db {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function claimJobSync(
  admin: Db,
  userId: string,
  jobId: string,
  provider: "jobber" | "service_titan" | "housecall_pro",
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const { data: existing, error: readErr } = await admin
      .from("job_external_syncs")
      .select("status, updated_at")
      .eq("job_id", jobId)
      .eq("provider", provider)
      .maybeSingle();
    if (readErr) throw new Error("claim_read_failed");

    const decision = decideClaim(existing ?? null, nowMs);
    if (decision === "skip_synced" || decision === "skip_inflight") return false;

    if (decision === "insert") {
      const { error } = await admin.from("job_external_syncs").insert({ user_id: userId, job_id: jobId, provider, status: "pending" });
      if (!error) return true;
      if ((error as { code?: string }).code === "23505") return false; // lost the race
      throw new Error("claim_insert_failed");
    }

    // takeover: compare-and-swap on the updated_at we observed; exactly one concurrent caller gets a row back.
    const { data: won, error: casErr } = await admin
      .from("job_external_syncs")
      .update({ status: "pending", error_message: null })
      .eq("job_id", jobId)
      .eq("provider", provider)
      .eq("updated_at", existing.updated_at)
      .select("id");
    if (casErr) throw new Error("claim_cas_failed");
    return Array.isArray(won) && won.length === 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "job_sync_claim_failed", provider, job_id: jobId, error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}
