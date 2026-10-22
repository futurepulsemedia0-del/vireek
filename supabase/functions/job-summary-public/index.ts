// supabase/functions/job-summary-public/index.ts
//
// Public (no-auth) read endpoint behind the customer link /summary/:token.
// Matches ONLY on the unguessable token and only for summaries that were actually delivered
// (sent_at set). Returns display-safe fields: no internal ids, no customer phone/email, no notes.
// Photos are served through short-lived signed URLs.
//
// DEPLOYMENT: supabase functions deploy job-summary-public --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL = 3600;
const BUCKETS = ["job-photos", "job-room-photos"] as const;

interface PhotoRef {
  bucket: (typeof BUCKETS)[number];
  path: string;
  kind: "before" | "after" | "progress";
  caption: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const { token } = (await req.json().catch(() => ({}))) as { token?: unknown };
  if (typeof token !== "string" || !UUID_RE.test(token)) return json({ error: "NOT_FOUND" }, 404);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const { data: s } = await admin
      .from("job_summaries")
      .select(
        "id,user_id,headline,intro,work_summary,work_items,parts,warranty,photos,maintenance_tips,next_service_date,next_service_note," +
          "technician_first_name,service_type,service_date,sent_at,edited_after_send_at,view_count,first_viewed_at",
      )
      .eq("token", token)
      .not("sent_at", "is", null)
      .maybeSingle();
    if (!s) return json({ error: "NOT_FOUND" }, 404);

    const summary = s as Record<string, unknown> & { id: string; user_id: string; photos: PhotoRef[]; view_count: number; first_viewed_at: string | null };

    const urls = new Map<string, string>();
    for (const bucket of BUCKETS) {
      const paths = (summary.photos ?? []).filter((p) => p.bucket === bucket).map((p) => p.path);
      if (paths.length === 0) continue;
      const { data } = await admin.storage.from(bucket).createSignedUrls(paths, TTL);
      for (const row of data ?? []) if (row.signedUrl && row.path) urls.set(`${bucket}/${row.path}`, row.signedUrl);
    }
    const photos = (summary.photos ?? [])
      .map((p) => ({ url: urls.get(`${p.bucket}/${p.path}`) ?? null, kind: p.kind, caption: p.caption }))
      .filter((p): p is { url: string; kind: PhotoRef["kind"]; caption: string | null } => !!p.url);

    const { data: profile } = await admin.from("profiles").select("company_name,phone").eq("id", summary.user_id).maybeSingle();

    // Best-effort engagement counter (a lost update under a race is harmless).
    const now = new Date().toISOString();
    await admin
      .from("job_summaries")
      .update({ view_count: (summary.view_count ?? 0) + 1, last_viewed_at: now, first_viewed_at: summary.first_viewed_at ?? now })
      .eq("id", summary.id);

    return json({
      summary: {
        business_name: (profile as { company_name: string | null } | null)?.company_name ?? null,
        business_phone: (profile as { phone: string | null } | null)?.phone ?? null,
        headline: summary.headline,
        intro: summary.intro,
        work_summary: summary.work_summary,
        work_items: summary.work_items,
        parts: summary.parts,
        warranty: summary.warranty,
        maintenance_tips: summary.maintenance_tips,
        next_service_date: summary.next_service_date,
        next_service_note: summary.next_service_note,
        technician_first_name: summary.technician_first_name,
        service_type: summary.service_type,
        service_date: summary.service_date,
        sent_at: summary.sent_at,
        updated_at: summary.edited_after_send_at ?? null,
        photos,
      },
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "job_summary_public_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
