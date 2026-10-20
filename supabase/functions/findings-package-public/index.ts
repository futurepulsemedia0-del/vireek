// Public (no-auth) endpoint behind the customer link /findings/:token.
// Matches ONLY on the unguessable share_token. Returns display-safe fields
// (no customer email/phone, no account ids, no storage paths) and short-lived
// signed photo URLs from the private `job-photos` bucket.
//
//   { action: "get", token }                          → report
//   { action: "respond", token, decisions, approver_name? } → approval result
//
// Approval is computed and applied in SQL (respond_to_findings_package) so the
// price the customer approves is always recomputed server-side.
//
// Deploy with JWT verification OFF (public link): supabase functions deploy findings-package-public --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isUuid, parseResponseBody, shareState, sortFindings } from "../_shared/findings/engine.ts";

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

const TTL = 3600;
const BUCKET = "job-photos";

// Postgres error codes raised by respond_to_findings_package → HTTP.
const SQL_ERRORS: Record<string, { status: number; error: string }> = {
  P0002: { status: 404, error: "NOT_FOUND" },
  P0003: { status: 410, error: "EXPIRED" },
  P0004: { status: 409, error: "ALREADY_RESPONDED" },
  "22023": { status: 422, error: "INVALID_DECISIONS" },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.token;
  if (!isUuid(token)) return json({ error: "NOT_FOUND" }, 404);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    if (body?.action === "respond") {
      const parsed = parseResponseBody(body);
      if (!parsed.ok) return json({ error: parsed.error }, 422);

      const { data, error } = await admin.rpc("respond_to_findings_package", {
        p_token: token,
        p_decisions: parsed.decisions,
        p_approver_name: parsed.approverName,
      });
      if (error) {
        const mapped = SQL_ERRORS[(error as { code?: string }).code ?? ""] ??
          (error.message?.includes("INCOMPLETE_DECISIONS") ? { status: 422, error: "INCOMPLETE_DECISIONS" } : null) ??
          (error.message?.includes("INVALID_OPTION") ? { status: 422, error: "INVALID_OPTION" } : null);
        if (mapped) return json({ error: mapped.error }, mapped.status);
        throw error;
      }
      return json({ result: data });
    }

    // ---- default: get ----
    const { data: pkg } = await admin.from("findings_packages").select("*").eq("share_token", token).maybeSingle();
    if (!pkg) return json({ error: "NOT_FOUND" }, 404);

    const state = shareState(pkg, new Date());
    if (state === "draft" || state === "disabled") return json({ error: "NOT_FOUND" }, 404);
    if (state === "expired") return json({ error: "EXPIRED" }, 410);

    const { data: rows } = await admin
      .from("findings_package_items")
      .select("id, sort_order, storage_path, title, description, severity, annotations, options, recommended_option_id, decision, approved_option_id, approved_cents")
      .eq("package_id", pkg.id);
    const items = sortFindings(rows ?? []);

    const paths = items.map((i) => i.storage_path as string).filter(Boolean);
    const urls = new Map<string, string>();
    if (paths.length) {
      const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, TTL);
      for (const row of signed ?? []) if (row.signedUrl && row.path) urls.set(row.path, row.signedUrl);
    }

    const { data: owner } = await admin.from("profiles").select("company_name").eq("id", pkg.user_id).maybeSingle();

    // Best-effort view counter — only while the customer still has to decide.
    if (state === "active") {
      await admin
        .from("findings_packages")
        .update({
          view_count: (pkg.view_count ?? 0) + 1,
          last_viewed_at: new Date().toISOString(),
          first_viewed_at: pkg.first_viewed_at ?? new Date().toISOString(),
        })
        .eq("id", pkg.id);
    }

    return json({
      package: {
        title: pkg.title,
        summary: pkg.summary,
        status: pkg.status,
        customer_name: pkg.customer_name,
        address: pkg.address,
        technician_name: pkg.technician_name,
        tax_percent: pkg.tax_percent,
        sent_at: pkg.sent_at,
        share_expires_at: pkg.share_expires_at,
        responded_at: pkg.responded_at,
        approved_total_cents: pkg.approved_total_cents,
      },
      businessName: owner?.company_name ?? null,
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        description: i.description,
        severity: i.severity,
        annotations: i.annotations ?? [],
        options: i.options ?? [],
        recommended_option_id: i.recommended_option_id,
        decision: i.decision,
        approved_option_id: i.approved_option_id,
        approved_cents: i.approved_cents,
        photo_url: urls.get(i.storage_path as string) ?? null,
      })),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "findings_package_public_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
