// supabase/functions/quote-truth-engine/index.ts
//
// Vireek Quote Truth Engine: "is this quote actually reasonable, and what will
// it cost us in acceptance, margin and trust?"
//
// Deterministic on purpose (same idiom as check-margin-guardrail): no LLM, no
// external call. This function only GATHERS the account's own data and hands it
// to the pure engine in _shared/quote-truth/engine.ts.
//
// Security model
//   - Caller identity comes from their own JWT. Every read goes through a
//     client scoped to that JWT, so Postgres RLS enforces the account boundary
//     (a stranger's quoteId simply 404s).
//   - Cost / margin data is only returned to the account owner or a team member
//     with can_view_billing; everyone else gets a redacted report.
//   - The analysis row and the cached quote summary are written with the
//     service-role client, so a verdict can't be forged through the REST API.
//   - Light per-user rate limit (counted from the append-only analyses table).
//   - Advisory only: this function never blocks or sends a quote.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  analyzeQuote,
  redactCostData,
  type CohortSignals,
  type Complexity,
  type CompetitorBenchmark,
  type CustomerSignals,
  type EquipmentSignal,
  type HistoricalQuote,
  type PriceBookEntry,
  type TechnicianLevel,
  type TruthContext,
  type TruthLineItem,
} from "../_shared/quote-truth/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TECH_LEVELS: TechnicianLevel[] = ["junior", "standard", "senior", "master"];
const COMPLEXITIES: Complexity[] = ["routine", "moderate", "complex", "emergency"];
const RATE_LIMIT_PER_MINUTE = 30;
const HISTORY_LOOKBACK_DAYS = 730;

function sanitizeContext(raw: unknown): TruthContext {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const miles = Number(c.travel_miles);
  return {
    technician_level: TECH_LEVELS.includes(c.technician_level as TechnicianLevel)
      ? (c.technician_level as TechnicianLevel)
      : "standard",
    complexity: COMPLEXITIES.includes(c.complexity as Complexity) ? (c.complexity as Complexity) : "routine",
    after_hours: c.after_hours === true,
    travel_miles: c.travel_miles !== null && c.travel_miles !== undefined && c.travel_miles !== "" && Number.isFinite(miles)
      ? Math.min(500, Math.max(0, miles))
      : null,
  };
}

