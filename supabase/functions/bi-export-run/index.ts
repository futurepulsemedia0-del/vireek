// supabase/functions/bi-export-run/index.ts
//
// BI export: scheduled, signed CSV delivery to a customer's S3 / GCS bucket, plus read-only Postgres logins
// for Power BI. Reuses the export engine (CSV hardening), the Data Platform catalog (PII classes, pseudonymiser)
// and secret envelope. It does not change the existing `export-run` function.
//
//   user JWT (can_export_data):
//     { action: "save_target", id?, name, provider, bucket, region, prefix, access_key_id, secret_access_key? }
//     { action: "test_target", id }
//     { action: "delete_target", id }
//     { action: "save_schedule", id?, name, target_id, datasets[], mode, pii_mode, interval_minutes, enabled }
//     { action: "delete_schedule", id }
//     { action: "run_now", schedule_id }
//     { action: "rotate_signing" }
//     { action: "create_reader", label, include_pii }   -> login shown ONCE
//     { action: "revoke_reader", role_name }
//   cron: { action: "cron" } + header X-Cron-Secret
//
// Deploy: supabase functions deploy bi-export-run --no-verify-jwt   (cron has no JWT; every other action verifies the JWT in code)
// Secrets: DATA_PLATFORM_ENCRYPTION_KEY, CRON_SECRET (same as the Data Platform).

import { adminClient, authenticate, corsHeaders, encryptionKey, isCron, json, type Admin, type Caller } from "../_shared/data-platform/http.ts";
import { openSecret, randomSecret, sealSecret } from "../_shared/data-platform/secrets.ts";
import {
  BI_MAX_SCHEDULES, BI_MAX_TARGETS, BI_RUN_BUDGET_MS, BiStorageError, deleteObject, isUuid, nextRunAt, putObject,
  validateScheduleInput, validateTargetInput, signingKeyId, type StorageCreds, type StorageTarget,
} from "../_shared/exports/bi.ts";
import { runBiDelivery, type BiScheduleRow } from "../_shared/exports/biRunner.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

interface TargetRow extends StorageTarget {
  id: string;
  user_id: string;
  name: string;
  access_key_id: string;
}
interface ScheduleRow extends BiScheduleRow {
  target_id: string;
  name: string;
  interval_minutes: number;
  consecutive_failures: number;
  pii_authorized_by: string | null;
}

