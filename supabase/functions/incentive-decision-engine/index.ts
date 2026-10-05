// supabase/functions/incentive-decision-engine/index.ts
//
// Vireek Incentive Decision Engine: "which incentives apply to this project,
// and what does the customer really pay?"
//
// Deterministic on purpose (same idiom as quote-truth-engine): no LLM, no
// external call. This function only GATHERS the account's own data and hands it
// to the pure engine in _shared/incentives/engine.ts.
//
// Security model
//   - Caller identity comes from their own JWT. Every read goes through a client
//     scoped to that JWT, so Postgres RLS enforces the account boundary (a
//     stranger's quoteId simply 404s).
//   - Only the account owner or a team member with can_view_billing may run it.
//   - The assessment row, the cached quote summary and the remembered customer
//     profile are written with the service-role client, so none of them can be
//     forged through the REST API.
//   - Light per-user rate limit (counted from the append-only assessments table).
//   - Advisory only: this function never changes a quote.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  assessIncentives,
  type BenefitKind,
  type CustomerKind,
  type Delivery,
  type FundingStatus,
  type IncentiveLineItem,
  type IncentiveProgram,
  type IncentiveProject,
  type PercentBasis,
  type ProgramType,
} from "../_shared/incentives/engine.ts";

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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_LIMIT_PER_MINUTE = 30;

const PROGRAM_TYPES: ProgramType[] = ["utility_rebate", "manufacturer_rebate", "government_rebate", "tax_credit", "financing", "grant", "other"];
const BENEFIT_KINDS: BenefitKind[] = ["fixed", "percent", "per_unit"];
const DELIVERIES: Delivery[] = ["instant", "mail_in", "tax_credit"];
const FUNDING: FundingStatus[] = ["available", "waitlist", "exhausted", "unknown"];
const CUSTOMER_KINDS: CustomerKind[] = ["any", "residential", "commercial"];
const BASES: PercentBasis[] = ["project", "equipment"];

// ---------------------------------------------------------------------------
// Input sanitising
// ---------------------------------------------------------------------------

const str = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function numOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

function boolOrNull(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function strArray(v: unknown, maxItems = 50): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, maxItems);
}

