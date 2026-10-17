// Public (no-auth) read endpoint behind the customer share link
// /inspection/:token. Matches ONLY on the unguessable share_token and returns
// display-safe fields: no customer email/phone, no internal ids, no signer
// tokens. Photos and the PDF are served through short-lived signed URLs.
// A link works only while the report is published/signed, sharing is enabled
// and it hasn't expired (see shareState in _shared/inspection/reportEngine.ts).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isUuid, shareState, type ReportPhoto } from "../_shared/inspection/reportEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const TTL = 3600;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { token } = (await req.json().catch(() => ({}))) as { token?: unknown };
  if (!isUuid(token)) return json({ error: "NOT_FOUND" }, 404);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const { data: report } = await admin.from("inspection_reports").select("*").eq("share_token", token).maybeSingle();
    if (!report) return json({ error: "NOT_FOUND" }, 404);

    const state = shareState(report, new Date());
    if (state === "expired") return json({ error: "EXPIRED" }, 410);
    if (state !== "active") return json({ error: "NOT_FOUND" }, 404);

    const photos = ((report.photos ?? []) as ReportPhoto[]).filter((p) => p.include);
    const urls = new Map<string, string>();
    for (const bucket of ["job-room-photos", "job-evidence-photos"] as const) {
      const paths = photos.filter((p) => p.bucket === bucket).map((p) => p.path);
      if (paths.length === 0) continue;
      const { data } = await admin.storage.from(bucket).createSignedUrls(paths, TTL);
      for (const row of data ?? []) if (row.signedUrl && row.path) urls.set(`${bucket}/${row.path}`, row.signedUrl);
    }

    let pdfUrl: string | null = null;
    if (report.pdf_path) {
      const { data } = await admin.storage.from("inspection-reports").createSignedUrl(report.pdf_path, TTL);
      pdfUrl = data?.signedUrl ?? null;
    }

    const [{ data: owner }, { data: requests }] = await Promise.all([
      admin.from("profiles").select("company_name").eq("id", report.user_id).maybeSingle(),
      admin
        .from("signature_requests")
        .select("id, status")
        .eq("user_id", report.user_id)
        .eq("document_type", "custom")
        .eq("document_id", report.id)
        .order("created_at", { ascending: false }),
    ]);
    const live = (requests ?? []).find((r) => r.status !== "voided") ?? null;
    const { data: signers } = live
      ? await admin.from("signature_signers").select("name, role, status, signed_at").eq("request_id", live.id).order("signing_order", { ascending: true })
      : { data: [] as { name: string; role: string; status: string; signed_at: string | null }[] };

    // Best-effort view counter (a lost update under a race is harmless).
    await admin
      .from("inspection_reports")
      .update({ view_count: (report.view_count ?? 0) + 1, last_viewed_at: new Date().toISOString() })
      .eq("id", report.id);

    return json({
      report: {
        report_number: report.report_number,
        title: report.title,
        status: report.status,
        overall_result: report.overall_result,
        summary: report.summary,
        checklist: report.checklist ?? [],
        evidence: report.evidence ? { verdict: report.evidence.verdict, summary: report.evidence.summary ?? null } : null,
        customer_name: report.customer_name,
        address: report.address,
        service_type: report.service_type,
        inspector_name: report.inspector_name,
        inspected_at: report.inspected_at,
        signed_at: report.signed_at,
        share_expires_at: report.share_expires_at,
      },
      businessName: owner?.company_name ?? null,
      photos: photos.map((p) => ({ section: p.section, caption: p.caption, url: urls.get(`${p.bucket}/${p.path}`) ?? null })),
      pdfUrl,
      signature: live ? { status: live.status, signers: signers ?? [] } : null,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "inspection_report_public_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