function cleanLines(raw: unknown): TruthLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const r = (l ?? {}) as Record<string, unknown>;
      return {
        description: String(r.description ?? "").slice(0, 300),
        quantity: Number(r.quantity),
        unit_price_cents: Number(r.unit_price_cents),
      };
    })
    .filter((l) => Number.isFinite(l.quantity) && Number.isFinite(l.unit_price_cents));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }

    const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
    if (!UUID_RE.test(quoteId)) return json({ error: "Missing or invalid quoteId." }, 400);
    const context = sanitizeContext(body.context);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const caller = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // Quote through the caller's client: RLS scopes it to the account.
    const { data: quote, error: quoteError } = await caller
      .from("quotes")
      .select("id, user_id, customer_id, customer_name, customer_phone, customer_email, line_items, tax_percent, discount_type, discount_value, deposit_percent")
      .eq("id", quoteId)
      .maybeSingle();
    if (quoteError || !quote) return json({ error: "Quote not found." }, 404);

    const ownerId: string = quote.user_id;

    // Who is asking, and may they see cost data?
    let canSeeCosts = user.id === ownerId;
    if (!canSeeCosts) {
      const { data: member } = await admin
        .from("team_members")
        .select("id, account_owner_id, permissions")
        .eq("member_email", (user.email ?? "").toLowerCase())
        .maybeSingle();
      if (!member || member.account_owner_id !== ownerId) return json({ error: "Not authorized for this quote." }, 403);
      canSeeCosts = !!(member.permissions as Record<string, boolean> | null)?.can_view_billing;
    }

    // Rate limit (counted from the append-only analyses table).
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count: recent } = await admin
      .from("quote_truth_analyses")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("created_at", since);
    if ((recent ?? 0) >= RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Too many analyses in the last minute. Please wait a moment." }, 429);
    }

    const lineItems = cleanLines(quote.line_items);
    if (lineItems.length === 0) return json({ error: "This quote has no line items to analyze." }, 400);

    const now = new Date();
    const historySince = new Date(now.getTime() - HISTORY_LOOKBACK_DAYS * 86_400_000).toISOString();
    const degraded: string[] = [];

    // Resolve the customer (explicit link first, then exact email / phone).
    let customerId: string | null = quote.customer_id ?? null;
    if (!customerId && (quote.customer_email || quote.customer_phone)) {
      let q = caller.from("customers").select("id").eq("user_id", ownerId).limit(1);
      q = quote.customer_email ? q.eq("email", quote.customer_email) : q.eq("phone", quote.customer_phone as string);
      const { data: found } = await q.maybeSingle();
      customerId = found?.id ?? null;
    }

    const [
      profileRes,
      settingsRes,
      priceBookRes,
      historyRes,
      competitorRes,
      customerRes,
      jobsRes,
      equipmentRes,
    ] = await Promise.all([
      caller.from("business_profile").select("margin_floor_pct, default_cost_ratio_pct, primary_industry, service_area").eq("user_id", ownerId).maybeSingle(),
      caller.from("quote_truth_settings").select("region_label, regional_price_index, max_premium_pct").eq("user_id", ownerId).maybeSingle(),
      caller
        .from("price_book_items")
        .select("service_name, category, keywords, pricing_model, price_cents, price_max_cents, estimated_cost_cents")
        .eq("user_id", ownerId)
        .eq("active", true)
        .limit(1000),
      caller
        .from("quotes")
        .select("id, status, line_items, created_at, customer_id, customer_name")
        .eq("user_id", ownerId)
        .neq("id", quoteId)
        .in("status", ["accepted", "declined", "expired"])
        .gte("created_at", historySince)
        .order("created_at", { ascending: false })
        .limit(400),
      caller
        .from("quote_competitor_benchmarks")
        .select("service_keyword, region_label, low_cents, high_cents, source_label, observed_at")
        .eq("user_id", ownerId)
        .limit(200),
      customerId
        ? caller.from("customers").select("lifecycle_stage").eq("id", customerId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      customerId
        ? caller.from("jobs").select("job_status, invoice_amount, invoice_status").eq("customer_id", customerId).limit(500)
        : Promise.resolve({ data: [], error: null }),
      customerId
        ? caller
            .from("equipment")
            .select("equipment_type, make, install_date, expected_lifespan_years, warranty_expires_at, status")
            .eq("customer_id", customerId)
            .eq("status", "active")
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (profileRes.error) degraded.push("business profile");
    if (settingsRes.error) degraded.push("Truth Engine settings");
    if (priceBookRes.error) degraded.push("Price Book");
    if (historyRes.error) degraded.push("quote history");
    if (competitorRes.error) degraded.push("competitor benchmarks");
    if (customerRes.error || jobsRes.error) degraded.push("customer history");
    if (equipmentRes.error) degraded.push("equipment records");

    const profile = profileRes.data;
    const settingsRow = settingsRes.data;

    // Network cohort context (k-anonymous, readable by any authenticated tenant).
    let cohort: CohortSignals | null = null;
    const industry: string | null = profile?.primary_industry ?? null;
    {
      const industries = industry ? [industry, "all"] : ["all"];
      const { data: cohortRows, error: cohortErr } = await caller
        .from("benchmark_cohort_stats")
        .select("industry, metric, p25, p50, p75, contributor_count, period_end")
        .in("industry", industries)
        .in("metric", ["avg_ticket_cents", "quote_acceptance_rate"])
        .order("period_end", { ascending: false })
        .limit(24);
      if (cohortErr) {
        degraded.push("network cohort stats");
      } else if (cohortRows && cohortRows.length > 0) {
        const pick = (metric: string) => {
          const rows = cohortRows.filter((r) => r.metric === metric);
          return rows.find((r) => r.industry === industry) ?? rows[0] ?? null;
        };
        const ticket = pick("avg_ticket_cents");
        const accept = pick("quote_acceptance_rate");
        if (ticket || accept) {
          cohort = {
            contributor_count: Number(ticket?.contributor_count ?? accept?.contributor_count ?? 0),
            ticket_p25_cents: ticket ? Number(ticket.p25) : null,
            ticket_p50_cents: ticket ? Number(ticket.p50) : null,
            ticket_p75_cents: ticket ? Number(ticket.p75) : null,
            acceptance_rate_p50_pct: accept ? Number(accept.p50) : null,
          };
        }
      }
    }

    const history: HistoricalQuote[] = (historyRes.data ?? []).map((h) => ({
      id: h.id as string,
      status: h.status as HistoricalQuote["status"],
      created_at: h.created_at as string,
      customer_id: (h.customer_id as string | null) ?? null,
      line_items: cleanLines(h.line_items),
    }));

    let customer: CustomerSignals | null = null;
    if (customerId) {
      const jobs = (jobsRes.data ?? []) as { job_status: string; invoice_amount: number | null; invoice_status: string }[];
      const completed = jobs.filter((j) => j.job_status === "completed");
      const paidRevenue = completed
        .filter((j) => j.invoice_status === "paid" && j.invoice_amount !== null)
        .reduce((s, j) => s + Math.round(Number(j.invoice_amount) * 100), 0);
      const sameCustomer = (historyRes.data ?? []).filter(
        (h) =>
          h.customer_id === customerId ||
          (!h.customer_id && String(h.customer_name ?? "").trim().toLowerCase() === String(quote.customer_name ?? "").trim().toLowerCase()),
      );
      customer = {
        lifecycle_stage: (customerRes.data?.lifecycle_stage as CustomerSignals["lifecycle_stage"]) ?? null,
        completed_jobs: completed.length,
        lifetime_revenue_cents: paidRevenue,
        prior_accepted: sameCustomer.filter((h) => h.status === "accepted").length,
        prior_declined: sameCustomer.filter((h) => h.status === "declined" || h.status === "expired").length,
      };
    }

    const priceBook: PriceBookEntry[] = (priceBookRes.data ?? []).map((p) => ({
      service_name: String(p.service_name ?? ""),
      category: (p.category as string | null) ?? null,
      keywords: Array.isArray(p.keywords) ? (p.keywords as string[]) : [],
      pricing_model: p.pricing_model as PriceBookEntry["pricing_model"],
      price_cents: Number(p.price_cents) || 0,
      price_max_cents: p.price_max_cents === null || p.price_max_cents === undefined ? null : Number(p.price_max_cents),
      estimated_cost_cents:
        p.estimated_cost_cents === null || p.estimated_cost_cents === undefined ? null : Number(p.estimated_cost_cents),
    }));

    const equipment: EquipmentSignal[] = (equipmentRes.data ?? []).map((e) => ({
      equipment_type: String(e.equipment_type ?? ""),
      make: (e.make as string | null) ?? null,
      install_date: (e.install_date as string | null) ?? null,
      expected_lifespan_years: Number(e.expected_lifespan_years) || 15,
      warranty_expires_at: (e.warranty_expires_at as string | null) ?? null,
      status: e.status as EquipmentSignal["status"],
    }));

    const competitors: CompetitorBenchmark[] = (competitorRes.data ?? []).map((c) => ({
      service_keyword: String(c.service_keyword ?? ""),
      region_label: (c.region_label as string | null) ?? null,
      low_cents: Number(c.low_cents) || 0,
      high_cents: Number(c.high_cents) || 0,
      source_label: (c.source_label as string | null) ?? null,
      observed_at: String(c.observed_at ?? ""),
    }));

    let report;
    try {
      report = analyzeQuote({
        now: now.toISOString(),
        quote: {
          line_items: lineItems,
          tax_percent: Number(quote.tax_percent) || 0,
          discount_type: quote.discount_type === "percent" || quote.discount_type === "flat" ? quote.discount_type : null,
          discount_value: quote.discount_value === null || quote.discount_value === undefined ? null : Number(quote.discount_value),
          deposit_percent: Number(quote.deposit_percent) || 0,
        },
        settings: {
          margin_floor_pct: Number(profile?.margin_floor_pct ?? 20),
          default_cost_ratio_pct: Number(profile?.default_cost_ratio_pct ?? 55),
          regional_price_index: Number(settingsRow?.regional_price_index ?? 1),
          max_premium_pct: Number(settingsRow?.max_premium_pct ?? 12),
          region_label: (settingsRow?.region_label as string | null) ?? (profile?.service_area as string | null) ?? null,
        },
        context,
        priceBook,
        history,
        customer,
        equipment,
        competitors,
        cohort,
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Could not analyze this quote." }, 400);
    }

    if (degraded.length > 0) {
      report.data_quality.notes.push(`Some data could not be loaded, so the analysis ran without it: ${degraded.join(", ")}.`);
    }

    // Persist (service role). A failure here must not lose the analysis.
    let analysisId: string | null = null;
    let persisted = true;
    try {
      const { data: inserted, error: insertError } = await admin
        .from("quote_truth_analyses")
        .insert({
          user_id: ownerId,
          quote_id: quoteId,
          requested_by: user.id,
          engine_version: report.engine_version,
          verdict: report.verdict,
          subtotal_cents: report.quote.subtotal_cents,
          expected_low_cents: report.expected.low_cents,
          expected_high_cents: report.expected.high_cents,
          rejection_probability: report.risk.rejection_probability,
          overcharge_level: report.risk.overcharge_level,
          overcharge_score: report.risk.overcharge_score,
          recommended_subtotal_cents: report.optimization.recommended.price_cents,
          context,
          report,
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      analysisId = inserted?.id ?? null;

      const { error: cacheError } = await admin
        .from("quotes")
        .update({
          truth_verdict: report.verdict,
          truth_expected_low_cents: report.expected.low_cents,
          truth_expected_high_cents: report.expected.high_cents,
          truth_rejection_probability: report.risk.rejection_probability,
          truth_overcharge_level: report.risk.overcharge_level,
          truth_analyzed_at: report.computed_at,
        })
        .eq("id", quoteId);
      if (cacheError) throw cacheError;
    } catch (err) {
      persisted = false;
      console.error("quote-truth-engine: persist failed", err);
    }

    return json({
      analysis_id: analysisId,
      persisted,
      report: canSeeCosts ? report : redactCostData(report),
    });
  } catch (err) {
    console.error("quote-truth-engine: unexpected error", err);
    return json({ error: "Unexpected error while analyzing the quote." }, 500);
  }
});
