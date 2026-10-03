// supabase/functions/_shared/job-context/graph.ts
//
// Vireek Real-World Context Engine — deterministic Context Graph builder.
//
// Pure functions only (no I/O): facts from build_job_context_facts() + an optional weather forecast
// go in, a graph (nodes, edges, flags) and a readiness score come out. Every flag is rule-based and
// explainable. The LLM never decides a score or a flag; it only narrates this output.

export type NodeStatus = "ok" | "watch" | "risk" | "unknown";
export type FlagSeverity = "info" | "watch" | "risk" | "critical";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ContextNode {
  id: string;
  type: "job" | "customer" | "property" | "weather" | "equipment" | "history" | "permit" | "parts" | "technician" | "utility" | "pattern";
  label: string;
  status: NodeStatus;
  detail: string;
}
export interface ContextEdge { from: string; to: string; relation: string }
export interface ContextFlag { code: string; severity: FlagSeverity; node: string; title: string; detail: string; action: string }

export interface ForecastSummary {
  available: boolean;
  window_hours: number;
  temp_min_f: number | null;
  temp_max_f: number | null;
  precip_prob_max: number | null;
  wind_max_mph: number | null;
  conditions: string | null;
}

export interface ContextGraph {
  nodes: ContextNode[];
  edges: ContextEdge[];
  flags: ContextFlag[];
  readiness_score: number;
  coverage_pct: number;
  risk_level: RiskLevel;
  sources: Record<string, "live" | "internal" | "missing">;
}

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

const OUTDOOR_RE = /roof|gutter|exterior|outdoor|condenser|compressor|solar|siding|window|pool|irrigation/i;
const HVAC_RE = /hvac|heat|furnace|boiler|air\s*cond|a\/?c|cooling|ac\b|heat\s*pump/i;
const SEVERE = new Set(["Extreme", "Severe"]);

const PENALTY: Record<FlagSeverity, number> = { info: 0, watch: 6, risk: 15, critical: 25 };

