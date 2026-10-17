// Inspection Reports API for /dashboard/inspection-reports (staff side).
//
// One authenticated POST endpoint, { action, ...args }:
//   list / jobs / get / create / update / publish / share_settings /
//   pdf_upload_url / pdf_attach / cancel_signature / void / delete
//
// Scoping: every row is keyed by the ACCOUNT OWNER's profile id
// (accountOwnerId): owners resolve to themselves, team members through
// team_members.account_owner_id. Permission gate (server-side, mirrors the
// dashboard nav): owner OR can_view_all_jobs (custom roles override).
//
// The report is compiled HERE from the job's real records (checklist,
// photos, notes) so a client can never forge evidence. After `publish` the
// snapshot is immutable. E-sign reuses signature_requests (document_type
// 'custom', document_id = report id) created through send-signature-request;
// completion is synced back into inspection_reports.status here.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  SUMMARY_MAX,
  TITLE_MAX,
  buildChecklistSnapshot,
  canManageInspectionReports,
  clampShareDays,
  clip,
  collectPhotos,
  deriveOverallResult,
  isUuid,
  makeReportNumber,
  mergePhotoEdits,
  type EvidenceSummary,
  type ReportPhoto,
} from "../_shared/inspection/reportEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const fail = (status: number, error: string, detail: string) => json({ error, detail }, status);