function validDate(v: unknown): string | null {
  return typeof v === "string" && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

function cleanLines(raw: unknown): IncentiveLineItem[] {
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

/** What the caller typed into the form. Every field is "not provided" (null) unless valid. */
function sanitizeRequestProject(raw: unknown) {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const savingsDollars = numOrNull(c.annual_savings_dollars, 0, 1_000_000);
  const equipmentDollars = numOrNull(c.equipment_cost_dollars, 0, 100_000_000);
  return {
    effective_date: validDate(c.effective_date),
    country: str(c.country, 3)?.toUpperCase() ?? null,
    state: str(c.state, 40),
    postal_code: str(c.postal_code, 20),
    utility_name: str(c.utility_name, 120),
    owner_occupied: boolOrNull(c.owner_occupied),
    income_qualified: boolOrNull(c.income_qualified),
    building_year_built: numOrNull(c.building_year_built, 1700, 2200),
    equipment_type: str(c.equipment_type, 80),
    equipment_units: numOrNull(c.equipment_units, 1, 1000),
    efficiency_metric: str(c.efficiency_metric, 20),
    efficiency_value: numOrNull(c.efficiency_value, 0, 100_000),
    equipment_cost_cents: equipmentDollars === null ? null : Math.round(equipmentDollars * 100),
    annual_kwh_saved: numOrNull(c.annual_kwh_saved, 0, 100_000_000),
    annual_therms_saved: numOrNull(c.annual_therms_saved, 0, 10_000_000),
    annual_savings_direct_cents: savingsDollars === null ? null : Math.round(savingsDollars * 100),
    electric_rate_cents_per_kwh: numOrNull(c.electric_rate_cents_per_kwh, 0, 1000),
    gas_rate_cents_per_therm: numOrNull(c.gas_rate_cents_per_therm, 0, 10_000),
  };
}

function mapProgram(r: Record<string, unknown>): IncentiveProgram {
  return {
    id: String(r.id),
    name: String(r.name ?? "Program"),
    program_type: pick(r.program_type, PROGRAM_TYPES, "other"),
    administrator: str(r.administrator, 160),
    country: String(r.country ?? "US"),
    states: strArray(r.states),
    postal_prefixes: strArray(r.postal_prefixes),
    utility_names: strArray(r.utility_names),
    equipment_types: strArray(r.equipment_types),
    customer_kind: pick(r.customer_kind, CUSTOMER_KINDS, "any"),
    requires_owner_occupied: r.requires_owner_occupied === true,
    requires_income_qualified: r.requires_income_qualified === true,
    min_building_age_years: numOrNull(r.min_building_age_years, 0, 1000),
    max_building_age_years: numOrNull(r.max_building_age_years, 0, 1000),
    efficiency_metric: str(r.efficiency_metric, 20),
    min_efficiency_value: numOrNull(r.min_efficiency_value, 0, 100_000),
    min_project_cents: numOrNull(r.min_project_cents, 0, 2_000_000_000),
    benefit_kind: pick(r.benefit_kind, BENEFIT_KINDS, "fixed"),
    benefit_value: Number(r.benefit_value) || 0,
    cap_cents: numOrNull(r.cap_cents, 0, 2_000_000_000),
    percent_basis: pick(r.percent_basis, BASES, "project"),
    delivery: pick(r.delivery, DELIVERIES, "mail_in"),
    stack_group: str(r.stack_group, 80),
    funding_status: pick(r.funding_status, FUNDING, "unknown"),
    effective_start: validDate(r.effective_start),
    effective_end: validDate(r.effective_end),
    verified_at: typeof r.verified_at === "string" ? r.verified_at : null,
    source_url: str(r.source_url, 500),
    notes: str(r.notes, 500),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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
    const requested = sanitizeRequestProject(body.project);
    const saveDefaults = body.saveDefaults === true;

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
      .select("id, user_id, customer_id, customer_phone, customer_email, line_items, tax_percent, discount_type, discount_value")
      .eq("id", quoteId)
      .maybeSingle();
    if (quoteError || !quote) return json({ error: "Quote not found." }, 404);

    const ownerId: string = quote.user_id;

    // Who is asking? Owner, or a team member with billing access.
    if (user.id !== ownerId) {
      const { data: member } = await admin
        .from("team_members")
        .select("id, account_owner_id, permissions")
        .eq("member_email", (user.email ?? "").toLowerCase())
        .maybeSingle();
      if (!member || member.account_owner_id !== ownerId) return json({ error: "Not authorized for this quote." }, 403);
      if (!(member.permissions as Record<string, boolean> | null)?.can_view_billing) {
        return json({ error: "Incentive economics require billing access." }, 403);
      }
    }

    // Rate limit (counted from the append-only assessments table).
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count: recent } = await admin
      .from("incentive_assessments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("created_at", since);
    if ((recent ?? 0) >= RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Too many assessments in the last minute. Please wait a moment." }, 429);
    }

    const lineItems = cleanLines(quote.line_items);
    if (lineItems.length === 0) return json({ error: "This quote has no line items to assess." }, 400);

    // Resolve the customer (explicit link first, then exact email / phone).
    let customerId: string | null = quote.customer_id ?? null;
    if (!customerId && (quote.customer_email || quote.customer_phone)) {
      let q = caller.from("customers").select("id").eq("user_id", ownerId).limit(1);
      q = quote.customer_email ? q.eq("email", quote.customer_email) : q.eq("phone", quote.customer_phone as string);
      const { data: found } = await q.maybeSingle();
      customerId = found?.id ?? null;
    }

    const degraded: string[] = [];
    const [programsRes, customerRes, siteRes, profileRes] = await Promise.all([
      caller
        .from("incentive_programs")
        .select(
          "id, name, program_type, administrator, country, states, postal_prefixes, utility_names, equipment_types, customer_kind, requires_owner_occupied, requires_income_qualified, min_building_age_years, max_building_age_years, efficiency_metric, min_efficiency_value, min_project_cents, benefit_kind, benefit_value, cap_cents, percent_basis, delivery, stack_group, funding_status, effective_start, effective_end, verified_at, source_url, notes",
        )
        .eq("user_id", ownerId)
        .eq("is_active", true)
        .limit(300),
      customerId
        ? caller.from("customers").select("customer_type").eq("id", customerId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      customerId
        ? caller
            .from("customer_sites")
            .select("state, postal_code, year_built")
            .eq("customer_id", customerId)
            .order("is_primary", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      customerId
        ? caller
            .from("customer_incentive_profiles")
            .select("country, state, postal_code, utility_name, owner_occupied, income_qualified, building_year_built, electric_rate_cents_per_kwh, gas_rate_cents_per_therm")
            .eq("customer_id", customerId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (programsRes.error) return json({ error: "Could not load your incentive program catalog." }, 500);
    if (customerRes.error) degraded.push("customer record");
    if (siteRes.error) degraded.push("property record");
    if (profileRes.error) degraded.push("saved customer defaults");

    const profile = (profileRes.data ?? {}) as Record<string, unknown>;
    const site = (siteRes.data ?? {}) as Record<string, unknown>;
    const customerType = (customerRes.data as { customer_type?: string } | null)?.customer_type;

    const todayUtc = new Date().toISOString().slice(0, 10);
    // Precedence: what was typed now > remembered customer defaults > property record.
    const project: IncentiveProject = {
      effective_date: requested.effective_date ?? todayUtc,
      country: requested.country ?? str(profile.country, 3)?.toUpperCase() ?? null,
      state: requested.state ?? str(profile.state, 40) ?? str(site.state, 40),
      postal_code: requested.postal_code ?? str(profile.postal_code, 20) ?? str(site.postal_code, 20),
      utility_name: requested.utility_name ?? str(profile.utility_name, 120),
      customer_kind: customerType === "commercial" || customerType === "residential" ? customerType : null,
      owner_occupied: requested.owner_occupied ?? boolOrNull(profile.owner_occupied),
      income_qualified: requested.income_qualified ?? boolOrNull(profile.income_qualified),
      building_year_built: requested.building_year_built ?? numOrNull(profile.building_year_built, 1700, 2200) ?? numOrNull(site.year_built, 1700, 2200),
      equipment_type: requested.equipment_type,
      equipment_units: requested.equipment_units ?? 1,
      efficiency_metric: requested.efficiency_metric,
      efficiency_value: requested.efficiency_value,
      equipment_cost_cents: requested.equipment_cost_cents,
      annual_kwh_saved: requested.annual_kwh_saved,
      annual_therms_saved: requested.annual_therms_saved,
      annual_savings_direct_cents: requested.annual_savings_direct_cents,
      electric_rate_cents_per_kwh: requested.electric_rate_cents_per_kwh ?? numOrNull(profile.electric_rate_cents_per_kwh, 0, 1000),
      gas_rate_cents_per_therm: requested.gas_rate_cents_per_therm ?? numOrNull(profile.gas_rate_cents_per_therm, 0, 10_000),
    };

    const programs = (programsRes.data ?? []).map((r) => mapProgram(r as Record<string, unknown>));

    let report;
    try {
      report = assessIncentives({
        now: new Date().toISOString(),
        quote: {
          line_items: lineItems,
          tax_percent: Number(quote.tax_percent) || 0,
          discount_type: quote.discount_type === "percent" || quote.discount_type === "flat" ? quote.discount_type : null,
          discount_value: quote.discount_value === null || quote.discount_value === undefined ? null : Number(quote.discount_value),
        },
        project,
        programs,
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Could not assess incentives." }, 400);
    }

    // Persist (service role). A failure here must not hide a successful assessment.
    let analysisId: string | null = null;
    let persisted = true;
    const econ = report.economics;
    const { data: row, error: insertError } = await admin
      .from("incentive_assessments")
      .insert({
        user_id: ownerId,
        quote_id: quoteId,
        customer_id: customerId,
        requested_by: user.id,
        engine_version: report.engine_version,
        effective_date: report.effective_date,
        total_cents: econ.total_cents,
        confirmed_cents: econ.confirmed_cents,
        potential_cents: econ.potential_cents,
        net_cost_confirmed_cents: econ.net_cost_confirmed_cents,
        net_cost_best_cents: econ.net_cost_best_cents,
        payback_months_best: report.energy.payback_months_best,
        programs_considered: report.programs_considered,
        project,
        report,
      })
      .select("id")
      .single();
    if (insertError || !row) {
      persisted = false;
      degraded.push("history log");
    } else {
      analysisId = row.id as string;
      await admin
        .from("quotes")
        .update({
          incentive_confirmed_cents: econ.confirmed_cents,
          incentive_potential_cents: econ.potential_cents,
          incentive_assessed_at: new Date().toISOString(),
        })
        .eq("id", quoteId);
    }

    // Optionally remember the customer-level inputs for next time.
    let profileSaved = false;
    if (saveDefaults && customerId) {
      const { error: saveError } = await admin.from("customer_incentive_profiles").upsert(
        {
          user_id: ownerId,
          customer_id: customerId,
          country: project.country,
          state: project.state,
          postal_code: project.postal_code,
          utility_name: project.utility_name,
          owner_occupied: project.owner_occupied,
          income_qualified: project.income_qualified,
          building_year_built: project.building_year_built,
          electric_rate_cents_per_kwh: project.electric_rate_cents_per_kwh,
          gas_rate_cents_per_therm: project.gas_rate_cents_per_therm,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "customer_id" },
      );
      profileSaved = !saveError;
    }

    return json({
      analysis_id: analysisId,
      persisted,
      customer_id: customerId,
      profile_saved: profileSaved,
      degraded,
      project,
      report,
    });
  } catch (err) {
    console.error("incentive-decision-engine error:", err);
    return json({ error: "Unexpected error while assessing incentives." }, 500);
  }
});