const targetAad = (id: string) => `bi_target:${id}`;
const signingAad = (owner: string) => `bi_signing:${owner}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

async function loadCreds(admin: Admin, t: TargetRow): Promise<StorageCreds> {
  const { data } = await admin.from("bi_export_secrets").select("secret_enc").eq("ref_id", t.id).eq("kind", "target").eq("user_id", t.user_id).maybeSingle();
  if (!data?.secret_enc) throw new Error("Stored credentials are missing. Edit the destination and enter the secret again.");
  const { secret_access_key } = JSON.parse(await openSecret(data.secret_enc as string, encryptionKey(), targetAad(t.id))) as { secret_access_key: string };
  return { accessKeyId: t.access_key_id, secretAccessKey: secret_access_key };
}

/** Per-account manifest signing secret; created on first use. `created` = show it to the user once. */
async function signingSecret(admin: Admin, owner: string, opts: { rotate?: boolean } = {}): Promise<{ secret: string; created: boolean }> {
  if (!opts.rotate) {
    const { data } = await admin.from("bi_export_secrets").select("secret_enc").eq("ref_id", owner).eq("kind", "signing").eq("user_id", owner).maybeSingle();
    if (data?.secret_enc) return { secret: await openSecret(data.secret_enc as string, encryptionKey(), signingAad(owner)), created: false };
  }
  const secret = `vbi_${randomSecret(32)}`;
  const { error } = await admin.from("bi_export_secrets").upsert({
    ref_id: owner, kind: "signing", user_id: owner, secret_enc: await sealSecret(secret, encryptionKey(), signingAad(owner)), updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("Could not store the signing secret.");
  return { secret, created: true };
}

async function execute(admin: Admin, s: ScheduleRow, trigger: "manual" | "scheduled", requestedBy: string | null, deadline: number): Promise<void> {
  const { data: run } = await admin.from("bi_export_runs").insert({ user_id: s.user_id, schedule_id: s.id, schedule_name: s.name, trigger, requested_by: requestedBy }).select("id").single();
  const runId = run!.id as string;
  let result: Awaited<ReturnType<typeof runBiDelivery>>;
  let targetError = null as string | null;
  try {
    const { data: t } = await admin.from("bi_export_targets").select("id,user_id,name,provider,bucket,region,prefix,access_key_id").eq("id", s.target_id).eq("user_id", s.user_id).maybeSingle();
    if (!t) throw new Error("The destination of this schedule no longer exists.");
    const target = t as TargetRow;
    const creds = await loadCreds(admin, target);
    const sign = await signingSecret(admin, s.user_id);
    const piiPermitted = s.pii_mode === "omit" ? true : ((await admin.rpc("bi_has_permission", { p_user: s.pii_authorized_by, p_key: "can_export_pii" })).data === true);
    result = await runBiDelivery(
      {
        db: admin, signingSecret: sign.secret, pseudonymSecret: encryptionKey(), deadline, piiPermitted,
        put: async (rel, bytes, ct) => {
          try {
            await putObject(target, creds, rel, bytes, ct);
          } catch (e) {
            if (e instanceof BiStorageError) targetError = e.message;
            throw e;
          }
        },
      },
      s, runId,
    );
  } catch (e) {
    result = { status: "failed", stats: { datasets: {} }, error: errMsg(e) };
  }

  const now = new Date();
  const failed = result.status === "failed";
  const failures = failed ? s.consecutive_failures + 1 : 0;
  await admin.from("bi_export_runs").update({ status: result.status, stats: result.stats, error: result.error, finished_at: now.toISOString() }).eq("id", runId);
  await admin.from("bi_export_schedules").update({
    last_run_at: now.toISOString(),
    ...(failed ? {} : { last_success_at: now.toISOString() }),
    last_error: result.error,
    consecutive_failures: failures,
    next_run_at: result.status === "partial" ? now.toISOString() : nextRunAt(now, s.interval_minutes, failures).toISOString(),
    locked_until: null,
  }).eq("id", s.id);
  if (targetError || result.status === "success") {
    await admin.from("bi_export_targets").update({
      status: targetError ? "error" : "connected", last_error: targetError, last_tested_at: now.toISOString(),
    }).eq("id", s.target_id);
  }
}

function start(admin: Admin, s: ScheduleRow, trigger: "manual" | "scheduled", requestedBy: string | null): void {
  const task = execute(admin, s, trigger, requestedBy, Date.now() + BI_RUN_BUDGET_MS).catch((e) => console.error("[bi-export] execute failed:", errMsg(e)));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(task);
}

const SCHEDULE_COLS = "id,user_id,target_id,name,datasets,mode,pii_mode,pii_authorized_by,interval_minutes,consecutive_failures,enabled";
const fieldErr = (v: { error: string; errors?: Record<string, string> }) => json({ error: v.error, errors: v.errors ?? {} }, 400);

async function handleUser(admin: Admin, caller: Caller, body: Record<string, unknown>): Promise<Response> {
  if (!caller.canManage) return json({ error: "You do not have permission to manage BI exports." }, 403);
  const owner = caller.ownerId;

  switch (body.action) {
    case "save_target": {
      const editing = isUuid(body.id) ? (body.id as string) : null;
      const v = validateTargetInput(body, { requireSecret: !editing });
      if (!v.ok) return fieldErr(v);
      const t = v.value;
      let id = editing;
      if (editing) {
        const { data, error } = await admin.from("bi_export_targets").update({
          name: t.name, provider: t.provider, bucket: t.bucket, region: t.region, prefix: t.prefix, access_key_id: t.access_key_id, status: "untested", last_error: null,
        }).eq("id", editing).eq("user_id", owner).select("id").maybeSingle();
        if (error?.code === "23505") return json({ error: "A destination with this name already exists.", errors: { name: "Already used." } }, 409);
        if (error || !data) return json({ error: "Destination not found." }, 404);
      } else {
        const { count } = await admin.from("bi_export_targets").select("id", { count: "exact", head: true }).eq("user_id", owner);
        if ((count ?? 0) >= BI_MAX_TARGETS) return json({ error: `You can connect up to ${BI_MAX_TARGETS} destinations.` }, 409);
        const { data, error } = await admin.from("bi_export_targets").insert({
          user_id: owner, name: t.name, provider: t.provider, bucket: t.bucket, region: t.region, prefix: t.prefix, access_key_id: t.access_key_id, created_by: caller.userId,
        }).select("id").single();
        if (error?.code === "23505") return json({ error: "A destination with this name already exists.", errors: { name: "Already used." } }, 409);
        if (error || !data) return json({ error: "Could not save the destination." }, 500);
        id = data.id as string;
      }
      if (t.secret_access_key) {
        const { error } = await admin.from("bi_export_secrets").upsert({
          ref_id: id, kind: "target", user_id: owner,
          secret_enc: await sealSecret(JSON.stringify({ secret_access_key: t.secret_access_key }), encryptionKey(), targetAad(id as string)),
          updated_at: new Date().toISOString(),
        });
        if (error) return json({ error: "Could not store the credentials." }, 500);
      }
      const sign = await signingSecret(admin, owner);
      return json({ id, signing_secret: sign.created ? sign.secret : null, signing_key_id: await signingKeyId(sign.secret) });
    }

    case "test_target": {
      if (!isUuid(body.id)) return json({ error: "Invalid destination." }, 400);
      const { data: t } = await admin.from("bi_export_targets").select("id,user_id,name,provider,bucket,region,prefix,access_key_id").eq("id", body.id).eq("user_id", owner).maybeSingle();
      if (!t) return json({ error: "Destination not found." }, 404);
      const target = t as TargetRow;
      const key = `_vireek_connection_test_${Date.now()}.txt`;
      try {
        const creds = await loadCreds(admin, target);
        await putObject(target, creds, key, new TextEncoder().encode("Vireek BI export connection test. Safe to delete."), "text/plain");
        let cleaned = true;
        try { await deleteObject(target, creds, key); } catch { cleaned = false; }
        await admin.from("bi_export_targets").update({ status: "connected", last_error: null, last_tested_at: new Date().toISOString() }).eq("id", target.id);
        return json({ ok: true, cleaned_up: cleaned });
      } catch (e) {
        const message = errMsg(e);
        await admin.from("bi_export_targets").update({ status: "error", last_error: message, last_tested_at: new Date().toISOString() }).eq("id", target.id);
        return json({ ok: false, error: message });
      }
    }

    case "delete_target": {
      if (!isUuid(body.id)) return json({ error: "Invalid destination." }, 400);
      const { data } = await admin.from("bi_export_targets").delete().eq("id", body.id).eq("user_id", owner).select("id").maybeSingle();
      if (!data) return json({ error: "Destination not found." }, 404);
      await admin.from("bi_export_secrets").delete().eq("ref_id", body.id).eq("kind", "target");
      return json({ ok: true });
    }

    case "save_schedule": {
      const v = validateScheduleInput(body);
      if (!v.ok) return fieldErr(v);
      const s = v.value;
      if (s.pii_mode !== "omit") {
        const { data: ok } = await admin.rpc("bi_has_permission", { p_user: caller.userId, p_key: "can_export_pii" });
        if (ok !== true) return json({ error: "You need the “export personal data” permission to include personal data.", errors: { pii_mode: "Not permitted." } }, 403);
      }
      const { data: target } = await admin.from("bi_export_targets").select("id").eq("id", s.target_id).eq("user_id", owner).maybeSingle();
      if (!target) return json({ error: "Destination not found.", errors: { target_id: "Choose a destination." } }, 404);
      const row = {
        target_id: s.target_id, name: s.name, datasets: s.datasets, mode: s.mode, pii_mode: s.pii_mode,
        pii_authorized_by: s.pii_mode === "omit" ? null : caller.userId, interval_minutes: s.interval_minutes, enabled: s.enabled,
      };
      if (isUuid(body.id)) {
        const { data, error } = await admin.from("bi_export_schedules").update({ ...row, consecutive_failures: 0, next_run_at: new Date().toISOString() }).eq("id", body.id).eq("user_id", owner).select("id").maybeSingle();
        if (error?.code === "23505") return json({ error: "A schedule with this name already exists.", errors: { name: "Already used." } }, 409);
        if (error || !data) return json({ error: "Schedule not found." }, 404);
        return json({ id: data.id });
      }
      const { count } = await admin.from("bi_export_schedules").select("id", { count: "exact", head: true }).eq("user_id", owner);
      if ((count ?? 0) >= BI_MAX_SCHEDULES) return json({ error: `You can create up to ${BI_MAX_SCHEDULES} schedules.` }, 409);
      const { data, error } = await admin.from("bi_export_schedules").insert({ ...row, user_id: owner, created_by: caller.userId }).select("id").single();
      if (error?.code === "23505") return json({ error: "A schedule with this name already exists.", errors: { name: "Already used." } }, 409);
      if (error || !data) return json({ error: "Could not save the schedule." }, 500);
      return json({ id: data.id });
    }

    case "delete_schedule": {
      if (!isUuid(body.id)) return json({ error: "Invalid schedule." }, 400);
      const { data } = await admin.from("bi_export_schedules").delete().eq("id", body.id).eq("user_id", owner).select("id").maybeSingle();
      return data ? json({ ok: true }) : json({ error: "Schedule not found." }, 404);
    }

    case "run_now": {
      if (!isUuid(body.schedule_id)) return json({ error: "Invalid schedule." }, 400);
      const nowIso = new Date().toISOString();
      const { data: claimed } = await admin.from("bi_export_schedules")
        .update({ locked_until: new Date(Date.now() + 15 * 60_000).toISOString() })
        .eq("id", body.schedule_id).eq("user_id", owner).or(`locked_until.is.null,locked_until.lt.${nowIso}`).select(SCHEDULE_COLS).maybeSingle();
      if (!claimed) {
        const { data: exists } = await admin.from("bi_export_schedules").select("id").eq("id", body.schedule_id).eq("user_id", owner).maybeSingle();
        return exists ? json({ error: "This schedule is already running." }, 409) : json({ error: "Schedule not found." }, 404);
      }
      start(admin, claimed as ScheduleRow, "manual", caller.userId);
      return json({ ok: true }, 202);
    }

    case "rotate_signing": {
      const s = await signingSecret(admin, owner, { rotate: true });
      return json({ signing_secret: s.secret, signing_key_id: await signingKeyId(s.secret) });
    }

    case "create_reader": {
      const include = body.include_pii === true;
      if (include) {
        const { data: ok } = await admin.rpc("bi_has_permission", { p_user: caller.userId, p_key: "can_export_pii" });
        if (ok !== true) return json({ error: "You need the “export personal data” permission to include personal data." }, 403);
      }
      const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
      const password = randomSecret(32);
      const { data: role, error } = await admin.rpc("bi_provision_reader", { p_owner: owner, p_by: caller.userId, p_label: label, p_password: password, p_include_pii: include });
      if (error || !role) {
        console.error("[bi-export] provision failed:", error?.message);
        const m = error?.message ?? "";
        return json({ error: m.includes("reader limit") ? "You already have 5 active reader logins. Revoke one first." : m.includes("CREATEROLE") ? "This project's database cannot create dedicated logins. Use the Supabase login option in the docs." : "Could not create the login." }, 409);
      }
      const ref = new URL(Deno.env.get("SUPABASE_URL") ?? "https://x.supabase.co").hostname.split(".")[0];
      return json({ role_name: role, password, host: `db.${ref}.supabase.co`, port: 5432, database: "postgres", pooler_user: `${role}.${ref}` });
    }

    case "revoke_reader": {
      if (typeof body.role_name !== "string") return json({ error: "Invalid login." }, 400);
      const { data, error } = await admin.rpc("bi_revoke_reader", { p_owner: owner, p_role: body.role_name });
      if (error) return json({ error: "Invalid login." }, 400);
      return data === true ? json({ ok: true }) : json({ error: "Login not found." }, 404);
    }

    default:
      return json({ error: "Unknown action." }, 400);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron may send an empty body */ }
  const admin = adminClient();

  try {
    if (body.action === "cron") {
      if (!isCron(req)) return json({ error: "Forbidden" }, 403);
      const work = (async () => {
        await admin.from("bi_export_runs").delete().lt("started_at", new Date(Date.now() - 90 * 86_400_000).toISOString());
        const budgetEnd = Date.now() + BI_RUN_BUDGET_MS;
        const { data: due } = await admin.rpc("bi_claim_due", { p_limit: 3 });
        for (const d of (due ?? []) as ScheduleRow[]) {
          if (budgetEnd - Date.now() < 20_000) {
            await admin.from("bi_export_schedules").update({ locked_until: null }).eq("id", d.id);  // picked up by the next tick
            continue;
          }
          await execute(admin, d, "scheduled", null, budgetEnd);
        }
      })().catch((e) => console.error("[bi-export] cron failed:", errMsg(e)));
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(work); else await work;
      return json({ ok: true }, 202);
    }

    const a = await authenticate(req);
    if (!a.ok) return a.res;
    return await handleUser(admin, a.caller, body);
  } catch (err) {
    console.error("[bi-export-run]", errMsg(err));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
