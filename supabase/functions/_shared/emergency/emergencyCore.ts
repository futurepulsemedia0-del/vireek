// supabase/functions/_shared/emergency/emergencyCore.ts
//
// Vireek Autonomous Emergency Network — pure decision logic.
//
// Deliberately free of I/O and of any import so it runs unchanged in Deno (edge function) and in
// vitest, and so every number the orchestrator acts on can be explained and unit-tested:
//   - ETA estimation (distance x road factor x time-of-day traffic profile)
//   - technician ranking with a transparent 0-100 score and explicit exclusion reasons
//   - the routing decision:   own technician  |  Contractor Network  |  own technician (late)  |  a person
//   - fixed, reviewed message templates (life-safety lines are NEVER generated)
//
// Keep the safety lines in sync with HAZARD_OPTIONS in src/lib/emergencyTriage.ts.

export type Tier = "critical" | "high" | "standard";
export type Trade = "hvac" | "plumbing" | "electrical" | "roofing" | "restoration" | "locksmith" | "general";

// ---------------------------------------------------------------------------
// Geometry + ETA
// ---------------------------------------------------------------------------

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local hour (0-23) in an IANA timezone; falls back to the UTC hour when the zone is invalid. */
export function localHour(date: Date, timeZone?: string | null): number {
  if (timeZone) {
    try {
      const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date);
      const n = Number(h);
      if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
    } catch {
      /* invalid timezone: fall through */
    }
  }
  return date.getUTCHours();
}

export interface TrafficProfile {
  label: "night" | "rush_hour" | "daytime";
  speedMph: number;
}

/** Average door-to-door road speed by local hour. A model, not a live feed — and labelled as such. */
export function trafficProfile(hour: number): TrafficProfile {
  if (hour >= 22 || hour < 5) return { label: "night", speedMph: 36 };
  if ((hour >= 7 && hour < 10) || (hour >= 16 && hour < 19)) return { label: "rush_hour", speedMph: 17 };
  return { label: "daytime", speedMph: 25 };
}

const ROAD_FACTOR = 1.35; // straight line -> typical road distance
const PREP_MINUTES = 5; // pick up the alert, grab the keys
const BUSY_PENALTY_MINUTES = 35; // currently on another job: remaining time is unknown, so assume a typical wrap-up
const UNKNOWN_LOCATION_TRAVEL_MINUTES = 30;

export interface EtaInput {
  distanceMiles: number | null;
  hour: number;
  busyNow: boolean;
}

export interface EtaEstimate {
  minutes: number;
  basis: {
    model: "straight_line_x_road_factor_x_time_of_day";
    distance_miles: number | null;
    road_miles: number | null;
    speed_mph: number;
    traffic: TrafficProfile["label"];
    prep_minutes: number;
    busy_penalty_minutes: number;
    location_known: boolean;
  };
}

export function estimateEta(input: EtaInput): EtaEstimate {
  const traffic = trafficProfile(input.hour);
  const known = input.distanceMiles !== null && Number.isFinite(input.distanceMiles);
  const roadMiles = known ? (input.distanceMiles as number) * ROAD_FACTOR : null;
  const travel = roadMiles !== null ? (roadMiles / traffic.speedMph) * 60 : UNKNOWN_LOCATION_TRAVEL_MINUTES;
  const busy = input.busyNow ? BUSY_PENALTY_MINUTES : 0;
  const total = travel + PREP_MINUTES + busy;
  return {
    minutes: Math.max(5, Math.ceil(total / 5) * 5),
    basis: {
      model: "straight_line_x_road_factor_x_time_of_day",
      distance_miles: known ? Math.round((input.distanceMiles as number) * 10) / 10 : null,
      road_miles: roadMiles !== null ? Math.round(roadMiles * 10) / 10 : null,
      speed_mph: traffic.speedMph,
      traffic: traffic.label,
      prep_minutes: PREP_MINUTES,
      busy_penalty_minutes: busy,
      location_known: known,
    },
  };
}