export function buildContextGraph(facts: Obj, forecast: ForecastSummary): ContextGraph {
  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];
  const flags: ContextFlag[] = [];
  const sources: ContextGraph["sources"] = {};

  const job = obj(facts.job);
  const serviceType = str(job.service_type) ?? "";
  const customer = obj(facts.customer);
  const property = obj(facts.property);
  const equipment = arr(facts.equipment);
  const patterns = arr(facts.model_patterns);
  const history = obj(facts.history);
  const parts = obj(facts.parts);
  const tech = obj(facts.technician);
  const permit = obj(facts.permit);
  const alerts = arr(facts.weather_alerts);

  const flag = (f: ContextFlag) => flags.push(f);
  const add = (n: ContextNode, relation: string) => {
    nodes.push(n);
    edges.push({ from: "job", to: n.id, relation });
  };

  nodes.push({ id: "job", type: "job", label: serviceType || "Service job", status: "ok", detail: "The job being prepared for dispatch." });

  // ---- Customer -------------------------------------------------
  const lifecycle = str(customer.lifecycle_stage);
  sources.customer = lifecycle ? "internal" : "missing";
  add(
    { id: "customer", type: "customer", label: lifecycle ? `${lifecycle} ${str(customer.customer_type) ?? ""}`.trim() : "Customer", status: lifecycle ? "ok" : "unknown", detail: lifecycle ? "Customer record found." : "No linked customer record." },
    "for",
  );
  if (!lifecycle) {
    flag({ code: "customer_unlinked", severity: "watch", node: "customer", title: "Job is not linked to a customer record", detail: "History, equipment and property context cannot be matched.", action: "Link this job to a customer before dispatch." });
  } else if (lifecycle === "vip") {
    flag({ code: "customer_vip", severity: "info", node: "customer", title: "VIP customer", detail: "Higher service expectations apply.", action: "Confirm arrival window and send the most experienced available technician." });
  }

  // ---- Property -------------------------------------------------
  const yearBuilt = num(property.year_built);
  sources.property = Object.keys(property).length ? "internal" : "missing";
  if (yearBuilt) {
    const age = new Date().getUTCFullYear() - yearBuilt;
    const old = age >= 40;
    add({ id: "property", type: "property", label: `Built ${yearBuilt}`, status: old ? "watch" : "ok", detail: `${age} years old${num(property.square_feet) ? `, ${num(property.square_feet)} sq ft` : ""}.` }, "at");
    if (old) {
      flag({ code: "older_building", severity: "watch", node: "property", title: `Older building (built ${yearBuilt})`, detail: "Older properties more often have legacy wiring, piping, ductwork or non-standard layouts.", action: "Allow extra diagnostic time and bring adapters and access tools." });
    }
  } else {
    add({ id: "property", type: "property", label: "Property unknown", status: "unknown", detail: "No building profile on file." }, "at");
  }

  // ---- Utility / energy context --------------------------------------
  const provider = str(property.utility_provider);
  const fuel = str(property.heating_fuel);
  if (provider || (fuel && fuel !== "unknown")) {
    add({ id: "utility", type: "utility", label: provider ?? `${fuel} heating`, status: "ok", detail: [provider ? `Utility: ${provider}` : null, fuel && fuel !== "unknown" ? `Heating fuel: ${fuel}` : null].filter(Boolean).join(" · ") }, "powered_by");
  }

  // ---- Weather --------------------------------------------------
  const severeAlert = alerts.find((a) => SEVERE.has(str(a.severity) ?? ""));
  sources.weather = forecast.available || alerts.length ? "live" : "missing";
  const hot = (forecast.temp_max_f ?? -999) >= 95;
  const cold = (forecast.temp_min_f ?? 999) <= 20;
  const wet = (forecast.precip_prob_max ?? 0) >= 60;
  const windy = (forecast.wind_max_mph ?? 0) >= 35;
  const weatherStatus: NodeStatus = !sources.weather || sources.weather === "missing"
    ? "unknown"
    : severeAlert ? "risk" : hot || cold || wet || windy || alerts.length ? "watch" : "ok";
  const weatherBits = [
    forecast.available && forecast.temp_max_f !== null ? `${Math.round(forecast.temp_min_f ?? forecast.temp_max_f)}–${Math.round(forecast.temp_max_f)}°F` : null,
    forecast.conditions,
    forecast.precip_prob_max !== null && forecast.precip_prob_max > 0 ? `${forecast.precip_prob_max}% precip` : null,
    forecast.wind_max_mph ? `wind ${Math.round(forecast.wind_max_mph)} mph` : null,
  ].filter(Boolean);
  add({ id: "weather", type: "weather", label: severeAlert ? str(severeAlert.event) ?? "Weather alert" : weatherBits[0] ?? "Weather unknown", status: weatherStatus, detail: weatherBits.join(" · ") || (alerts.length ? "Active alert on file." : "No forecast available (job has no coordinates or the weather service did not respond).") }, "during");

  if (severeAlert) {
    flag({ code: "weather_severe", severity: "risk", node: "weather", title: `${str(severeAlert.event) ?? "Severe weather"} alert active`, detail: str(severeAlert.headline) ?? "A severe weather alert overlaps this job window.", action: "Confirm the arrival window with the customer and consider rescheduling non-urgent work." });
  }
  if (hot || cold) {
    const hvac = HVAC_RE.test(serviceType);
    flag({ code: hot ? "weather_heat" : "weather_cold", severity: hvac ? "watch" : "info", node: "weather", title: hot ? "Extreme heat in the job window" : "Extreme cold in the job window", detail: hot ? "Cooling systems run at peak load; failures and long repairs are more likely." : "Heating systems run at peak load; failures and no-heat urgency are more likely.", action: hot ? "Bring cooling-side parts and expect elevated customer urgency." : "Bring heating-side parts and treat no-heat as time-critical for vulnerable occupants." });
  }
  if (wet && OUTDOOR_RE.test(serviceType)) {
    flag({ code: "weather_rain_outdoor", severity: "watch", node: "weather", title: "Rain likely during outdoor work", detail: `${forecast.precip_prob_max}% chance of precipitation.`, action: "Plan weather protection or a backup time slot." });
  }
  if (windy && OUTDOOR_RE.test(serviceType)) {
    flag({ code: "weather_wind_outdoor", severity: "watch", node: "weather", title: "High wind during outdoor work", detail: `Gusts up to ${Math.round(forecast.wind_max_mph ?? 0)} mph.`, action: "Check ladder and roof safety limits before starting." });
  }

  // ---- Equipment ------------------------------------------------
  sources.equipment = equipment.length ? "internal" : "missing";
  if (!equipment.length) {
    add({ id: "equipment", type: "equipment", label: "No equipment on record", status: "unknown", detail: "Nothing linked to this job or customer." }, "services");
    flag({ code: "equipment_unknown", severity: "watch", node: "equipment", title: "No equipment on record", detail: "The technician arrives without a make, model or age.", action: "Ask the customer for the equipment label photo, or capture model and serial on arrival." });
  } else {
    equipment.forEach((e, i) => {
      const id = `equipment_${i + 1}`;
      const label = [str(e.make), str(e.model)].filter(Boolean).join(" ") || str(e.type) || "Equipment";
      const age = num(e.age_years);
      const life = num(e.expected_lifespan_years);
      const since = num(e.months_since_service);
      const interval = num(e.service_interval_months);
      let status: NodeStatus = "ok";
      const notes: string[] = [];
      if (age !== null) notes.push(`${age} yrs old`);
      if (age !== null && life) {
        if (age > life) {
          status = "risk";
          flag({ code: "equipment_past_life", severity: "risk", node: id, title: `${label} is past its expected lifespan`, detail: `${age} years old vs ${life} expected.`, action: "Prepare a repair-vs-replace conversation and have a replacement quote ready." });
        } else if (age >= life * 0.8) {
          status = "watch";
          flag({ code: "equipment_near_life", severity: "watch", node: id, title: `${label} is near end of life`, detail: `${age} of ${life} expected years.`, action: "Expect repeat failures; mention a long-term replacement plan." });
        }
      }
      if (since !== null && interval && since > interval * 1.5) {
        if (status === "ok") status = "watch";
        notes.push(`${since} months since service`);
        flag({ code: "equipment_service_overdue", severity: "watch", node: id, title: `${label} is overdue for maintenance`, detail: `${since} months since the last service (interval ${interval}).`, action: "Check filters, coils and consumables first; offer a maintenance plan." });
      }
      if (e.warranty_active === true) {
        notes.push("under warranty");
        flag({ code: "equipment_warranty", severity: "info", node: id, title: `${label} may be under warranty`, detail: "Warranty is still active on file.", action: "Verify coverage with the manufacturer before billing parts." });
      }
      if (age === null && !notes.length) notes.push("no install date on file");
      add({ id, type: "equipment", label, status, detail: notes.join(" · ") || "On record." }, "services");
    });
    if (facts.equipment_source === "customer") {
      flag({ code: "equipment_not_linked", severity: "info", node: "equipment_1", title: "Equipment taken from the customer's file", detail: "It is not linked to this job yet.", action: "Link the exact unit to the job so history stays accurate." });
    }
  }

  // ---- Regional / model failure pattern (own data) -------------------
  for (const p of patterns) {
    const n = num(p.sample_jobs) ?? 0;
    const r = num(p.rework_jobs) ?? 0;
    sources.pattern = "internal";
    if (n >= 5 && r / n >= 0.25) {
      const label = `${str(p.make) ?? ""} ${str(p.model) ?? ""}`.trim();
      add({ id: `pattern_${nodes.length}`, type: "pattern", label: `${label}: ${Math.round((r / n) * 100)}% rework`, status: "watch", detail: `${r} of ${n} jobs on this model in the last 12 months needed rework.` }, "pattern");
      flag({ code: "model_rework_pattern", severity: "watch", node: `pattern_${nodes.length - 1}`, title: `${label} shows elevated rework in your history`, detail: `${r} of ${n} recent jobs needed a second visit.`, action: "Review earlier jobs on this model and bring the parts that failed before." });
    }
  }
  if (!sources.pattern) sources.pattern = equipment.length ? "internal" : "missing";

  // ---- History --------------------------------------------------
  const jobs24 = num(history.jobs_24m) ?? 0;
  sources.history = lifecycle ? "internal" : "missing";
  const repeat90 = num(history.same_service_90d) ?? 0;
  const disputed = num(history.disputed_24m) ?? 0;
  const rework = num(history.rework_24m) ?? 0;
  const historyStatus: NodeStatus = repeat90 > 0 || disputed > 0 ? "risk" : rework >= 2 ? "watch" : "ok";
  add({ id: "history", type: "history", label: `${jobs24} job${jobs24 === 1 ? "" : "s"} in 24 months`, status: lifecycle ? historyStatus : "unknown", detail: lifecycle ? `${num(history.completed_24m) ?? 0} completed · ${rework} rework · ${disputed} disputed.` : "No customer history linked." }, "previous");
  if (repeat90 > 0) {
    flag({ code: "repeat_visit_90d", severity: "risk", node: "history", title: "Same service completed within the last 90 days", detail: `${repeat90} earlier visit${repeat90 === 1 ? "" : "s"} for this service. This may be a callback.`, action: "Review the earlier job notes first and assign a senior technician." });
  }
  if (disputed > 0) {
    flag({ code: "prior_dispute", severity: "risk", node: "history", title: "Customer disputed an earlier job", detail: `${disputed} disputed job${disputed === 1 ? "" : "s"} in 24 months.`, action: "Brief the technician, use No-Surprise disclosures for any extra cost, and document the visit well." });
  }
  if (rework >= 2 && repeat90 === 0) {
    flag({ code: "history_rework", severity: "watch", node: "history", title: "Repeated rework for this customer", detail: `${rework} rework visits in 24 months.`, action: "Look for a root cause before repeating the same fix." });
  }

  // ---- Permit ---------------------------------------------------
  const likelihood = str(permit.permit_likelihood);
  sources.permit = likelihood ? "internal" : "missing";
  const permitStatus: NodeStatus = likelihood === "likely_required" ? "risk" : likelihood === "possibly_required" ? "watch" : likelihood ? "ok" : "unknown";
  add({ id: "permit", type: "permit", label: likelihood ? `Permit: ${likelihood.replace(/_/g, " ")}` : "Permit not reviewed", status: permitStatus, detail: likelihood ? "From the AI Permit Compliance review." : "No compliance review has been generated for this job." }, "regulated_by");
  if (likelihood === "likely_required") {
    flag({ code: "permit_required", severity: "risk", node: "permit", title: "A permit is likely required", detail: "Starting work without a permit can cause fines and failed inspections.", action: "Confirm local rules and file the permit before the work starts." });
  } else if (likelihood === "possibly_required") {
    flag({ code: "permit_possible", severity: "watch", node: "permit", title: "A permit may be required", detail: "Rules differ by jurisdiction and scope of work.", action: "Verify with the local building department." });
  }

  // ---- Parts ----------------------------------------------------
  const required = num(parts.required) ?? 0;
  const backordered = num(parts.backordered) ?? 0;
  const short = num(parts.short) ?? 0;
  sources.parts = required > 0 ? "internal" : "missing";
  add({ id: "parts", type: "parts", label: required ? `${required} part${required === 1 ? "" : "s"} required` : "No parts listed", status: backordered > 0 || short > 0 ? "risk" : required ? "ok" : "unknown", detail: required ? `${short} short · ${backordered} backordered.` : "No parts requirement on this job." }, "needs");
  if (backordered > 0) {
    flag({ code: "parts_backordered", severity: "risk", node: "parts", title: `${backordered} part${backordered === 1 ? "" : "s"} backordered`, detail: "The technician may not be able to finish on the first visit.", action: "Source the part elsewhere or tell the customer about the delay before dispatch." });
  } else if (short > 0) {
    flag({ code: "parts_short", severity: "risk", node: "parts", title: `${short} part${short === 1 ? "" : "s"} not in stock`, detail: "Available stock is below the quantity this job needs.", action: "Reserve or purchase the parts before the technician leaves." });
  }

  // ---- Technician -----------------------------------------------
  const assigned = tech.assigned === true;
  sources.technician = assigned ? "internal" : "missing";
  if (!assigned) {
    add({ id: "technician", type: "technician", label: "No technician assigned", status: "risk", detail: "Dispatch cannot happen yet." }, "performed_by");
    flag({ code: "no_technician", severity: "risk", node: "technician", title: "No technician assigned", detail: "This job is not ready to dispatch.", action: "Assign a technician with experience in this service type." });
  } else {
    const ftf = num(tech.first_time_fix_rate);
    const cb = num(tech.callback_rate);
    const same = num(tech.same_service_completed) ?? 0;
    const prior = num(tech.prior_visits_to_customer) ?? 0;
    let status: NodeStatus = "ok";
    const notes: string[] = [`${same} similar job${same === 1 ? "" : "s"} done`];
    if (prior > 0) notes.push(`visited this customer ${prior}×`);
    if (ftf !== null) notes.push(`${ftf}% first-time fix`);
    if (same === 0 && serviceType) {
      status = "watch";
      flag({ code: "tech_no_experience", severity: "watch", node: "technician", title: "Technician has no completed jobs of this type", detail: `No completed ${serviceType} jobs on record for the assigned technician.`, action: "Pair with a senior technician or make sure remote support is available." });
    }
    if ((ftf !== null && ftf < 70) || (cb !== null && cb > 10)) {
      status = "watch";
      flag({ code: "tech_recent_performance", severity: "watch", node: "technician", title: "Recent first-time-fix or callback rate is below target", detail: `First-time fix ${ftf ?? "n/a"}% · callbacks ${cb ?? "n/a"}%.`, action: "Review the job plan together before dispatch." });
    }
    add({ id: "technician", type: "technician", label: "Assigned technician", status, detail: notes.join(" · ") }, "performed_by");
    if (prior > 0) {
      flag({ code: "tech_continuity", severity: "info", node: "technician", title: "Technician already knows this customer", detail: `${prior} earlier completed visit${prior === 1 ? "" : "s"}.`, action: "Keep the same technician when possible." });
    }
  }

  // ---- Score ----------------------------------------------------
  const penalty = flags.reduce((sum, f) => sum + PENALTY[f.severity], 0);
  const keys = ["customer", "property", "weather", "equipment", "history", "permit", "parts", "technician"];
  const known = keys.filter((k) => sources[k] && sources[k] !== "missing").length;
  const coverage = Math.round((known / keys.length) * 100);
  // Unknown context is not "ready": the score can never exceed what the available context supports.
  const ceiling = 40 + Math.round(coverage * 0.6);
  const readiness = Math.max(0, Math.min(100, ceiling, 100 - penalty));
  const risk: RiskLevel = flags.some((f) => f.severity === "critical") || readiness < 40 ? "critical" : readiness < 60 ? "high" : readiness < 80 ? "medium" : "low";

  const order: Record<FlagSeverity, number> = { critical: 0, risk: 1, watch: 2, info: 3 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  return { nodes, edges, flags, readiness_score: readiness, coverage_pct: coverage, risk_level: risk, sources };
}
