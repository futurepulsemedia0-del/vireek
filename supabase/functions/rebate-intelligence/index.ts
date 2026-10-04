// supabase/functions/rebate-intelligence/index.ts
//
// Vireek Energy + Rebate Intelligence.
// Property -> equipment -> utility territory -> incentives -> financing -> best proposal.
//
// Deterministic on purpose (same idiom as quote-truth-engine): no LLM, no
// external call. This function only GATHERS data and hands it to the pure
// engine in _shared/rebate-intelligence/engine.ts.
//
// Security model
//   - Caller identity comes from their own JWT; every read goes through a client
//     scoped to that JWT, so RLS enforces the account boundary (a stranger's
//     customerId simply 404s).
//   - The analysis row is written with the service-role client so a report can't
//     be forged through the REST API.
//   - Network realization rates come from a k-anonymous, service-role-only RPC.
//   - Advisory only: nothing here sends, books or files anything.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  analyzeRebates,
  ENGINE_VERSION,
  MEASURE_TYPES,
  type Efficiency,
  type EquipmentSignal,
  type FinancingTerms,
  type IncentiveProgram,
  type MeasureType,
  type OutcomeStat,
  type PropertyContext,
  type ReplacementOption,
  type UtilityTerritory,
} from "../_shared/rebate-intelligence/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_LIMIT_PER_MINUTE = 20;
const MAX_OPTIONS = 6;
const MAX_COST_CENTS = 50_000_000; // $500k sanity ceiling

const RANGES: Record<keyof Efficiency, [number, number]> = {
  seer2: [5, 50],
  eer2: [5, 40],
  hspf2: [3, 15],
  afue: [50, 100],
  uef: [0.5, 5],
};