export function formatEta(minutes: number): string {
  if (minutes < 60) return `about ${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `about ${h} hour${h === 1 ? "" : "s"}`;
  return `about ${h} hr ${m} min`;
}

// ---------------------------------------------------------------------------
// Technician ranking
// ---------------------------------------------------------------------------

export interface TechInput {
  id: string;
  name: string | null;
  skills: string[];
  maxJobsPerDay: number;
  jobsToday: number;
  busyNow: boolean;
  lat: number | null;
  lon: number | null;
  /** true when the position is a live GPS fix from the last 30 minutes; false for a home base. */
  locationFresh: boolean;
  partsRequired: number;
  partsOnVan: number;
}

export interface ScoreBreakdown {
  eta: number; // 0-40
  skill: number; // 0-30
  stock: number; // 0-15
  load: number; // 0-10
  location: number; // 0-5
}

export interface RankedTech {
  id: string;
  name: string | null;
  score: number;
  etaMinutes: number;
  etaBasis: EtaEstimate["basis"];
  breakdown: ScoreBreakdown;
  busyNow: boolean;
  jobsToday: number;
}

export type ExclusionReason = "no_matching_skill" | "at_capacity";

export interface ExcludedTech {
  id: string;
  name: string | null;
  reason: ExclusionReason;
}

export interface RankingResult {
  ranked: RankedTech[];
  excluded: ExcludedTech[];
}

function skillMatches(skills: string[], trade: Trade): boolean {
  if (trade === "general") return true;
  const t = trade.toLowerCase();
  return skills.some((s) => s.toLowerCase().includes(t));
}

export function rankTechnicians(params: {
  techs: TechInput[];
  trade: Trade;
  site: { lat: number | null; lon: number | null };
  hour: number;
  /** Used to scale the ETA component: an ETA at 2x the owner's limit scores 0. */
  maxInternalEtaMinutes: number;
}): RankingResult {
  const ranked: RankedTech[] = [];
  const excluded: ExcludedTech[] = [];

  for (const t of params.techs) {
    if (!skillMatches(t.skills, params.trade)) {
      excluded.push({ id: t.id, name: t.name, reason: "no_matching_skill" });
      continue;
    }
    if (t.jobsToday >= Math.max(1, t.maxJobsPerDay)) {
      excluded.push({ id: t.id, name: t.name, reason: "at_capacity" });
      continue;
    }

    const hasPos = t.lat !== null && t.lon !== null && params.site.lat !== null && params.site.lon !== null;
    const distance = hasPos ? haversineMiles(t.lat as number, t.lon as number, params.site.lat as number, params.site.lon as number) : null;
    const eta = estimateEta({ distanceMiles: distance, hour: params.hour, busyNow: t.busyNow });

    const etaScore = 40 * Math.max(0, 1 - eta.minutes / (2 * Math.max(1, params.maxInternalEtaMinutes)));
    const skillScore = params.trade === "general" ? 15 : 30;
    const stockScore = t.partsRequired > 0 ? 15 * (Math.min(t.partsOnVan, t.partsRequired) / t.partsRequired) : 7;
    const loadScore = 10 * Math.max(0, (Math.max(1, t.maxJobsPerDay) - t.jobsToday) / Math.max(1, t.maxJobsPerDay));
    const locationScore = !hasPos ? 0 : t.locationFresh ? 5 : 2;

    const breakdown: ScoreBreakdown = {
      eta: round1(etaScore),
      skill: skillScore,
      stock: round1(stockScore),
      load: round1(loadScore),
      location: locationScore,
    };
    const score = round1(breakdown.eta + breakdown.skill + breakdown.stock + breakdown.load + breakdown.location);

    ranked.push({
      id: t.id,
      name: t.name,
      score,
      etaMinutes: eta.minutes,
      etaBasis: eta.basis,
      breakdown,
      busyNow: t.busyNow,
      jobsToday: t.jobsToday,
    });
  }

  // Faster beats "better score" when scores tie; id keeps the order deterministic.
  ranked.sort((a, b) => b.score - a.score || a.etaMinutes - b.etaMinutes || a.id.localeCompare(b.id));
  return { ranked, excluded };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Routing decision:  "No technician available" != "No service available"
// ---------------------------------------------------------------------------

export type Route = "internal" | "network" | "internal_late" | "needs_human";

export interface RouteDecision {
  route: Route;
  candidate: RankedTech | null;
  /** Plain-language reason, shown to the owner and stored on the incident. */
  reason: string;
}

export function decideRoute(params: {
  ranking: RankingResult;
  autoDispatch: boolean;
  maxInternalEtaMinutes: number;
  network: { member: boolean; rejected: boolean; alreadyTried: boolean };
}): RouteDecision {
  const best = params.ranking.ranked[0] ?? null;

  if (!params.autoDispatch) {
    return {
      route: "needs_human",
      candidate: best,
      reason: best
        ? `Automatic dispatch is off. Best match: ${best.name ?? "a technician"} (${formatEta(best.etaMinutes)}).`
        : "Automatic dispatch is off and no technician matches.",
    };
  }

  if (best && best.etaMinutes <= params.maxInternalEtaMinutes) {
    return {
      route: "internal",
      candidate: best,
      reason: `${best.name ?? "A technician"} can arrive in ${formatEta(best.etaMinutes)} (limit ${params.maxInternalEtaMinutes} min).`,
    };
  }

  const why = best
    ? `Our best ETA is ${formatEta(best.etaMinutes)}, beyond the ${params.maxInternalEtaMinutes}-minute limit.`
    : explainNoTechnician(params.ranking.excluded);

  const networkOpen = params.network.member && !params.network.rejected && !params.network.alreadyTried;
  if (networkOpen) {
    return { route: "network", candidate: best, reason: `${why} Handing the call to the Contractor Network.` };
  }

  const blocker = !params.network.member
    ? "The business has not joined the Contractor Network."
    : params.network.rejected
      ? "A person declined the network hand-off."
      : "The network search already ran without an accepted partner.";

  if (best) {
    return { route: "internal_late", candidate: best, reason: `${why} ${blocker} Sending our best available technician.` };
  }
  return { route: "needs_human", candidate: null, reason: `${why} ${blocker} A person must take over.` };
}

export function explainNoTechnician(excluded: ExcludedTech[]): string {
  if (excluded.length === 0) return "No dispatch-enabled technician is on the team.";
  const skill = excluded.filter((e) => e.reason === "no_matching_skill").length;
  const cap = excluded.filter((e) => e.reason === "at_capacity").length;
  const parts: string[] = [];
  if (cap > 0) parts.push(`${cap} technician${cap === 1 ? " is" : "s are"} at daily capacity`);
  if (skill > 0) parts.push(`${skill} lack${skill === 1 ? "s" : ""} the required skill`);
  return `No technician is available: ${parts.join(" and ")}.`;
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export type SlaState = "ok" | "at_risk" | "breached";

export function slaState(now: Date, dueAt: Date, slaMinutes: number): { state: SlaState; minutesLeft: number } {
  const minutesLeft = Math.floor((dueAt.getTime() - now.getTime()) / 60000);
  if (minutesLeft < 0) return { state: "breached", minutesLeft };
  if (minutesLeft <= Math.max(5, Math.floor(slaMinutes * 0.25))) return { state: "at_risk", minutesLeft };
  return { state: "ok", minutesLeft };
}

// ---------------------------------------------------------------------------
// Messages. Fixed templates only — a life-safety instruction is never model-generated.
// ---------------------------------------------------------------------------

const SAFETY_LINES: Record<string, string> = {
  gas: "Gas smell: leave the building now, don't touch switches or phones inside, and call 911 or your gas utility from outside.",
  smoke: "Smoke: get everyone out immediately and call 911 if you see flames. Don't go back in.",
  electric: "Electrical: stay away from the affected area, switch off that breaker only if it is safe to reach, and don't touch anything wet.",
  water: "Water: if you can, shut off the main water valve and keep electrical items away from the water.",
};

const SAFETY_ORDER = ["gas", "smoke", "electric", "water"];

export function safetyText(hazards: string[]): string | null {
  const lines = SAFETY_ORDER.filter((h) => hazards.includes(h)).map((h) => SAFETY_LINES[h]);
  return lines.length > 0 ? lines.slice(0, 2).join(" ") : null;
}

export function firstName(name: string | null | undefined): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || "your technician";
}

export type CustomerMessageKind = "assigned" | "partner_search" | "partner_found" | "en_route" | "on_site" | "delayed" | "resolved";

export interface CustomerMessageContext {
  businessName: string;
  technicianName?: string | null;
  etaMinutes?: number | null;
  trackingUrl?: string | null;
  hazards?: string[];
  partnerName?: string | null;
  partnerPhone?: string | null;
}

export function customerMessage(kind: CustomerMessageKind, c: CustomerMessageContext): string {
  const biz = c.businessName || "Your service team";
  const eta = c.etaMinutes ? formatEta(c.etaMinutes) : null;
  const track = c.trackingUrl ? ` Track live: ${c.trackingUrl}` : "";
  const safety = safetyText(c.hazards ?? []);

  switch (kind) {
    case "assigned":
      return [
        `${biz}: we received your emergency. ${firstName(c.technicianName)} is on the way${eta ? `, arriving ${eta}` : ""} (an estimate).${track}`,
        safety,
      ].filter(Boolean).join(" ");
    case "partner_search":
      return [
        `${biz}: we received your emergency and our own crews are fully booked, so we are arranging a trusted partner technician right now. You'll hear from us within minutes.`,
        safety,
      ].filter(Boolean).join(" ");
    case "partner_found":
      return `${biz}: a trusted partner, ${c.partnerName ?? "a local contractor"}, is on the way to your emergency${c.partnerPhone ? `. Their number: ${c.partnerPhone}` : ""}. We remain your point of contact.`;
    case "en_route":
      return `${biz}: ${firstName(c.technicianName)} is now en route${eta ? `, arriving ${eta}` : ""}.${track}`;
    case "on_site":
      return `${biz}: ${firstName(c.technicianName)} has arrived and is starting work.`;
    case "delayed":
      return `${biz}: we're sorry — ${firstName(c.technicianName)} is running behind${eta ? `; new estimate ${eta}` : ""}. We are monitoring your emergency.${track}`;
    case "resolved":
      return `${biz}: your emergency work is complete. If anything doesn't look right, reply here or call us and we'll make it right.`;
  }
}