const PDF_BUCKET = "inspection-reports";
const SIGNED_URL_TTL = 3600;
const LIST_COLUMNS =
  "id, job_id, report_number, title, status, overall_result, customer_name, address, service_type, inspected_at, created_at, updated_at, published_at, signed_at, share_enabled, share_expires_at, view_count, last_viewed_at, pdf_path, pdf_generated_at";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return fail(401, "UNAUTHENTICATED", "Missing Authorization header.");
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return fail(401, "UNAUTHENTICATED", "Invalid or expired session.");
  const user = userData.user;

  // ---- resolve account owner + permission gate ----------------------
  const { data: profile } = await admin.from("profiles").select("id, role, email, full_name").eq("id", user.id).maybeSingle();
  let ownerId: string | null = profile?.role === "owner" ? user.id : null;
  let teamPermissions: Record<string, unknown> | null = null;
  let customRolePermissions: Record<string, unknown> | null = null;
  if (!ownerId) {
    const { data: tm } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("member_email", profile?.email ?? user.email ?? "")
      .maybeSingle();
    if (tm?.account_owner_id) {
      ownerId = tm.account_owner_id;
      teamPermissions = (tm.permissions as Record<string, unknown> | null) ?? null;
      customRolePermissions = ((tm.custom_role as { permissions?: Record<string, unknown> } | null)?.permissions) ?? null;
    }
  }
  if (!ownerId) return fail(403, "FORBIDDEN", "No account found for this user.");
  if (!canManageInspectionReports({ role: profile?.role, teamPermissions, customRolePermissions })) {
    return fail(403, "FORBIDDEN", "You don't have permission to manage inspection reports.");
  }
  const accountOwnerId: string = ownerId;

  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(args.action ?? "");

  // ---- helpers ------------------------------------------------------
  async function loadReport(id: unknown) {
    if (!isUuid(id)) return null;
    const { data } = await admin.from("inspection_reports").select("*").eq("id", id).eq("user_id", accountOwnerId).maybeSingle();
    return data;
  }

  /** Marks published reports as signed when their e-sign request completed. */
  async function syncSigned(ids: string[]) {
    if (ids.length === 0) return;
    const { data: done } = await admin
      .from("signature_requests")
      .select("document_id, completed_at")
      .eq("user_id", accountOwnerId)
      .eq("document_type", "custom")
      .eq("status", "completed")
      .in("document_id", ids);
    for (const d of done ?? []) {
      await admin
        .from("inspection_reports")
        .update({ status: "signed", signed_at: d.completed_at ?? new Date().toISOString() })
        .eq("id", d.document_id)
        .eq("user_id", accountOwnerId)
        .eq("status", "published");
    }
  }

  async function loadSignature(reportId: string) {
    const { data: requests } = await admin
      .from("signature_requests")
      .select("id, status, sent_at, completed_at, expires_at")
      .eq("user_id", accountOwnerId)
      .eq("document_type", "custom")
      .eq("document_id", reportId)
      .order("created_at", { ascending: false });
    const live = (requests ?? []).find((r) => r.status !== "voided") ?? null;
    if (!live) return null;
    const { data: signers } = await admin
      .from("signature_signers")
      .select("name, role, status, signed_at")
      .eq("request_id", live.id)
      .order("signing_order", { ascending: true });
    return { ...live, signers: signers ?? [] };
  }

  async function signPhotos(photos: ReportPhoto[]) {
    const urls = new Map<string, string>();
    for (const bucket of ["job-room-photos", "job-evidence-photos"] as const) {
      const paths = photos.filter((p) => p.bucket === bucket).map((p) => p.path);
      if (paths.length === 0) continue;
      const { data } = await admin.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_TTL);
      for (const row of data ?? []) if (row.signedUrl && row.path) urls.set(`${bucket}/${row.path}`, row.signedUrl);
    }
    return photos.map((p) => ({ ...p, url: urls.get(`${p.bucket}/${p.path}`) ?? null }));
  }

  async function signedPdfUrl(path: string | null) {
    if (!path) return null;
    const { data } = await admin.storage.from(PDF_BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
  }

  async function detail(id: string) {
    await syncSigned([id]);
    const report = await loadReport(id);
    if (!report) return null;
    const [photos, signature, pdfUrl] = await Promise.all([
      signPhotos((report.photos ?? []) as ReportPhoto[]),
      loadSignature(id),
      signedPdfUrl(report.pdf_path),
    ]);
    const { data: owner } = await admin.from("profiles").select("company_name").eq("id", accountOwnerId).maybeSingle();
    return { report, photos, signature, pdfUrl, businessName: owner?.company_name ?? null };
  }

  const nowIso = () => new Date().toISOString();

  try {
    switch (action) {
      case "list": {
        const { data, error } = await admin
          .from("inspection_reports")
          .select(LIST_COLUMNS)
          .eq("user_id", accountOwnerId)
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) throw error;
        const published = (data ?? []).filter((r) => r.status === "published").map((r) => r.id as string);
        if (published.length) {
          await syncSigned(published);
          const { data: fresh } = await admin.from("inspection_reports").select(LIST_COLUMNS).eq("user_id", accountOwnerId).order("created_at", { ascending: false }).limit(300);
          return json({ reports: fresh ?? [] });
        }
        return json({ reports: data ?? [] });
      }

      case "jobs": {
        const q = clip(args.q, 80).replace(/[%,()]/g, " ").trim();
        let query = admin
          .from("jobs")
          .select("id, customer_name, service_type, address, job_status, scheduled_datetime")
          .eq("user_id", accountOwnerId)
          .in("job_status", ["completed", "in_progress"])
          .order("scheduled_datetime", { ascending: false, nullsFirst: false })
          .limit(30);
        if (q) query = query.ilike("customer_name", `%${q}%`);
        const { data: jobs, error } = await query;
        if (error) throw error;
        const ids = (jobs ?? []).map((j) => j.id as string);
        const { data: existing } = ids.length
          ? await admin.from("inspection_reports").select("id, job_id").eq("user_id", accountOwnerId).neq("status", "voided").in("job_id", ids)
          : { data: [] as { id: string; job_id: string }[] };
        const byJob = new Map((existing ?? []).map((r) => [r.job_id, r.id]));
        return json({ jobs: (jobs ?? []).map((j) => ({ ...j, report_id: byJob.get(j.id as string) ?? null })) });
      }

      case "get": {
        const d = await detail(String(args.id ?? ""));
        return d ? json(d) : fail(404, "NOT_FOUND", "Report not found.");
      }

      case "create": {
        if (!isUuid(args.jobId)) return fail(400, "INVALID", "A valid job is required.");
        const { data: job } = await admin.from("jobs").select("*").eq("id", args.jobId).eq("user_id", accountOwnerId).maybeSingle();
        if (!job) return fail(404, "NOT_FOUND", "Job not found.");

        const { data: dup } = await admin.from("inspection_reports").select("id").eq("job_id", job.id).neq("status", "voided").maybeSingle();
        if (dup) return json({ ...(await detail(dup.id)), existing: true });

        const serviceType = job.service_type as string | null;
        const [{ data: templates }, { data: completions }, { data: checks }, { data: customer }] = await Promise.all([
          serviceType
            ? admin.from("job_quality_checklist_templates").select("id, item_label, sort_order").eq("user_id", accountOwnerId).eq("service_type", serviceType)
            : Promise.resolve({ data: [] as { id: string; item_label: string; sort_order: number }[] }),
          admin.from("job_checklist_completions").select("template_item_id, completed_at").eq("job_id", job.id),
          admin.from("job_evidence_checks").select("photo_paths, verdict, evidence_completeness, ai_summary, safety_flags, created_at").eq("job_id", job.id).eq("user_id", accountOwnerId).order("created_at", { ascending: false }).limit(3),
          job.customer_id
            ? admin.from("customers").select("email").eq("id", job.customer_id).eq("user_id", accountOwnerId).maybeSingle()
            : Promise.resolve({ data: null as { email: string | null } | null }),
        ]);

        const checklist = buildChecklistSnapshot(templates ?? [], completions ?? []);
        const latest = checks?.[0] ?? null;
        const evidence: EvidenceSummary | null = latest
          ? {
              verdict: latest.verdict,
              completeness: latest.evidence_completeness ?? null,
              summary: latest.ai_summary ? clip(latest.ai_summary, 1000) : null,
              safety_flag_count: Array.isArray(latest.safety_flags) ? latest.safety_flags.length : 0,
              checked_at: latest.created_at,
            }
          : null;
        const photos = collectPhotos({
          before: job.before_photos,
          after: job.after_photos,
          evidence: (checks ?? []).flatMap((c) => c.photo_paths ?? []),
        });
        const notes = [job.work_performed_notes, job.completion_notes, job.diagnosis_notes]
          .map((n) => (typeof n === "string" ? n.trim() : ""))
          .filter(Boolean)
          .join("\n\n");

        const id = crypto.randomUUID();
        const now = new Date();
        const row = {
          id,
          user_id: accountOwnerId,
          job_id: job.id,
          customer_id: job.customer_id ?? null,
          report_number: makeReportNumber(id, now),
          title: clip(`${serviceType || "Inspection"} report — ${job.customer_name}`, TITLE_MAX),
          overall_result: deriveOverallResult(checklist, evidence),
          summary: notes ? clip(notes, SUMMARY_MAX) : null,
          checklist,
          photos,
          evidence,
          customer_name: job.customer_name,
          customer_email: customer?.email ?? null,
          customer_phone: job.customer_phone ?? null,
          address: job.address ?? null,
          service_type: serviceType,
          inspector_name: profile?.full_name || profile?.email || null,
          inspected_at: job.scheduled_datetime ?? now.toISOString(),
          created_by: user.id,
        };
        const { error } = await admin.from("inspection_reports").insert(row);
        if (error) {
          if ((error as { code?: string }).code === "23505") {
            const { data: race } = await admin.from("inspection_reports").select("id").eq("job_id", job.id).neq("status", "voided").maybeSingle();
            if (race) return json({ ...(await detail(race.id)), existing: true });
          }
          throw error;
        }
        return json(await detail(id));
      }

      case "update": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status !== "draft") return fail(409, "LOCKED", "Shared reports can't be edited. Void it and create a new one if something is wrong.");
        const title = clip(args.title, TITLE_MAX);
        if (!title) return fail(400, "INVALID", "Title is required.");
        const result = args.overallResult;
        if (result !== null && result !== undefined && !["pass", "attention", "fail"].includes(String(result))) {
          return fail(400, "INVALID", "Invalid overall result.");
        }
        const { error } = await admin
          .from("inspection_reports")
          .update({
            title,
            summary: clip(args.summary, SUMMARY_MAX) || null,
            overall_result: result ?? null,
            photos: mergePhotoEdits((report.photos ?? []) as ReportPhoto[], args.photos),
            updated_at: nowIso(),
          })
          .eq("id", report.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await detail(report.id));
      }

      case "publish": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status !== "draft") return fail(409, "CONFLICT", "This report is already shared.");
        if (!report.overall_result) return fail(400, "INVALID", "Choose an overall result before sharing.");
        const days = clampShareDays(args.expiresInDays);
        const { error } = await admin
          .from("inspection_reports")
          .update({
            status: "published",
            share_enabled: true,
            share_expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
            published_at: nowIso(),
            updated_at: nowIso(),
          })
          .eq("id", report.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await detail(report.id));
      }

      case "share_settings": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status === "draft" || report.status === "voided") return fail(409, "CONFLICT", "Only shared reports have link settings.");
        const patch: Record<string, unknown> = { updated_at: nowIso() };
        if (typeof args.enabled === "boolean") patch.share_enabled = args.enabled;
        if (args.expiresInDays !== undefined) patch.share_expires_at = new Date(Date.now() + clampShareDays(args.expiresInDays) * 86_400_000).toISOString();
        if (args.rotate === true) patch.share_token = crypto.randomUUID();
        const { error } = await admin.from("inspection_reports").update(patch).eq("id", report.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await detail(report.id));
      }

      case "pdf_upload_url": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status === "voided") return fail(409, "CONFLICT", "Voided reports can't be exported.");
        const path = `${accountOwnerId}/${report.id}/${Date.now()}.pdf`;
        const { data, error } = await admin.storage.from(PDF_BUCKET).createSignedUploadUrl(path);
        if (error || !data) throw error ?? new Error("Could not create upload URL.");
        return json({ path, token: data.token });
      }

      case "pdf_attach": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        const path = String(args.path ?? "");
        const prefix = `${accountOwnerId}/${report.id}/`;
        if (!path.startsWith(prefix) || path.includes("..") || !path.endsWith(".pdf")) return fail(400, "INVALID", "Invalid PDF path.");
        const { data: files } = await admin.storage.from(PDF_BUCKET).list(`${accountOwnerId}/${report.id}`);
        if (!(files ?? []).some((f) => `${prefix}${f.name}` === path)) return fail(400, "INVALID", "The uploaded PDF wasn't found. Please try again.");
        const now = nowIso();
        const { error } = await admin
          .from("inspection_reports")
          .update({ pdf_path: path, pdf_generated_at: now, updated_at: now })
          .eq("id", report.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        if (report.pdf_path && report.pdf_path !== path) await admin.storage.from(PDF_BUCKET).remove([report.pdf_path]);
        return json(await detail(report.id));
      }

      case "cancel_signature": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        await admin
          .from("signature_requests")
          .update({ status: "voided", voided_at: nowIso() })
          .eq("user_id", accountOwnerId)
          .eq("document_type", "custom")
          .eq("document_id", report.id)
          .in("status", ["sent", "viewed", "partially_signed"]);
        return json(await detail(report.id));
      }

      case "void": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status === "signed") return fail(409, "CONFLICT", "A signed report can't be voided.");
        if (report.status === "voided") return json(await detail(report.id));
        await admin
          .from("signature_requests")
          .update({ status: "voided", voided_at: nowIso() })
          .eq("user_id", accountOwnerId)
          .eq("document_type", "custom")
          .eq("document_id", report.id)
          .in("status", ["sent", "viewed", "partially_signed"]);
        const { error } = await admin
          .from("inspection_reports")
          .update({ status: "voided", share_enabled: false, voided_at: nowIso(), updated_at: nowIso() })
          .eq("id", report.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await detail(report.id));
      }

      case "delete": {
        const report = await loadReport(args.id);
        if (!report) return fail(404, "NOT_FOUND", "Report not found.");
        if (report.status !== "draft") return fail(409, "CONFLICT", "Only drafts can be deleted. Void a shared report instead.");
        if (report.pdf_path) await admin.storage.from(PDF_BUCKET).remove([report.pdf_path]);
        const { error } = await admin.from("inspection_reports").delete().eq("id", report.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json({ deleted: true });
      }

      default:
        return fail(400, "INVALID", "Unknown action.");
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "inspection_reports_failed", action, error: error instanceof Error ? error.message : String(error) }));
    return fail(500, "INTERNAL", "Something went wrong. Please try again.");
  }
});
