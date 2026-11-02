// supabase/functions/shadow-report/index.ts
//
// Proof-of-Value report for the caller's own Shadow Mode trial.
//   POST { format?: "html" | "pdf" | "json", locale?: "en" | "es" }
//   html -> text/html, pdf -> application/pdf, json -> payload.
// After Day 7 the stored report is returned; before that a live PREVIEW is computed (same estimate
// labelling). Runs as the user for the permission check; the service role is used only to compute
// aggregates for the one trial row that RLS already returned to the caller.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@2.5.2";
import { loadRegional } from "../_shared/regional/regional.ts";
import { computeReportPayload, type TrialRow } from "../_shared/shadow/runtime.ts";
import { buildReportPdf, renderReportHtml, type ReportPayload } from "../_shared/shadow/report.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    let body: { format?: string; locale?: string } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    const format = body.format === "pdf" || body.format === "json" ? body.format : "html";
    const locale = body.locale === "es" ? "es" : "en";

    const { data: trial } = await authClient.from("shadow_trials").select("*").limit(1).maybeSingle();
    if (!trial) return json({ error: "No Shadow Mode trial found." }, 404);
    const t = trial as TrialRow;

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    let payload: ReportPayload;
    let preview = false;
    const { data: stored } = await authClient.from("shadow_reports").select("payload").eq("trial_id", t.id).maybeSingle();
    if (stored?.payload) payload = stored.payload as ReportPayload;
    else { payload = await computeReportPayload(admin, t, new Date().toISOString()); preview = true; }

    const { data: prof } = await authClient.from("profiles").select("company_name").eq("id", t.user_id).maybeSingle();
    const regional = await loadRegional(admin, t.user_id);
    const opts = { companyName: prof?.company_name ?? "", locale, currency: regional.currency };

    if (format === "json") return json({ preview, payload });
    if (format === "pdf") {
      const bytes = buildReportPdf(jsPDF as never, payload, opts);
      return new Response(bytes, { status: 200, headers: { ...cors, "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="shadow-mode-proof-of-value.pdf"', "Cache-Control": "no-store" } });
    }
    return new Response(renderReportHtml(payload, opts), { status: 200, headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Shadow-Preview": preview ? "1" : "0" } });
  } catch (err) {
    console.error("shadow-report failed", err instanceof Error ? err.message : err);
    return json({ error: "Could not build the report." }, 502);
  }
});