export interface TechnicianBriefContext {
  customerName: string;
  customerPhone: string | null;
  address: string | null;
  description: string | null;
  hazards: string[];
  tier: Tier;
  etaMinutes: number | null;
  missingParts: string[];
  insuranceInvolved: boolean;
}

export function technicianBrief(c: TechnicianBriefContext): string {
  const parts: string[] = [
    `EMERGENCY (${c.tier.toUpperCase()}): ${c.customerName}${c.address ? `, ${c.address}` : ""}.`,
  ];
  if (c.description) parts.push(c.description.slice(0, 160));
  if (c.hazards.length > 0) parts.push(`Hazards: ${c.hazards.join(", ")}.`);
  if (c.customerPhone) parts.push(`Customer: ${c.customerPhone}.`);
  if (c.etaMinutes) parts.push(`Customer was told ${formatEta(c.etaMinutes)}.`);
  if (c.missingParts.length > 0) parts.push(`Not on your van: ${c.missingParts.slice(0, 4).join(", ")}${c.missingParts.length > 4 ? "…" : ""}.`);
  if (c.insuranceInvolved) parts.push("Insurance involved: photograph all damage before touching anything.");
  return parts.join(" ");
}

export type OwnerAlertKind = "approval_needed" | "needs_human" | "sla_breach" | "partner_accepted" | "network_failed" | "dispatched";

export function ownerAlert(kind: OwnerAlertKind, c: { customerName: string; tier: Tier; detail?: string }): { title: string; message: string } {
  const who = `${c.customerName} (${c.tier})`;
  switch (kind) {
    case "approval_needed":
      return {
        title: "Emergency: approve network hand-off",
        message: `${who}: our crews can't respond fast enough. ${c.detail ?? ""} Approve in Emergency Network to send it to a trusted partner.`.trim(),
      };
    case "needs_human":
      return { title: "Emergency needs a person now", message: `${who}: ${c.detail ?? "automatic handling could not complete."}` };
    case "sla_breach":
      return { title: "Emergency SLA breached", message: `${who}: ${c.detail ?? "the response target has passed."}` };
    case "partner_accepted":
      return { title: "Partner accepted the emergency", message: `${who}: ${c.detail ?? "a network partner is on the way."}` };
    case "network_failed":
      return { title: "Network search did not find a partner", message: `${who}: ${c.detail ?? "falling back to our own technician."}` };
    case "dispatched":
      return { title: "Emergency dispatched", message: `${who}: ${c.detail ?? "a technician was assigned."}` };
  }
}
