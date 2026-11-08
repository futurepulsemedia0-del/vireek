// Document Template Studio — authoritative server side.
//   POST { action: "validate", kind: "clause"|"template", version_id }
//   POST { action: "generate", template_version_id, customer_id?, job_id?, title?, locale?, currency?, time_zone?, overrides? }
//   POST { action: "share_create", document_id, version_id?, expires_in_hours?, max_views?, password? }
// All reads/inserts that the user may do run through the user's JWT (RLS). The service role is used only for
// the validation attestation, the share-link row (clients have no access to that table) and the access log.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  FIELD_DEFS,
  resolveValues,
  type CustomerFacts,
  type JobFacts,
  type OrganizationFacts,
} from "../../../src/lib/docTemplates/fieldRegistry.ts";
import {
  renderTemplateVerified,
  validateTemplate,
  type ClauseSnapshot,
  type Diagnostic,
} from "../../../src/lib/docTemplates/mergeEngine.ts";
import { PBKDF2_ITERATIONS, pbkdf2Hex, randomHex, randomToken, sha256Hex } from "../_shared/doc-share/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// deno-lint-ignore no-explicit-any
type Db = any;

interface ClauseRef { slug: string; version: number; sha256: string }

function parseRefs(raw: unknown): ClauseRef[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ClauseRef[] = [];
  for (const r of raw) {
    if (!r || typeof r.slug !== "string" || !Number.isInteger(r.version) || typeof r.sha256 !== "string") return null;
    out.push({ slug: r.slug, version: r.version, sha256: r.sha256.toLowerCase() });
  }
  return out;
}

