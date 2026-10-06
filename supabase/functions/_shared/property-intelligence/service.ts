// Property Intelligence — orchestration (DB + providers). Used by:
//   - supabase/functions/property-intelligence   (dashboard: get / enrich)
//   - supabase/functions/vapi-webhook            (voice: caller context + mid-call lookup tool)
//
// Every function takes an already-authorised `ownerId` (account owner id) and filters by it explicitly,
// because the service-role client bypasses RLS. Callers are responsible for proving the user may act for
// that owner (the HTTP function does this with a caller-scoped read; the webhook resolves the tenant itself).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type {
  BriefingStatus,
  ClimateFacts,
  EnergyFacts,
  EquipmentLite,
  JobLite,
  ParcelFacts,
  PermitSummary,
  ProfileFacts,
  PropertyBriefing,
  ProviderReports,
  SiteAddressInput,
} from "./types.ts";
import {
  buildAddressKey,
  formatAddressLine,
  hasUsableAddress,
  phoneCandidates,
} from "./address.ts";
import {
  fetchAttomPermits,
  fetchEiaResidentialPrice,
  fetchNasaClimate,
  fetchRentcastParcel,
  geocodeCensus,
  skipped,
} from "./providers.ts";
import {
  assessHvac,
  buildGraph,
  buildVoiceContext,
  deriveSignals,
  summarizeService,
} from "./scoring.ts";

// ---------------------------------------------------------------- config

export const DAILY_LOOKUP_LIMIT = 150; // external enrichments per account per rolling 24h
export const SITE_COOLDOWN_MS = 10 * 60 * 1000;
export const REFRESH_AFTER_DAYS = 60;
export const FAILED_RETRY_MS = 60 * 60 * 1000;
export const DASHBOARD_TIMEOUT_MS = 8_000;
export const VOICE_TIMEOUT_MS = 4_000;
const VOICE_CONTEXT_DEADLINE_MS = 1_500;

export interface ServiceEnv {
  rentcastKey?: string;
  attomKey?: string;
  eiaKey?: string;
}

export function readServiceEnv(): ServiceEnv {
  return {
    rentcastKey: Deno.env.get("RENTCAST_API_KEY") || undefined,
    attomKey: Deno.env.get("ATTOM_API_KEY") || undefined,
    eiaKey: Deno.env.get("EIA_API_KEY") || undefined,
  };
}

// ---------------------------------------------------------------- row types

interface SiteRow extends SiteAddressInput {
  id: string;
  user_id: string;
  customer_id: string;
  name: string;
  year_built: number | null;
}

interface ProfileRow {
  site_id: string;
  address_key: string;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  state_fips: string | null;
  county_fips: string | null;
  census_tract: string | null;
  apn: string | null;
  property_type: string | null;
  year_built: number | null;
  living_sqft: number | null;
  lot_sqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  stories: number | null;
  heating_type: string | null;
  cooling_type: string | null;
  has_heating: boolean | null;
  has_cooling: boolean | null;
  last_sale_date: string | null;
  climate: unknown;
  energy: unknown;
  field_sources: Record<string, unknown> | null;
  provider_status: ProviderReports | null;
  status: BriefingStatus;
  fetched_at: string | null;
  refresh_after: string | null;
}

const PROFILE_COLUMNS =
  "site_id,address_key,formatted_address,latitude,longitude,state_fips,county_fips,census_tract,apn,property_type,year_built,living_sqft,lot_sqft,bedrooms,bathrooms,stories,heating_type,cooling_type,has_heating,has_cooling,last_sale_date,climate,energy,field_sources,provider_status,status,fetched_at,refresh_after";

// ---------------------------------------------------------------- small helpers

function asClimate(v: unknown): ClimateFacts | null {
  const c = v as ClimateFacts | null;
  return c && typeof c.hdd65f_est === "number" && typeof c.cdd65f_est === "number" ? c : null;
}
function asEnergy(v: unknown): EnergyFacts | null {
  const e = v as EnergyFacts | null;
  return e && typeof e.residential_cents_per_kwh === "number" ? e : null;
}

function emptyFacts(): ProfileFacts {
  return {
    formatted_address: null, apn: null, property_type: null, year_built: null, year_built_source: null,
    living_sqft: null, lot_sqft: null, bedrooms: null, bathrooms: null, stories: null,
    heating_type: null, cooling_type: null, has_heating: null, has_cooling: null,
    census_tract: null, climate: null, energy: null,
  };
}

