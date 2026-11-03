// supabase/functions/_shared/audit/supabaseStore.ts
// Production AuditStore over a service-role Supabase client. All tables are service-role only (RLS on, no policies).
// NOT RUN against a live database from the authoring environment: the SQL it relies on is covered by
// scripts/db-tests/audit-migration.pglite.mjs; the PostgREST glue below is covered by typecheck + staging checklist.

import type {
  AuditRow, AuditSettings, AuditStore, BlockKind, CallRow, ClaimedCall, ConsentInsert, EmailJob, VerificationRow,
} from "./ports.ts";

// Minimal structural type so this file typechecks without importing supabase-js in tests.
// deno-lint-ignore no-explicit-any
type Sb = any;

function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`audit_store_${what}: ${r.error.message}`);
  return r.data;
}

export function supabaseAuditStore(sb: Sb): AuditStore {
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => must(await sb.rpc(fn, args), fn);
  const one = async <T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T | null> => {
    const r = await q;
    if (r.error) throw new Error(`audit_store_${what}: ${r.error.message}`);
    return r.data;
  };

  return {
    async getSettings(): Promise<AuditSettings> {
      const r = await one<AuditSettings>(sb.from("audit_settings").select("enabled,otp_enabled,calls_enabled,followups_enabled,allowed_countries,retention_days,cooldown_days,disabled_reason").eq("id", true).maybeSingle(), "settings");
      // Fail closed: no settings row => feature off.
      return r ?? { enabled: false, otp_enabled: false, calls_enabled: false, followups_enabled: false, allowed_countries: [], retention_days: 30, cooldown_days: 30, disabled_reason: "settings_missing" };
    },
    async consumeRate(key, max, windowSeconds) { return (await rpc("audit_consume_rate", { p_key: key, p_max: max, p_window_seconds: windowSeconds })) === true; },
    async isBlocked(kind: BlockKind, value) {
      const r = await sb.from("audit_blocklist").select("id").eq("kind", kind).eq("value", value).limit(1);
      if (r.error) throw new Error(`audit_store_blocked: ${r.error.message}`); // caller fails closed on throw
      return (r.data?.length ?? 0) > 0;
    },
    async addBlock(kind, value, reason) { must(await sb.from("audit_blocklist").upsert({ kind, value, reason }, { onConflict: "kind,value", ignoreDuplicates: true }), "add_block"); },
    async tryStart() { return (await rpc("audit_try_start")) === true; },
    async reserveDaily(cents) { return (await rpc("audit_reserve_daily", { p_cents: cents })) === true; },
    async reserveAudit(auditId, cents) { return (await rpc("audit_reserve_audit", { p_audit_id: auditId, p_cents: cents })) as "ok" | "audit_cap" | "daily_budget"; },
    async bump(field, n = 1) { await rpc("audit_bump", { p_field: field, p_n: n }); },
    async cooldownActive(h) {
      const r = await one<{ expires_at: string }>(sb.from("audit_cooldown").select("expires_at").eq("phone_hash", h).maybeSingle(), "cooldown");
      return !!r && Date.parse(r.expires_at) > Date.now();
    },
    async claimNumber(h) { return (await rpc("audit_claim_number", { p_phone_hash: h })) === true; },
    async releaseNumber(h) { await rpc("audit_release_number", { p_phone_hash: h }); },

    async insertVerification(v: VerificationRow) { must(await sb.from("audit_verifications").insert(v), "ins_verification"); },
    async getVerification(id) { return await one<VerificationRow>(sb.from("audit_verifications").select("*").eq("id", id).maybeSingle(), "get_verification"); },
    async updateVerification(id, patch) { must(await sb.from("audit_verifications").update(patch).eq("id", id), "upd_verification"); },
    async supersedePending(phoneHash, exceptId) {
      must(await sb.from("audit_verifications").update({ status: "superseded" }).eq("phone_hash", phoneHash).eq("status", "pending").neq("id", exceptId), "supersede");
    },

    async createAudit(a: AuditRow) { must(await sb.from("audits").insert(a), "create_audit"); },
    async getAuditByTokenHash(h) { return await one<AuditRow>(sb.from("audits").select("*").eq("token_hash", h).gt("expires_at", new Date().toISOString()).maybeSingle(), "by_token"); },
    async getAuditByShareHash(h) { return await one<AuditRow>(sb.from("audits").select("*").eq("share_token_hash", h).gt("expires_at", new Date().toISOString()).maybeSingle(), "by_share"); },
    async getAudit(id) { return await one<AuditRow>(sb.from("audits").select("*").eq("id", id).maybeSingle(), "get_audit"); },
    async updateAudit(id, patch) { must(await sb.from("audits").update(patch).eq("id", id), "upd_audit"); },
    async deleteAudit(id) { return (await rpc("audit_delete", { p_audit_id: id })) === true; },

    async insertCalls(rows: CallRow[]) { must(await sb.from("audit_calls").insert(rows), "ins_calls"); },
    async listCalls(auditId) { return (must(await sb.from("audit_calls").select("*").eq("audit_id", auditId).order("slot"), "list_calls") ?? []) as CallRow[]; },
    async getCall(id) { return await one<CallRow>(sb.from("audit_calls").select("*").eq("id", id).maybeSingle(), "get_call"); },
    async getCallByProviderId(pid) { return await one<CallRow>(sb.from("audit_calls").select("*").eq("vapi_call_id", pid).maybeSingle(), "call_by_provider"); },
    async updateCall(id, patch) { must(await sb.from("audit_calls").update(patch).eq("id", id), "upd_call"); },
    async cancelPendingCalls(auditId, reason) {
      const r = must<{ id: string }[] | null>(await sb.from("audit_calls").update({ status: "cancelled", skip_reason: reason }).eq("audit_id", auditId).eq("status", "scheduled").select("id"), "cancel_calls");
      return (r ?? []).length;
    },
    async claimDueCalls(limit) { return ((await rpc("audit_claim_due_calls", { p_limit: limit })) ?? []) as ClaimedCall[]; },
    async releaseStuck() { return Number(await rpc("audit_release_stuck")) || 0; },
    async listStaleDialing(placedBeforeIso, limit) {
      return (must(await sb.from("audit_calls").select("*").eq("status", "dialing").lt("placed_at", placedBeforeIso).order("placed_at").limit(limit), "stale_dialing") ?? []) as CallRow[];
    },
    async completeReady() { return ((await rpc("audit_complete_ready")) ?? []) as string[]; },

    async insertConsent(c: ConsentInsert) { must(await sb.from("audit_consents").insert(c), "ins_consent"); },
    async hasConsent(auditId, scope) {
      const r = await sb.from("audit_consents").select("id").eq("audit_id", auditId).eq("scope", scope).eq("granted", true).limit(1);
      if (r.error) throw new Error(`audit_store_has_consent: ${r.error.message}`); // fail closed
      return (r.data?.length ?? 0) > 0;
    },

    async addEvent(auditId, kind, detail = {}) { must(await sb.from("audit_events").insert({ audit_id: auditId, kind, detail }), "event"); },

    async queueEmails(rows) {
      if (!rows.length) return;
      must(await sb.from("audit_email_queue").upsert(rows, { onConflict: "audit_id,step", ignoreDuplicates: true }), "queue_emails");
    },
    async claimDueEmails(limit) {
      const due = must<{ id: string }[] | null>(await sb.from("audit_email_queue").select("id").eq("status", "queued").lte("send_at", new Date().toISOString()).order("send_at").limit(limit), "due_emails") ?? [];
      if (!due.length) return [];
      // The status filter makes the claim atomic: two sweepers cannot both flip the same row.
      const r = must<unknown[] | null>(await sb.from("audit_email_queue").update({ status: "sending" }).in("id", due.map((x: { id: string }) => x.id)).eq("status", "queued").select("id,audit_id,step,kind,send_at,status"), "claim_emails");
      return (r ?? []) as EmailJob[];
    },
    async finishEmail(id, status, info = {}) {
      must(await sb.from("audit_email_queue").update({ status, skip_reason: info.skip_reason ?? null, provider_id: info.provider_id ?? null, sent_at: status === "sent" ? new Date().toISOString() : null }).eq("id", id), "finish_email");
    },
    async skipQueuedFollowups(auditId, reason) {
      must(await sb.from("audit_email_queue").update({ status: "skipped", skip_reason: reason }).eq("audit_id", auditId).eq("kind", "followup").eq("status", "queued"), "skip_followups");
    },
    async suppressEmail(h, reason) { must(await sb.from("audit_email_suppressions").upsert({ email_hash: h, reason }, { onConflict: "email_hash", ignoreDuplicates: true }), "suppress"); },
    async isEmailSuppressed(h) {
      const r = await sb.from("audit_email_suppressions").select("email_hash").eq("email_hash", h).limit(1);
      if (r.error) throw new Error(`audit_store_suppressed: ${r.error.message}`); // fail closed: do not email
      return (r.data?.length ?? 0) > 0;
    },

    async purgeExpired() { return ((await rpc("audit_purge_expired")) ?? {}) as Record<string, number>; },
    async benchmark() { return (await rpc("audit_benchmark_public")) ?? null; },
  };
}