/** Loads the pinned clause versions through RLS and checks status + hash. Problems become error diagnostics. */
async function loadClauses(caller: Db, refs: ClauseRef[]): Promise<{ clauses: ClauseSnapshot[]; problems: Diagnostic[] }> {
  const problems: Diagnostic[] = [];
  const clauses: ClauseSnapshot[] = [];
  await Promise.all(refs.map(async (ref) => {
    const bad = (message: string) => problems.push({ code: "UNKNOWN_CLAUSE", severity: "error", message, pos: 0 });
    const { data: c } = await caller.from("doc_clauses").select("id").eq("slug", ref.slug).maybeSingle();
    if (!c) return bad(`Clause "${ref.slug}" does not exist.`);
    const { data: v } = await caller.from("doc_clause_versions")
      .select("version_number, body, sha256, status").eq("clause_id", c.id).eq("version_number", ref.version).maybeSingle();
    if (!v || v.status !== "published") return bad(`Clause "${ref.slug}" v${ref.version} is not published.`);
    if (String(v.sha256).toLowerCase() !== ref.sha256) return bad(`Clause "${ref.slug}" v${ref.version} no longer matches its pinned hash.`);
    clauses.push({ slug: ref.slug, version: v.version_number, body: v.body, sha256: String(v.sha256).toLowerCase() });
  }));
  return { clauses, problems };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const caller: Db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const admin: Db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: userData, error: userError } = await caller.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const callerId: string = userData.user.id;

    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    const { data: canManage } = await caller.rpc("can_manage_documents");
    if (!isUuid(ownerId) || canManage !== true) return json({ error: "You do not have permission to manage documents." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    /* ------------------------------ validate ------------------------------ */
    if (action === "validate") {
      const kind = body.kind;
      if ((kind !== "clause" && kind !== "template") || !isUuid(body.version_id)) return json({ error: "Invalid request." }, 400);
      const table = kind === "clause" ? "doc_clause_versions" : "doc_content_template_versions";
      const cols = kind === "clause" ? "id, body, sha256, status" : "id, body, sha256, status, clause_refs";
      const { data: v } = await caller.from(table).select(cols).eq("id", body.version_id).maybeSingle();
      if (!v) return json({ error: "Version not found." }, 404);
      if (v.status !== "draft") return json({ error: "Only drafts can be validated." }, 409);

      let diagnostics: Diagnostic[];
      if (kind === "clause") {
        diagnostics = validateTemplate(v.body, { fields: FIELD_DEFS, clauses: [] });
      } else {
        const refs = parseRefs(v.clause_refs);
        if (!refs) return json({ error: "Malformed clause references." }, 422);
        const { clauses, problems } = await loadClauses(caller, refs);
        diagnostics = [...problems, ...validateTemplate(v.body, { fields: FIELD_DEFS, clauses })];
      }
      const ok = !diagnostics.some((d) => d.severity === "error");
      if (ok) {
        // Compare-and-set: attests exactly the body that was validated, only while it is still that draft.
        const { data: upd, error } = await admin.from(table)
          .update({ validated_sha256: v.sha256 })
          .eq("id", v.id).eq("sha256", v.sha256).eq("status", "draft").select("id");
        if (error || !upd || upd.length !== 1) return json({ error: "The draft changed during validation. Try again." }, 409);
      }
      return json({ ok, diagnostics });
    }

    /* ------------------------------ generate ------------------------------ */
    if (action === "generate") {
      if (!isUuid(body.template_version_id)) return json({ error: "Invalid template version." }, 400);
      if (body.customer_id != null && !isUuid(body.customer_id)) return json({ error: "Invalid customer." }, 400);
      if (body.job_id != null && !isUuid(body.job_id)) return json({ error: "Invalid job." }, 400);
      if (body.currency != null && !/^[A-Z]{3}$/.test(body.currency)) return json({ error: "Invalid currency." }, 400);
      if (body.locale != null && !LOCALE_RE.test(body.locale)) return json({ error: "Invalid locale." }, 400);
      if (body.overrides != null && (typeof body.overrides !== "object" || Array.isArray(body.overrides))) return json({ error: "Invalid overrides." }, 400);

      const { data: ver } = await caller.from("doc_content_template_versions")
        .select("id, template_id, body, status, clause_refs").eq("id", body.template_version_id).maybeSingle();
      if (!ver) return json({ error: "Template version not found." }, 404);
      if (ver.status !== "published") return json({ error: "Only published template versions can generate documents." }, 409);
      const { data: tpl } = await caller.from("doc_content_templates").select("name, locale").eq("id", ver.template_id).maybeSingle();
      if (!tpl) return json({ error: "Template not found." }, 404);
      const refs = parseRefs(ver.clause_refs);
      if (!refs) return json({ error: "Malformed clause references." }, 422);

      let customer: CustomerFacts | null = null;
      if (body.customer_id) {
        const { data } = await caller.from("customers").select("name, email, phone, address, customer_type").eq("id", body.customer_id).maybeSingle();
        if (!data) return json({ error: "Customer not found." }, 404);
        customer = data;
      }
      let job: JobFacts | null = null;
      if (body.job_id) {
        const { data } = await caller.from("jobs").select("service_type, address, scheduled_datetime").eq("id", body.job_id).maybeSingle();
        if (!data) return json({ error: "Job not found." }, 404);
        job = data;
      }
      const { data: org } = await admin.from("profiles").select("company_name, phone, email").eq("id", ownerId).maybeSingle();
      const organization: OrganizationFacts | null = org ?? null;

      const { clauses, problems } = await loadClauses(caller, refs);
      if (problems.length) return json({ error: "clause_problem", diagnostics: problems }, 422);

      const { values, rejected } = resolveValues({ customer, job, organization, overrides: body.overrides });
      if (rejected.length) return json({ error: "invalid_overrides", rejected }, 422);

      const locale: string = body.locale ?? tpl.locale;
      const r = await renderTemplateVerified(ver.body, values, {
        fields: FIELD_DEFS, clauses, locale, currency: body.currency ?? undefined,
        timeZone: typeof body.time_zone === "string" ? body.time_zone : undefined, onMissing: "marker",
      });
      if (!r.ok) return json({ error: "render_failed", diagnostics: r.diagnostics }, 422);
      if (!r.complete) return json({ error: "incomplete", missing: r.missing }, 422);

      const title = (typeof body.title === "string" && body.title.trim() ? body.title.trim() : tpl.name).slice(0, 200);
      const { data: row, error: insErr } = await caller.from("generated_documents").insert({
        template_version_id: ver.id, customer_id: body.customer_id ?? null, job_id: body.job_id ?? null,
        title, locale, currency: body.currency ?? null, rendered_text: r.text,
        input_snapshot: values, clause_refs: r.usedClauses,
      }).select("*").single();
      if (insErr) return json({ error: "Could not save the generated document." }, 400);
      return json({ generated: row });
    }

    /* ----------------------------- share_create ----------------------------- */
    if (action === "share_create") {
      if (!isUuid(body.document_id)) return json({ error: "Invalid document." }, 400);
      if (body.version_id != null && !isUuid(body.version_id)) return json({ error: "Invalid version." }, 400);
      const hours = body.expires_in_hours == null ? 72 : Number(body.expires_in_hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 2159) return json({ error: "Expiry must be 1–2159 hours." }, 400);
      const maxViews = body.max_views == null ? null : Number(body.max_views);
      if (maxViews !== null && (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > 10000)) return json({ error: "Invalid view limit." }, 400);
      const password = body.password == null || body.password === "" ? null : String(body.password);
      if (password !== null && (password.length < 8 || password.length > 128)) return json({ error: "Password must be 8–128 characters." }, 400);

      const { data: doc } = await caller.from("documents").select("id, current_version_id").eq("id", body.document_id).maybeSingle();
      if (!doc) return json({ error: "Document not found." }, 404);
      const versionId: string | null = body.version_id ?? doc.current_version_id ?? null;
      if (!versionId) return json({ error: "The document has no file yet." }, 409);
      const { data: ver } = await caller.from("document_versions").select("id").eq("id", versionId).eq("document_id", doc.id).maybeSingle();
      if (!ver) return json({ error: "Version not found." }, 404);

      const token = randomToken();
      const salt = password === null ? null : randomHex(16);
      const hash = password === null || salt === null ? null : await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
      const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
      const { data: link, error } = await admin.from("document_share_links").insert({
        user_id: ownerId, document_id: doc.id, version_id: ver.id, token_hash: await sha256Hex(token),
        password_hash: hash, password_salt: salt, expires_at: expiresAt, max_views: maxViews, created_by: callerId,
      }).select("id, expires_at").single();
      if (error || !link) return json({ error: "Could not create the link." }, 500);
      await admin.from("document_access_log").insert({
        user_id: ownerId, document_id: doc.id, version_id: ver.id, share_link_id: link.id,
        actor_id: callerId, actor_kind: "member", action: "share_create",
      });
      return json({ link_id: link.id, token, expires_at: link.expires_at, has_password: password !== null });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("doc-studio error", e instanceof Error ? e.message : "unknown");
    return json({ error: "Something went wrong." }, 500);
  }
});