function rowToFacts(row: ProfileRow | null, manualYearBuilt: number | null): ProfileFacts | null {
  if (!row && manualYearBuilt === null) return null;
  const base = emptyFacts();
  if (row) {
    Object.assign(base, {
      formatted_address: row.formatted_address, apn: row.apn, property_type: row.property_type,
      living_sqft: row.living_sqft, lot_sqft: row.lot_sqft, bedrooms: row.bedrooms, bathrooms: row.bathrooms,
      stories: row.stories, heating_type: row.heating_type, cooling_type: row.cooling_type,
      has_heating: row.has_heating, has_cooling: row.has_cooling, census_tract: row.census_tract,
      climate: asClimate(row.climate), energy: asEnergy(row.energy),
    });
  }
  // A year entered by the team (customer_sites.year_built) always beats a vendor value.
  base.year_built = manualYearBuilt ?? row?.year_built ?? null;
  base.year_built_source = manualYearBuilt !== null ? "manual" : row?.year_built != null ? "provider" : null;
  return base;
}

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

// ---------------------------------------------------------------- loading

async function loadSite(admin: SupabaseClient, ownerId: string, siteId: string): Promise<SiteRow | null> {
  const { data } = await admin
    .from("customer_sites")
    .select("id,user_id,customer_id,name,address,city,state,postal_code,year_built")
    .eq("id", siteId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return (data as SiteRow | null) ?? null;
}

async function loadProfile(admin: SupabaseClient, ownerId: string, siteId: string): Promise<ProfileRow | null> {
  const { data } = await admin
    .from("property_intelligence_profiles")
    .select(PROFILE_COLUMNS)
    .eq("site_id", siteId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function loadPermits(admin: SupabaseClient, ownerId: string, siteId: string): Promise<PermitSummary[]> {
  const { data } = await admin
    .from("property_intelligence_permits")
    .select("permit_number,permit_type,work_category,status,description,issued_date,source")
    .eq("site_id", siteId)
    .eq("user_id", ownerId)
    .order("issued_date", { ascending: false, nullsFirst: false })
    .limit(50);
  return (data as PermitSummary[] | null) ?? [];
}

/**
 * Equipment + jobs that belong to the site. Equipment: assigned to one of the site's rooms, or — when the
 * customer has exactly one site — unassigned equipment of that customer. Jobs: site_id match, plus the same
 * single-site fallback for jobs with no site.
 */
async function loadHistory(
  admin: SupabaseClient,
  ownerId: string,
  site: SiteRow,
): Promise<{ equipment: EquipmentLite[]; jobs: JobLite[] }> {
  const { count: siteCount } = await admin
    .from("customer_sites")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", site.customer_id)
    .eq("user_id", ownerId);
  const singleSite = (siteCount ?? 0) <= 1;

  const { data: buildings } = await admin.from("customer_site_buildings").select("id").eq("site_id", site.id).eq("user_id", ownerId);
  const buildingIds = (buildings ?? []).map((b: { id: string }) => b.id);
  let roomIds: string[] = [];
  if (buildingIds.length) {
    const { data: floors } = await admin.from("customer_site_floors").select("id").in("building_id", buildingIds).eq("user_id", ownerId);
    const floorIds = (floors ?? []).map((f: { id: string }) => f.id);
    if (floorIds.length) {
      const { data: rooms } = await admin.from("customer_site_rooms").select("id").in("floor_id", floorIds).eq("user_id", ownerId);
      roomIds = (rooms ?? []).map((r: { id: string }) => r.id);
    }
  }

  const equipCols = "id,equipment_type,make,model,install_date,status,expected_lifespan_years,last_service_date";
  const jobCols = "id,service_type,job_status,scheduled_datetime";

  const [eqRooms, eqLoose, jobsSite, jobsLoose] = await Promise.all([
    roomIds.length
      ? admin.from("equipment").select(equipCols).eq("user_id", ownerId).in("room_id", roomIds)
      : Promise.resolve({ data: [] as EquipmentLite[] }),
    singleSite
      ? admin.from("equipment").select(equipCols).eq("user_id", ownerId).eq("customer_id", site.customer_id).is("room_id", null)
      : Promise.resolve({ data: [] as EquipmentLite[] }),
    admin.from("jobs").select(jobCols).eq("user_id", ownerId).eq("site_id", site.id).order("scheduled_datetime", { ascending: false }).limit(200),
    singleSite
      ? admin.from("jobs").select(jobCols).eq("user_id", ownerId).eq("customer_id", site.customer_id).is("site_id", null).order("scheduled_datetime", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as JobLite[] }),
  ]);

  const dedupe = <T extends { id: string }>(...lists: Array<T[] | null | undefined>): T[] => {
    const seen = new Map<string, T>();
    for (const list of lists) for (const item of list ?? []) seen.set(item.id, item);
    return [...seen.values()];
  };

  return {
    equipment: dedupe<EquipmentLite>(eqRooms.data as EquipmentLite[], eqLoose.data as EquipmentLite[]),
    jobs: dedupe<JobLite>(jobsSite.data as JobLite[], jobsLoose.data as JobLite[]),
  };
}

// ---------------------------------------------------------------- briefing

function composeBriefing(a: {
  siteId: string;
  addressLine: string | null;
  profile: ProfileFacts | null;
  status: BriefingStatus;
  fetchedAt: string | null;
  refreshAfter: string | null;
  providers: ProviderReports;
  equipment: EquipmentLite[];
  jobs: JobLite[];
  permits: PermitSummary[];
  nowMs: number;
}): PropertyBriefing {
  const hvac = assessHvac({
    yearBuilt: a.profile?.year_built ?? null,
    equipment: a.equipment,
    jobs: a.jobs,
    permits: a.permits,
    climate: a.profile?.climate ?? null,
    nowMs: a.nowMs,
  });
  const signals = deriveSignals({ yearBuilt: a.profile?.year_built ?? null, hvac, climate: a.profile?.climate ?? null, permits: a.permits, nowMs: a.nowMs });
  const service = summarizeService(a.jobs, hvac.hvac_repairs_24m);
  const graph = buildGraph({ addressLine: a.addressLine, profile: a.profile, providers: a.providers, equipment: a.equipment, permits: a.permits, service, hvac, nowMs: a.nowMs });
  const voice_context = buildVoiceContext({ profile: a.profile, hvac, signals, service, nowMs: a.nowMs });
  return {
    site_id: a.siteId,
    status: a.status,
    fetched_at: a.fetchedAt,
    refresh_after: a.refreshAfter,
    is_stale: !!a.refreshAfter && Date.parse(a.refreshAfter) < a.nowMs,
    providers: a.providers,
    profile: a.profile,
    hvac,
    signals,
    permits: a.permits.slice(0, 10),
    service,
    graph,
    voice_context,
  };
}

/** Reads stored data only (no external calls) and recomputes scores from the CURRENT equipment/jobs. */
export async function buildBriefing(admin: SupabaseClient, ownerId: string, siteId: string, nowMs = Date.now()): Promise<PropertyBriefing | null> {
  const site = await loadSite(admin, ownerId, siteId);
  if (!site) return null;
  const [row, permits, history] = await Promise.all([
    loadProfile(admin, ownerId, siteId),
    loadPermits(admin, ownerId, siteId),
    loadHistory(admin, ownerId, site),
  ]);
  return composeBriefing({
    siteId,
    addressLine: hasUsableAddress(site) ? formatAddressLine(site) : null,
    profile: rowToFacts(row, site.year_built),
    status: row?.status ?? "not_enriched",
    fetchedAt: row?.fetched_at ?? null,
    refreshAfter: row?.refresh_after ?? null,
    providers: row?.provider_status ?? {},
    equipment: history.equipment,
    jobs: history.jobs,
    permits,
    nowMs,
  });
}

// ---------------------------------------------------------------- enrichment

export type EnrichError = "site_not_found" | "address_incomplete" | "rate_limited";

export type EnrichResult =
  | { ok: true; briefing: PropertyBriefing; cached: boolean }
  | { ok: false; error: EnrichError; message: string };

async function dailyLookupCount(admin: SupabaseClient, ownerId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("property_intelligence_lookups")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId)
    .gte("created_at", since)
    .neq("outcome", "rate_limited");
  return count ?? 0;
}

async function recordLookup(
  admin: SupabaseClient,
  ownerId: string,
  siteId: string | null,
  channel: "dashboard" | "voice",
  outcome: "ready" | "partial" | "failed" | "rate_limited",
  providersCalled: string[],
  latencyMs: number,
): Promise<void> {
  await admin.from("property_intelligence_lookups").insert({
    user_id: ownerId, site_id: siteId, channel, outcome, providers_called: providersCalled, latency_ms: latencyMs,
  });
}

export async function enrichSite(
  admin: SupabaseClient,
  ownerId: string,
  siteId: string,
  opts: { channel: "dashboard" | "voice"; env: ServiceEnv; timeoutMs?: number },
): Promise<EnrichResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DASHBOARD_TIMEOUT_MS;

  const site = await loadSite(admin, ownerId, siteId);
  if (!site) return { ok: false, error: "site_not_found", message: "This property could not be found." };
  if (!hasUsableAddress(site)) {
    return { ok: false, error: "address_incomplete", message: "Add a street address plus a city/state or ZIP to this site first." };
  }

  const existing = await loadProfile(admin, ownerId, siteId);

  // Cooldown: a recent fetch is returned as-is instead of burning provider quota.
  if (existing?.fetched_at && Date.now() - Date.parse(existing.fetched_at) < SITE_COOLDOWN_MS) {
    const cached = await buildBriefing(admin, ownerId, siteId);
    if (cached) return { ok: true, briefing: cached, cached: true };
  }

  if ((await dailyLookupCount(admin, ownerId)) >= DAILY_LOOKUP_LIMIT) {
    await recordLookup(admin, ownerId, siteId, opts.channel, "rate_limited", [], Date.now() - started);
    return { ok: false, error: "rate_limited", message: "Daily property-lookup limit reached for this account. Try again tomorrow." };
  }

  const addressLine = formatAddressLine(site);
  const geo = await geocodeCensus(addressLine, timeoutMs);
  const g = geo.data;
  const canonical = g?.formatted_address ?? addressLine;
  const street1 = g?.street1 ?? (site.address ?? "").trim();
  const cityStateZip = g
    ? [g.city, [g.state, g.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : [site.city, [site.state, site.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const stateAbbr = g?.state ?? site.state;

  const climateEarly = g ? fetchNasaClimate(g.latitude, g.longitude, timeoutMs) : null;
  const [parcel, permits, energy, climateFirst] = await Promise.all([
    fetchRentcastParcel(canonical, opts.env.rentcastKey, timeoutMs),
    fetchAttomPermits(street1, cityStateZip, opts.env.attomKey, timeoutMs),
    fetchEiaResidentialPrice(stateAbbr, opts.env.eiaKey, timeoutMs),
    climateEarly ?? Promise.resolve(null),
  ]);

  const lat = g?.latitude ?? parcel.data?.latitude ?? null;
  const lon = g?.longitude ?? parcel.data?.longitude ?? null;
  const climate = climateFirst ??
    (lat !== null && lon !== null ? await fetchNasaClimate(lat, lon, timeoutMs) : skipped<ClimateFacts>("No coordinates available for climate lookup."));

  const nowIso = new Date().toISOString();
  const keep = <T>(fresh: T | null | undefined, old: T | null | undefined): T | null => (fresh ?? old ?? null);
  const pd: ParcelFacts | null = parcel.data;
  const parcelOk = parcel.report.state === "ok" && pd !== null;

  // Only an "ok" result overwrites stored values; errors/skips/no-data never wipe what we already know.
  const row = {
    user_id: ownerId,
    site_id: siteId,
    address_key: buildAddressKey(street1, g?.zip ?? site.postal_code),
    formatted_address: keep(g?.formatted_address ?? pd?.formatted_address, existing?.formatted_address) ?? addressLine,
    latitude: keep(lat, existing?.latitude),
    longitude: keep(lon, existing?.longitude),
    state_fips: keep(g?.state_fips ?? pd?.state_fips, existing?.state_fips),
    county_fips: keep(g?.county_fips ?? pd?.county_fips, existing?.county_fips),
    census_tract: keep(g?.census_tract, existing?.census_tract),
    apn: parcelOk ? keep(pd.apn, existing?.apn) : existing?.apn ?? null,
    property_type: parcelOk ? keep(pd.property_type, existing?.property_type) : existing?.property_type ?? null,
    year_built: parcelOk ? keep(pd.year_built, existing?.year_built) : existing?.year_built ?? null,
    living_sqft: parcelOk ? keep(pd.living_sqft, existing?.living_sqft) : existing?.living_sqft ?? null,
    lot_sqft: parcelOk ? keep(pd.lot_sqft, existing?.lot_sqft) : existing?.lot_sqft ?? null,
    bedrooms: parcelOk ? keep(pd.bedrooms, existing?.bedrooms) : existing?.bedrooms ?? null,
    bathrooms: parcelOk ? keep(pd.bathrooms, existing?.bathrooms) : existing?.bathrooms ?? null,
    stories: parcelOk ? keep(pd.stories, existing?.stories) : existing?.stories ?? null,
    heating_type: parcelOk ? keep(pd.heating_type, existing?.heating_type) : existing?.heating_type ?? null,
    cooling_type: parcelOk ? keep(pd.cooling_type, existing?.cooling_type) : existing?.cooling_type ?? null,
    has_heating: parcelOk ? keep(pd.has_heating, existing?.has_heating) : existing?.has_heating ?? null,
    has_cooling: parcelOk ? keep(pd.has_cooling, existing?.has_cooling) : existing?.has_cooling ?? null,
    last_sale_date: parcelOk ? keep(pd.last_sale_date, existing?.last_sale_date) : existing?.last_sale_date ?? null,
    climate: climate.data ?? asClimate(existing?.climate) ?? {},
    energy: energy.data ?? asEnergy(existing?.energy) ?? {},
    field_sources: {
      ...(existing?.field_sources ?? {}),
      ...(g ? { geography: { source: "census", fetched_at: nowIso } } : {}),
      ...(parcelOk ? { parcel: { source: "rentcast", fetched_at: nowIso } } : {}),
      ...(climate.data ? { climate: { source: "nasa_power", fetched_at: nowIso } } : {}),
      ...(energy.data ? { energy: { source: "eia", fetched_at: nowIso } } : {}),
    },
    provider_status: {
      census: geo.report,
      rentcast: parcel.report,
      attom_permits: permits.report,
      nasa_power: climate.report,
      eia: energy.report,
    } as ProviderReports,
    status: "pending" as BriefingStatus,
    fetched_at: nowIso,
    refresh_after: nowIso,
  };

  const hasPhysical = row.year_built !== null || row.living_sqft !== null || row.apn !== null;
  const hasAny = hasPhysical || g !== null || climate.data !== null || energy.data !== null;
  row.status = hasPhysical ? "ready" : hasAny ? "partial" : "failed";
  row.refresh_after = new Date(Date.now() + (row.status === "failed" ? FAILED_RETRY_MS : REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000)).toISOString();

  const { error: upsertError } = await admin.from("property_intelligence_profiles").upsert(row, { onConflict: "site_id" });
  if (upsertError) {
    console.error(JSON.stringify({ event: "property_intelligence_profile_upsert_failed", site_id: siteId, code: upsertError.code }));
  }

  if (permits.report.state === "ok" && permits.data && permits.data.length > 0) {
    const rows = permits.data.map((p) => ({ ...p, user_id: ownerId, site_id: siteId }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await admin
        .from("property_intelligence_permits")
        .upsert(rows.slice(i, i + 100), { onConflict: "site_id,source,source_record_id" });
      if (error) console.error(JSON.stringify({ event: "property_intelligence_permits_upsert_failed", site_id: siteId, code: error.code }));
    }
  }

  const called = [geo, parcel, permits, climate, energy]
    .map((r, i) => ({ r, id: ["census", "rentcast", "attom_permits", "nasa_power", "eia"][i] }))
    .filter(({ r }) => r.report.state !== "skipped")
    .map(({ id }) => id);
  await recordLookup(admin, ownerId, siteId, opts.channel, row.status === "failed" ? "failed" : row.status === "ready" ? "ready" : "partial", called, Date.now() - started);

  const briefing = await buildBriefing(admin, ownerId, siteId);
  if (!briefing) return { ok: false, error: "site_not_found", message: "This property could not be found." };
  return { ok: true, briefing, cached: false };
}

// ---------------------------------------------------------------- voice

/** True when a voice context carries something beyond the generic rules line. */
function hasSubstance(b: PropertyBriefing): boolean {
  return b.profile !== null || b.hvac.level !== "unknown" || b.service.visits > 0;
}

/**
 * Context for assistant-request. Reads ONLY stored data (no provider calls) and is deadline-bounded so it can
 * never delay the call connecting. Returns "" when there is nothing useful.
 */
export function getPropertyContextForCaller(admin: SupabaseClient, ownerId: string, callerPhone: string | null): Promise<string> {
  const work = async (): Promise<string> => {
    const candidates = phoneCandidates(callerPhone);
    if (candidates.length === 0) return "";

    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", ownerId)
      .in("phone", candidates)
      .limit(1)
      .maybeSingle();
    if (!customer) return "";

    const { data: sites } = await admin
      .from("customer_sites")
      .select("id,is_primary")
      .eq("user_id", ownerId)
      .eq("customer_id", (customer as { id: string }).id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(5);
    const list = (sites ?? []) as Array<{ id: string; is_primary: boolean }>;
    if (list.length === 0) return "";
    if (list.length > 1 && !list[0].is_primary) {
      return "This caller has several properties on file. Ask which address the call is about before assuming anything about the home.";
    }

    const briefing = await buildBriefing(admin, ownerId, list[0].id);
    return briefing && hasSubstance(briefing) ? briefing.voice_context : "";
  };
  return withDeadline(work(), VOICE_CONTEXT_DEADLINE_MS, "");
}

const NO_RECORDS_MESSAGE =
  "No property records were found for that address. Continue normally and ask the caller about the age and type of the equipment.";

/** Mid-call tool: caller says an address. Known site → stored briefing; unknown → transient lookup (not stored). */
export async function lookupPropertyForCall(
  admin: SupabaseClient,
  ownerId: string,
  args: { address?: string | null; callerPhone: string | null; env: ServiceEnv },
): Promise<string> {
  const address = (args.address ?? "").trim();
  if (address.length < 5 || address.length > 200) {
    const fromPhone = await getPropertyContextForCaller(admin, ownerId, args.callerPhone);
    return fromPhone || "Ask the caller for the full service address (street, city, ZIP) so the property can be looked up.";
  }

  const started = Date.now();
  const geo = await geocodeCensus(address, VOICE_TIMEOUT_MS);
  const g = geo.data;
  if (g) {
    const key = buildAddressKey(g.street1, g.zip);
    const { data: known } = await admin
      .from("property_intelligence_profiles")
      .select("site_id")
      .eq("user_id", ownerId)
      .eq("address_key", key)
      .limit(1)
      .maybeSingle();
    if (known) {
      const briefing = await buildBriefing(admin, ownerId, (known as { site_id: string }).site_id);
      if (briefing && hasSubstance(briefing)) return briefing.voice_context;
    }
  }

  // Transient path: no site row exists, so nothing is stored. Counted against the daily cap.
  if ((await dailyLookupCount(admin, ownerId)) >= DAILY_LOOKUP_LIMIT) {
    await recordLookup(admin, ownerId, null, "voice", "rate_limited", [], Date.now() - started);
    return NO_RECORDS_MESSAGE;
  }

  const canonical = g?.formatted_address ?? address;
  const climateEarly = g ? fetchNasaClimate(g.latitude, g.longitude, VOICE_TIMEOUT_MS) : null;
  const [parcel, climate] = await Promise.all([
    fetchRentcastParcel(canonical, args.env.rentcastKey, VOICE_TIMEOUT_MS),
    climateEarly ?? Promise.resolve(null),
  ]);
  const pd = parcel.data;
  const facts: ProfileFacts | null = pd || climate?.data
    ? {
      ...emptyFacts(),
      property_type: pd?.property_type ?? null,
      year_built: pd?.year_built ?? null,
      year_built_source: pd?.year_built != null ? "provider" : null,
      living_sqft: pd?.living_sqft ?? null,
      lot_sqft: pd?.lot_sqft ?? null,
      bedrooms: pd?.bedrooms ?? null,
      bathrooms: pd?.bathrooms ?? null,
      stories: pd?.stories ?? null,
      heating_type: pd?.heating_type ?? null,
      cooling_type: pd?.cooling_type ?? null,
      has_heating: pd?.has_heating ?? null,
      has_cooling: pd?.has_cooling ?? null,
      climate: climate?.data ?? null,
    }
    : null;

  const providersCalled = ["census", ...(args.env.rentcastKey ? ["rentcast"] : []), ...(g ? ["nasa_power"] : [])];
  await recordLookup(admin, ownerId, null, "voice", facts ? (pd ? "ready" : "partial") : "failed", providersCalled, Date.now() - started);
  if (!facts) return NO_RECORDS_MESSAGE;

  const briefing = composeBriefing({
    siteId: "transient", addressLine: null, profile: facts, status: "partial", fetchedAt: new Date().toISOString(),
    refreshAfter: null, providers: {}, equipment: [], jobs: [], permits: [], nowMs: Date.now(),
  });
  return `${briefing.voice_context} (This address is not yet saved as a customer property.)`;
}
