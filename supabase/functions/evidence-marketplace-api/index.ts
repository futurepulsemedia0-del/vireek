// supabase/functions/evidence-marketplace-api/index.ts
//
// The partner-facing Vireek Evidence Marketplace API. Partners (OEMs, parts
// suppliers, insurers, contractors, training providers) authenticate with a
// partner key (vev_live_...), issued by Vireek staff. The key is verified by
// SHA-256 hash; the raw key is never stored.
//
// What a partner can ever receive: the latest IMMUTABLE release of anonymized,
// k-anonymous, rounded, noise-protected aggregate patterns. No tenant, customer,
// job, technician, address, phone or free text exists in the tables this
// function reads, so there is nothing to leak even if this function has a bug.
//
// Routes (GET):
//   /evidence-marketplace-api/products               products this partner may use
//   /evidence-marketplace-api/release                latest release metadata + content hash
//   /evidence-marketplace-api/patterns?product=...   patterns for one product
//       filters: industry, job_type, root_cause, make, age_band, min_grade (A|B|C)
//       paging:  limit (1-200, default 50), cursor (opaque, from next_cursor)
//
// Deploy:
//   supabase functions deploy evidence-marketplace-api --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const LICENSE =
  "Aggregate statistics licensed for the purpose agreed in your Vireek contract. Re-identification of any business, customer or technician, or combining this data to attempt it, is prohibited.";

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SAFE_KEY = /^[a-z0-9_\-]{1,60}$/;
const SAFE_MAKE = /^[a-z0-9_\-*]{1,60}$/;
const AGE_BANDS = new Set(["0-5", "6-10", "11-15", "16+"]);
const GRADE_RANK: Record<string, string[]> = { A: ["A"], B: ["A", "B"], C: ["A", "B", "C"] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface PartnerRow {
  id: string;
  name: string;
  partner_type: string;
  status: string;
  contract_expires_at: string | null;
  allowed_products: string[];
  rate_limit_per_minute: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- Authenticate the partner key ---------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) return json({ error: "Missing Authorization header. Use: Authorization: Bearer vev_live_..." }, 401);

  const { data: keyRow } = await admin
    .from("evidence_partner_keys")
    .select("id, partner_id, revoked_at, partner:evidence_partners!inner(id, name, partner_type, status, contract_expires_at, allowed_products, rate_limit_per_minute)")
    .eq("key_hash", await sha256Hex(rawKey))
    .maybeSingle();

  const partner = (keyRow?.partner ?? null) as unknown as PartnerRow | null;
  if (!keyRow || keyRow.revoked_at || !partner) return json({ error: "Invalid or revoked API key" }, 401);
  if (partner.status !== "active") return json({ error: "This partner account is not active" }, 403);
  if (partner.contract_expires_at && partner.contract_expires_at < new Date().toISOString().slice(0, 10)) {
    return json({ error: "Your data agreement has expired. Contact Vireek to renew." }, 403);
  }

  // ---- Rate limit (per key, rolling minute) -------------------------------
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await admin
    .from("evidence_access_log")
    .select("id", { count: "exact", head: true })
    .eq("key_id", keyRow.id)
    .gte("created_at", since);
  if ((recent ?? 0) >= partner.rate_limit_per_minute) {
    return json({ error: "Rate limit exceeded" }, 429, { "Retry-After": "30" });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/evidence-marketplace-api\/?/, "").split("/").filter(Boolean)[0] ?? "";

  // Products this partner is entitled to: allowed by contract AND valid for its type.
  const { data: products } = await admin
    .from("evidence_products")
    .select("slug, name, description, partner_types, scope, fields")
    .order("sort_order");
  const entitled = (products ?? []).filter(
    (p) => partner.allowed_products.includes(p.slug) && (p.partner_types as string[]).includes(partner.partner_type),
  );

  const touch = () => admin.from("evidence_partner_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});
  const log = (product: string, releaseId: string | null, rows: number) =>
    admin.from("evidence_access_log").insert({ partner_id: partner.id, key_id: keyRow.id, product, release_id: releaseId, rows_returned: rows }).then(() => {});

  if (route === "products") {
    touch();
    await log("products", null, entitled.length);
    return json({ data: entitled.map(({ slug, name, description, fields }) => ({ slug, name, description, fields })) });
  }

  const { data: release } = await admin
    .from("evidence_releases")
    .select("id, period_start, period_end, pattern_count, content_hash, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (route === "release") {
    touch();
    await log("release", release?.id ?? null, release ? 1 : 0);
    return json({ data: release ?? null, license: LICENSE });
  }

  if (route !== "patterns") {
    return json({ error: "Not found. Available routes: products, release, patterns" }, 404);
  }

  // ---- /patterns ----------------------------------------------------------
  const slug = url.searchParams.get("product") ?? "";
  const product = entitled.find((p) => p.slug === slug);
  if (!product) {
    return json({ error: `Unknown or not-licensed product. Licensed: ${entitled.map((p) => p.slug).join(", ") || "none"}` }, 403);
  }
  if (!release) return json({ data: [], next_cursor: null, release: null, license: LICENSE });

  const industry = url.searchParams.get("industry");
  const jobType = url.searchParams.get("job_type");
  const rootCause = url.searchParams.get("root_cause");
  const make = url.searchParams.get("make");
  const ageBand = url.searchParams.get("age_band");
  const minGrade = (url.searchParams.get("min_grade") ?? "C").toUpperCase();
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  for (const [name, value] of [["industry", industry], ["job_type", jobType], ["root_cause", rootCause]] as const) {
    if (value !== null && !SAFE_KEY.test(value)) return json({ error: `Invalid ${name}` }, 400);
  }
  if (make !== null && !SAFE_MAKE.test(make)) return json({ error: "Invalid make" }, 400);
  if (ageBand !== null && !AGE_BANDS.has(ageBand)) return json({ error: "Invalid age_band. Use 0-5, 6-10, 11-15 or 16+" }, 400);
  if (!GRADE_RANK[minGrade]) return json({ error: "Invalid min_grade. Use A, B or C" }, 400);
  if (cursor !== null && !UUID.test(cursor)) return json({ error: "Invalid cursor" }, 400);

  const fields = product.fields as string[];
  let query = admin
    .from("evidence_patterns")
    .select(["id", ...fields].join(","))
    .eq("release_id", release.id)
    .in("grade", GRADE_RANK[minGrade])
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (product.scope !== "all") query = query.eq("scope", product.scope);
  if (industry) query = query.eq("industry", industry);
  if (jobType) query = query.eq("job_type_key", jobType);
  if (rootCause) query = query.eq("root_cause_key", rootCause);
  if (make) query = query.eq("make", make);
  if (ageBand) query = query.eq("age_band", ageBand);
  if (cursor) query = query.gt("id", cursor);

  const { data, error } = await query;
  if (error) return json({ error: "Query failed" }, 500);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  touch();
  await log(product.slug, release.id, page.length);

  return json({
    data: page.map(({ id, ...rest }) => ({ pattern_id: id, ...rest })),
    next_cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    release: { id: release.id, period_start: release.period_start, period_end: release.period_end, content_hash: release.content_hash },
    methodology: "k>=5 businesses and >=30 observations per pattern; single-business share <=40%; counts rounded down to 2 significant digits; rates carry calibrated noise; rework excluded; grade reflects evidence-backed share.",
    license: LICENSE,
  });
});
