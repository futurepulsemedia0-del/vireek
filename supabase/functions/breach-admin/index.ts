// supabase/functions/breach-admin/index.ts
//
// Staff-only, READ-ONLY breach scoping tool (POST { action, ... }). Staff = is_vireek_staff(caller), verified on every call.
//   registry       -> tables + data categories the tool can scan
//   scan           -> given an incident window and tables, list affected tenants and data categories
//   render_notices -> re-runs the scan server-side and renders DRAFT notices (+ an internal summary). Nothing is sent.
//
// It never modifies customer data: tenants are found through public.breach_scan_table (STABLE, SELECT-only, service_role only),
// and the only write is one audit_log row per call (window, tables, counts: no tenant identities, no notice text).
// Table / column names come from _shared/breach/registry.ts, never from the request.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { BREACH_TABLES, CATEGORIES, getBreachTable } from "../_shared/breach/registry.ts";
import { PER_TABLE_TENANT_LIMIT, aggregateScan, parseScanRequest, type ScanRequest, type TableScan } from "../_shared/breach/scan.ts";
import { clean, renderInternalSummary, renderTenantNotice, type IncidentInput, type TenantContact } from "../_shared/breach/notice.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTICES = 200;
const MAX_TENANTS_RETURNED = 2000;

type Admin = ReturnType<typeof createClient>;

async function runScan(admin: Admin, req: ScanRequest) {
  const results: TableScan[] = [];
  for (const name of req.tables) {
    const def = getBreachTable(name)!;
    const { data, error } = await admin.rpc("breach_scan_table", {
      p_table: def.table, p_tenant_col: def.tenantColumn, p_time_col: def.timeColumn,
      p_from: req.from, p_to: req.to, p_mode: req.mode, p_limit: PER_TABLE_TENANT_LIMIT,
    });
    results.push(error ? { table: name, rows: [], error: String(error.message ?? "scan failed").slice(0, 120) } : { table: name, rows: (data ?? []) as TableScan["rows"] });
  }
  return aggregateScan(results);
}

function parseIncident(body: Record<string, unknown>, req: ScanRequest): IncidentInput {
  const s = (k: string, max: number) => (typeof body[k] === "string" ? clean(body[k] as string, max) : "");
  const discovered = typeof body.discovered_at === "string" && !Number.isNaN(Date.parse(body.discovered_at)) ? new Date(body.discovered_at).toISOString() : new Date().toISOString();
  return {
    reference: s("reference", 60), title: s("title", 160), discoveredAt: discovered, windowFrom: req.from, windowTo: req.to, mode: req.mode,
    whatHappened: s("what_happened", 2000), containment: s("containment", 2000), consequences: s("consequences", 2000),
    contactName: s("contact_name", 120), contactEmail: s("contact_email", 200),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not authenticated" }, 401);
  const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: user.id });
  if (isStaff !== true) return json({ error: "Forbidden" }, 403);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!body || !action) return json({ error: "action is required" }, 400);

  const audit = (act: string, meta: Record<string, unknown>) =>
    admin.from("audit_log").insert({ user_id: user.id, actor_id: user.id, actor_email: user.email ?? null, action: act, target_table: "breach_scan", target_id: user.id, metadata: meta });

  try {
    if (action === "registry") {
      return json({
        tables: BREACH_TABLES.map((t) => ({ table: t.table, label: t.label, categories: t.categories })),
        categories: Object.values(CATEGORIES).map((c) => ({ id: c.id, label: c.label, description: c.description })),
      });
    }

    if (action === "scan" || action === "render_notices") {
      const parsed = parseScanRequest(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const summary = await runScan(admin, parsed.value);

      // Names for the UI / notices. Read-only select on profiles, in chunks.
      const ids = summary.tenants.map((t) => t.tenantId);
      const contacts = new Map<string, TenantContact>();
      const wanted = action === "scan" ? ids.slice(0, MAX_TENANTS_RETURNED) : (Array.isArray(body.tenant_ids) ? (body.tenant_ids as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x) && ids.includes(x)) : ids).slice(0, MAX_NOTICES);
      for (let i = 0; i < wanted.length; i += 200) {
        const { data } = await admin.from("profiles").select("id, email, full_name, company_name").in("id", wanted.slice(i, i + 200));
        for (const p of data ?? []) contacts.set(p.id as string, { tenantId: p.id as string, companyName: (p.company_name as string | null) ?? null, fullName: (p.full_name as string | null) ?? null, email: (p.email as string | null) ?? null });
      }

      await audit(action === "scan" ? "breach.scan" : "breach.render_notices", {
        from: parsed.value.from, to: parsed.value.to, mode: parsed.value.mode, tables: parsed.value.tables,
        tenants: summary.tenants.length, complete: summary.complete, notices: action === "render_notices" ? wanted.length : undefined,
      });

      if (action === "scan") {
        return json({
          complete: summary.complete,
          tableResults: summary.tableResults,
          categoryTenantCounts: summary.categoryTenantCounts,
          tenantTotal: summary.tenants.length,
          tenantsReturned: wanted.length,
          tenants: summary.tenants.slice(0, MAX_TENANTS_RETURNED).map((t) => ({
            tenantId: t.tenantId, categories: t.categories, totalRows: t.totalRows, tables: t.tables,
            companyName: contacts.get(t.tenantId)?.companyName ?? null, fullName: contacts.get(t.tenantId)?.fullName ?? null,
          })),
        });
      }

      const incident = parseIncident(body, parsed.value);
      const labels = Object.fromEntries(BREACH_TABLES.map((t) => [t.table, t.label]));
      const drafts = summary.tenants
        .filter((t) => wanted.includes(t.tenantId))
        .map((t) => renderTenantNotice(incident, contacts.get(t.tenantId) ?? { tenantId: t.tenantId, companyName: null, fullName: null, email: null }, t));
      return json({ complete: summary.complete, tenantTotal: summary.tenants.length, drafts, internalSummary: renderInternalSummary(incident, summary, labels), sent: false });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "breach_admin_error", action, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal error" }, 500);
  }
});