function numIn(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function sanitizeProperty(raw: unknown, site: { state: string | null; postal_code: string | null } | null): PropertyContext {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stateRaw = String(r.state ?? site?.state ?? "").trim().toUpperCase();
  const zipRaw = String(r.postal_code ?? site?.postal_code ?? "").trim().slice(0, 5);
  const target = typeof r.install_target_date === "string" && DATE_RE.test(r.install_target_date) ? r.install_target_date : null;
  return {
    state: /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null,
    postal_code: /^\d{5}$/.test(zipRaw) ? zipRaw : null,
    utility_name: typeof r.utility_name === "string" && r.utility_name.trim() ? r.utility_name.trim().slice(0, 120) : null,
    household_ami_pct: numIn(r.household_ami_pct, 0, 1000),
    owner_occupied: typeof r.owner_occupied === "boolean" ? r.owner_occupied : null,
    install_target_date: target,
  };
}

function sanitizeOptions(raw: unknown): ReplacementOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ReplacementOption[] = [];
  for (const item of raw.slice(0, MAX_OPTIONS)) {
    const r = (item ?? {}) as Record<string, unknown>;
    const measure = r.measure as MeasureType;
    const cost = numIn(r.installed_cost_cents, 1, MAX_COST_CENTS);
    if (!MEASURE_TYPES.includes(measure) || cost === null) continue;
    let key = String(r.key ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || `option-${out.length + 1}`;
    while (seen.has(key)) key = `${key}-x`;
    seen.add(key);
    const effIn = (r.efficiency && typeof r.efficiency === "object" ? r.efficiency : {}) as Record<string, unknown>;
    const efficiency: Efficiency = {};
    for (const k of Object.keys(RANGES) as (keyof Efficiency)[]) {
      const v = numIn(effIn[k], RANGES[k][0], RANGES[k][1]);
      if (v !== null) efficiency[k] = v;
    }
    out.push({
      key,
      label: String(r.label ?? "").trim().slice(0, 80) || key,
      measure,
      installed_cost_cents: Math.round(cost),
      efficiency,
      energy_star: typeof r.energy_star === "boolean" ? r.energy_star : undefined,
      tons: numIn(r.tons, 0.5, 50),
      units: numIn(r.units, 1, 50),
      manufacturer_rebate_cents: numIn(r.manufacturer_rebate_cents, 0, cost),
      annual_energy_savings_cents: numIn(r.annual_energy_savings_cents, 0, cost),
    });
  }
  return out;
}

function sanitizeFinancing(raw: unknown): FinancingTerms | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const apr = numIn(r.apr_bps, 0, 5000);
  const term = numIn(r.term_months, 3, 360);
  return apr === null || term === null ? null : { apr_bps: Math.round(apr), term_months: Math.round(term) };
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

    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (!UUID_RE.test(customerId)) return json({ error: "Missing or invalid customerId." }, 400);
    const equipmentId = typeof body.equipmentId === "string" && UUID_RE.test(body.equipmentId) ? body.equipmentId : null;
    const siteId = typeof body.siteId === "string" && UUID_RE.test(body.siteId) ? body.siteId : null;

    const options = sanitizeOptions(body.options);
    if (options.length === 0) return json({ error: "Add at least one replacement option with an equipment type and installed cost." }, 400);
    const financing = sanitizeFinancing(body.financing);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const caller = createClient(supabaseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // Customer through the caller's client: RLS scopes it to the account.
    const { data: customer } = await caller.from("customers").select("id, user_id").eq("id", customerId).maybeSingle();
    if (!customer) return json({ error: "Customer not found." }, 404);
    const ownerId: string = customer.user_id;

    // Rate limit (counted from the append-only analyses table).
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count: recent } = await admin
      .from("rebate_analyses")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("created_at", since);
    if ((recent ?? 0) >= RATE_LIMIT_PER_MINUTE) return json({ error: "Too many analyses in the last minute. Please wait a moment." }, 429);

    // Optional site prefill (state / ZIP) and equipment (age signal).
    let site: { state: string | null; postal_code: string | null } | null = null;
    if (siteId) {
      const { data } = await caller.from("customer_sites").select("state, postal_code").eq("id", siteId).eq("customer_id", customerId).maybeSingle();
      site = data ?? null;
    }
    const property = sanitizeProperty(body.property, site);

    let equipment: EquipmentSignal | null = null;
    if (equipmentId) {
      const { data } = await caller
        .from("equipment")
        .select("id, equipment_type, make, model, install_date, expected_lifespan_years, last_service_date")
        .eq("id", equipmentId)
        .eq("customer_id", customerId)
        .maybeSingle();
      equipment = (data as EquipmentSignal | null) ?? null;
    }

    // Catalog (RLS returns platform programs + this account's private ones).
    let programQuery = caller.from("incentive_programs").select("*").eq("is_active", true).limit(2000);
    if (property.state) programQuery = programQuery.or(`jurisdiction_state.is.null,jurisdiction_state.eq.${property.state}`);
    const [programsRes, territoriesRes, ownOutcomesRes] = await Promise.all([
      programQuery,
      property.postal_code
        ? caller.from("utility_territories").select("postal_code, utility_name, utility_type").eq("postal_code", property.postal_code).limit(50)
        : Promise.resolve({ data: [] as UtilityTerritory[], error: null }),
      caller.from("rebate_applications").select("program_id, status").in("status", ["approved", "paid", "denied"]).not("program_id", "is", null).limit(5000),
    ]);
    if (programsRes.error) return json({ error: "Could not load the incentive catalog." }, 500);

    const programs: IncentiveProgram[] = (programsRes.data ?? []).map((p: Record<string, unknown>) => ({
      id: String(p.id),
      slug: String(p.slug),
      name: String(p.name),
      level: p.level as IncentiveProgram["level"],
      administrator: (p.administrator as string | null) ?? null,
      jurisdiction_state: (p.jurisdiction_state as string | null) ?? null,
      utility_name: (p.utility_name as string | null) ?? null,
      postal_prefixes: (p.postal_prefixes as string[] | null) ?? [],
      measure_types: (p.measure_types as string[] | null) ?? [],
      incentive_kind: p.incentive_kind as IncentiveProgram["incentive_kind"],
      payout_timing: p.payout_timing as IncentiveProgram["payout_timing"],
      amount_type: p.amount_type as IncentiveProgram["amount_type"],
      amount_value: Number(p.amount_value),
      max_amount_cents: p.max_amount_cents === null ? null : Number(p.max_amount_cents),
      min_efficiency: (p.min_efficiency as Record<string, number> | null) ?? {},
      income_tiers: (p.income_tiers as IncentiveProgram["income_tiers"] | null) ?? [],
      requires_owner_occupied: p.requires_owner_occupied === true,
      requires_pre_approval: p.requires_pre_approval === true,
      requires_participating_contractor: p.requires_participating_contractor === true,
      exclusive_group: (p.exclusive_group as string | null) ?? null,
      start_date: (p.start_date as string | null) ?? null,
      end_date: (p.end_date as string | null) ?? null,
      funding_status: p.funding_status as IncentiveProgram["funding_status"],
      source_url: (p.source_url as string | null) ?? null,
      last_verified_at: (p.last_verified_at as string | null) ?? null,
      notes: (p.notes as string | null) ?? null,
      is_private: p.owner_user_id !== null,
    }));

    // Learned realization: network aggregate (k-anonymous) wins, else this account's own history.
    const outcomes: Record<string, OutcomeStat> = {};
    const ownAgg = new Map<string, { decided: number; successes: number }>();
    for (const row of (ownOutcomesRes.data ?? []) as { program_id: string; status: string }[]) {
      const a = ownAgg.get(row.program_id) ?? { decided: 0, successes: 0 };
      a.decided += 1;
      if (row.status === "approved" || row.status === "paid") a.successes += 1;
      ownAgg.set(row.program_id, a);
    }
    for (const [pid, a] of ownAgg) outcomes[pid] = { ...a, scope: "account" };
    const platformIds = programs.filter((p) => !p.is_private).map((p) => p.id);
    if (platformIds.length > 0) {
      const { data: net } = await admin.rpc("rebate_network_realization", { p_program_ids: platformIds });
      for (const row of (net ?? []) as { program_id: string; decided: number; successes: number }[]) {
        outcomes[row.program_id] = { decided: row.decided, successes: row.successes, scope: "network" };
      }
    }

    const report = analyzeRebates({
      now: new Date().toISOString(),
      property,
      equipment,
      options,
      programs,
      territories: (territoriesRes.data ?? []) as UtilityTerritory[],
      outcomes,
      financing,
    });

    // Persist (service role). Failure is non-fatal: the report is still returned.
    let analysisId: string | null = null;
    let persisted = true;
    const { data: saved, error: saveError } = await admin
      .from("rebate_analyses")
      .insert({
        user_id: ownerId,
        customer_id: customerId,
        equipment_id: equipment?.id ?? null,
        requested_by: user.id,
        engine_version: ENGINE_VERSION,
        state: property.state,
        postal_code: property.postal_code,
        install_target_date: property.install_target_date,
        best_option_key: report.best_option_key,
        total_potential_cents: report.total_potential_cents,
        total_expected_cents: report.total_expected_cents,
        request: { property, options, financing, equipmentId, siteId },
        report,
      })
      .select("id")
      .single();
    if (saveError || !saved) persisted = false;
    else analysisId = saved.id;

    return json({ analysis_id: analysisId, persisted, report });
  } catch (err) {
    console.error("rebate-intelligence error", err);
    return json({ error: "Unexpected error while analyzing incentives." }, 500);
  }
});
