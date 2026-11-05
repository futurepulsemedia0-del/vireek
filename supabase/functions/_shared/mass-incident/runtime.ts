// supabase/functions/_shared/mass-incident/runtime.ts
//
// I/O layer for Mass Incident Mode. All decisions are made by ./core.ts (pure, unit-tested); this file only
// loads data, commits the plan through the locked RPC and sends owner / customer messages.
//
// Contract: every export used on a CALL PATH (ingestIncidentContact, getAreaGuidance, buildIncidentVoiceContext)
// is BEST EFFORT and NEVER throws, so a failure here can never break a call, a booking or the webhook response.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { embeddingProviderConfigured, embedTexts } from "../knowledge/search.ts";
import { loadRegional } from "../regional/regional.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import { geocodeAddress } from "../service-areas/resolve.ts";
import {
  CAUSE_TO_SERVICE,
  DEFAULT_PARAMS,
  LIMITS,
  buildBookingNote,
  buildBroadcastText,
  buildSmsAutoReplyText,
  buildGuidance,
  classifySymptom,
  computeScope,
  decideCluster,
  extractPostal,
  incidentTitle,
  inferCause,
  looksGeocodable,
  nextStatusByInactivity,
  normalizePostal,
  pickDirectoryEntry,
  scoreIncident,
  statusForNewScore,
  triageContact,
  type ClusterParams,
  type ContactSource,
  type DirectoryEntry,
  type DirectoryService,
  type ExternalSignal,
  type GeoPrecision,
  type IncidentContact,
  type IncidentForTriage,
  type IncidentScope,
  type IncidentSnapshot,
  type IncidentStatus,
  type SuspectedCause,
  type SymptomClass,
  type TriageResult,
} from "./core.ts";
import { screenSafety, type SafetyReason } from "../remote-resolution/score.ts";

type Admin = SupabaseClient;

const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));
const logErr = (event: string, error: unknown, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.message : String(error), ...extra }));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TenantSettings {
  enabled: boolean;
  params: ClusterParams;
  version: number;
  notifyOwner: boolean;
  autoReplySms: boolean;
}

export async function loadIncidentSettings(admin: Admin, userId: string): Promise<TenantSettings | null> {
  const { data, error } = await admin
    .from("mass_incident_settings")
    .select("enabled, window_minutes, radius_miles, min_contacts, notify_owner, cluster_version, auto_reply_sms")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data || !data.enabled) return null;
  return {
    enabled: true,
    params: { ...DEFAULT_PARAMS, windowMinutes: Number(data.window_minutes), radiusMiles: Number(data.radius_miles), minContacts: Number(data.min_contacts) },
    version: Number(data.cluster_version),
    notifyOwner: Boolean(data.notify_owner),
    autoReplySms: Boolean(data.auto_reply_sms),
  };
}

// ---------------------------------------------------------------------------
// Geo (postal centroid, cached). Address-level geocoding is intentionally NOT done on the call path:
// Nominatim is limited to 1 request/second, which would fail exactly during a surge.
// ---------------------------------------------------------------------------

export async function resolvePostalCentroid(admin: Admin, country: string, postal: string): Promise<{ lat: number; lng: number } | null> {
  const cc = country.toUpperCase();
  if (cc !== "US" && cc !== "CA") return null;
  try {
    const { data: hit } = await admin.from("mass_incident_postal_cache").select("lat, lng, fetched_at").eq("country", cc).eq("postal_code", postal).maybeSingle();
    if (hit) return { lat: Number(hit.lat), lng: Number(hit.lng) };
    const res = await fetch(`https://api.zippopotam.us/${cc.toLowerCase()}/${encodeURIComponent(postal)}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const place = (await res.json())?.places?.[0];
    const lat = Number(place?.latitude);
    const lng = Number(place?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    await admin.from("mass_incident_postal_cache").upsert({ country: cc, postal_code: postal, lat, lng }, { onConflict: "country,postal_code" });
    return { lat, lng };
  } catch (e) {
    logErr("mass_incident_geo_failed", e, { postal });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface ContactRow {
  id: string; source: ContactSource; contact_at: string; postal_code: string | null; lat: number | null; lng: number | null;
  geo_precision: GeoPrecision; symptom_class: SymptomClass; symptom_text: string; is_emergency: boolean; hazards: string[];
  embedding: number[] | null; incident_id: string | null; contact_phone?: string | null;
}
const CONTACT_COLS = "id, source, contact_at, postal_code, lat, lng, geo_precision, symptom_class, symptom_text, is_emergency, hazards, embedding, incident_id, contact_phone";

const toContact = (r: ContactRow): IncidentContact => ({
  id: r.id, source: r.source, contactAt: r.contact_at, postalCode: r.postal_code, lat: r.lat, lng: r.lng, geoPrecision: r.geo_precision,
  symptomClass: r.symptom_class, symptomText: r.symptom_text, isEmergency: r.is_emergency, hazards: (r.hazards ?? []) as SafetyReason[],
  embedding: r.embedding && r.embedding.length ? r.embedding : null, incidentId: r.incident_id,
});

interface IncidentRow {
  id: string; status: IncidentStatus; symptom_class: SymptomClass; scope: IncidentScope; confidence: number; suspected_cause: SuspectedCause;
  cause_status: "suspected" | "corroborated" | "owner_confirmed"; cause_confidence: number; member_count: number; first_contact_at: string;
  last_contact_at: string; owner_confirmed_cause: SuspectedCause | null;
}
const INCIDENT_COLS = "id, status, symptom_class, scope, confidence, suspected_cause, cause_status, cause_confidence, member_count, first_contact_at, last_contact_at, owner_confirmed_cause";

const toSnapshot = (r: IncidentRow): IncidentSnapshot => ({
  id: r.id, status: r.status, scope: r.scope, symptomClass: r.symptom_class, firstContactAt: r.first_contact_at, lastContactAt: r.last_contact_at, memberCount: r.member_count,
});
const toTriageIncident = (r: IncidentRow): IncidentForTriage => ({
  id: r.id, status: r.status, symptomClass: r.symptom_class, scope: r.scope, confidence: Number(r.confidence), cause: r.suspected_cause,
  causeStatus: r.cause_status, causeConfidence: Number(r.cause_confidence), memberCount: r.member_count, firstContactAt: r.first_contact_at,
});

async function loadOpenIncidents(admin: Admin, userId: string): Promise<IncidentRow[]> {
  const { data, error } = await admin.from("mass_incidents").select(INCIDENT_COLS).eq("user_id", userId)
    .in("status", ["watching", "active", "monitoring"]).order("last_contact_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as IncidentRow[];
}

async function loadSignals(admin: Admin, userId: string, now: Date): Promise<ExternalSignal[]> {
  const { data, error } = await admin.from("mass_incident_signals")
    .select("id, kind, headline, postal_codes, lat, lng, radius_miles, verified, effective_at, expires_at, corroborates")
    .eq("user_id", userId).or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`).limit(100);
  if (error) throw error;
  return (data ?? []).map((s: Record<string, unknown>) => ({
    id: String(s.id), kind: s.kind as ExternalSignal["kind"], headline: String(s.headline), postalCodes: (s.postal_codes as string[]) ?? [],
    lat: (s.lat as number | null) ?? null, lng: (s.lng as number | null) ?? null, radiusMiles: s.radius_miles == null ? null : Number(s.radius_miles),
    verified: Boolean(s.verified), effectiveAt: (s.effective_at as string | null) ?? null, expiresAt: (s.expires_at as string | null) ?? null,
    corroborates: ((s.corroborates as string[]) ?? []) as SuspectedCause[],
  }));
}

export async function loadDirectory(admin: Admin, userId: string, country: string): Promise<DirectoryEntry[]> {
  const { data, error } = await admin.from("mass_incident_directory")
    .select("id, user_id, country, region, postal_prefix, service, name, phone, website, source_url, verified_at, status")
    .eq("country", country.toUpperCase()).eq("status", "verified").or(`user_id.is.null,user_id.eq.${userId}`).limit(500);
  if (error) throw error;
  return (data ?? []).map((d: Record<string, unknown>) => ({
    id: String(d.id), userId: (d.user_id as string | null) ?? null, country: String(d.country), region: (d.region as string | null) ?? null,
    postalPrefix: (d.postal_prefix as string | null) ?? null, service: d.service as DirectoryService, name: String(d.name),
    phone: (d.phone as string | null) ?? null, website: (d.website as string | null) ?? null, sourceUrl: String(d.source_url),
    verifiedAt: (d.verified_at as string | null) ?? null, status: d.status as DirectoryEntry["status"],
  }));
}

/** Tenant "region" (state / province) comes from the owner's business address when known; null otherwise. */
async function tenantRegion(admin: Admin, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.from("business_profile").select("service_area").eq("user_id", userId).maybeSingle();
    const m = /\b([A-Z]{2})\b(?:\s+\d{5}|\s*$)/.exec(String((data as { service_area?: string } | null)?.service_area ?? ""));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestInput {
  userId: string;
  source: ContactSource;
  /** Stable id of the contact in its own system (vapi call id, sms message id, lead id). Makes ingest idempotent. */
  sourceRef: string;
  contactAt?: string;
  phone?: string | null;
  callId?: string | null;
  customerId?: string | null;
  address?: string | null;
  postalCode?: string | null;
  symptomText: string;
  isEmergency?: boolean;
  triageDecision?: TriageResult["decision"] | null;
}

export type IngestResult =
  | { status: "disabled" | "duplicate" | "error" | "conflict_exhausted"; incidentId?: string | null }
  | { status: "ok"; contactId: string; incidentId: string | null; created: boolean };

interface CommitMeta {
  source: ContactSource;
  sourceRef: string;
  phone: string | null;
  callId: string | null;
  customerId: string | null;
  addressText: string | null;
  triageDecision: TriageResult["decision"] | null;
}

/** Plans the cluster decision for ONE contact and commits it under the per-account lock (optimistic version, 3 tries). */
async function commitContact(admin: Admin, userId: string, settings: TenantSettings, contact: IncidentContact, meta: CommitMeta): Promise<IngestResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = attempt === 0 ? settings : (await loadIncidentSettings(admin, userId)) ?? settings;
    const now = new Date();
    const open = await loadOpenIncidents(admin, userId);
    const sinceIso = new Date(Date.now() - fresh.params.windowMinutes * 2 * 60_000).toISOString();
    const { data: poolRows } = await admin.from("mass_incident_contacts").select(CONTACT_COLS).eq("user_id", userId)
      .is("incident_id", null).eq("detached", false).gte("contact_at", sinceIso).order("contact_at", { ascending: false }).limit(LIMITS.maxCandidatePool);
    const pool = ((poolRows ?? []) as ContactRow[]).map(toContact);
    const decision = decideCluster(contact, open.map(toSnapshot), pool, fresh.params);
    const signals = await loadSignals(admin, userId, now);

    const plan: Record<string, unknown> = {
      action: decision.action,
      contact: {
        source: meta.source, source_ref: meta.sourceRef, call_id: meta.callId, customer_id: meta.customerId,
        contact_phone: meta.phone, contact_at: contact.contactAt, postal_code: contact.postalCode, lat: contact.lat, lng: contact.lng,
        geo_precision: contact.geoPrecision, symptom_class: contact.symptomClass, symptom_text: contact.symptomText,
        is_emergency: contact.isEmergency, hazards: contact.hazards, embedding: contact.embedding, triage_decision: meta.triageDecision,
        address_text: looksGeocodable(meta.addressText) && contact.geoPrecision !== "address" ? meta.addressText : null,
      },
    };

    if (decision.action === "attach" || decision.action === "create") {
      let members: IncidentContact[];
      let ownerCause: SuspectedCause | null = null;
      if (decision.action === "attach") {
        plan.incident_id = decision.incidentId;
        const row = open.find((o) => o.id === decision.incidentId);
        ownerCause = row?.owner_confirmed_cause ?? null;
        const { data: m } = await admin.from("mass_incident_contacts").select(CONTACT_COLS).eq("incident_id", decision.incidentId).limit(500);
        members = [...((m ?? []) as ContactRow[]).map(toContact).filter((c) => c.id !== contact.id), contact];
      } else {
        plan.candidate_ids = decision.candidateIds;
        members = [...pool.filter((p) => decision.candidateIds.includes(p.id)), contact];
      }
      const calm = members.filter((c) => !c.isEmergency && c.hazards.length === 0);
      const basis = calm.length ? calm : members;
      const scope = computeScope(basis);
      const cause = inferCause(basis, signals, now, ownerCause);
      const score = scoreIncident(members, scope, cause, fresh.params);
      const currentStatus = decision.action === "attach" ? open.find((o) => o.id === decision.incidentId)?.status ?? "watching" : "watching";
      plan.incident = {
        title: incidentTitle(cause.cause, scope), status: statusForNewScore(currentStatus, score.value, members.length, fresh.params),
        symptom_class: dominantSymptom(basis), scope, confidence: score.value, confidence_breakdown: score,
        suspected_cause: cause.cause, cause_status: cause.status, cause_confidence: cause.confidence, cause_uncertainty: cause.uncertainty,
        cause_basis: cause.basis, alternatives: cause.alternatives, corroborated_by: cause.corroboratedBy,
      };
    }

    const { data: res, error } = await admin.rpc("mass_incident_commit", { p_user_id: userId, p_expected_version: fresh.version, p_plan: plan });
    if (error) throw error;
    const r = res as { status: string; contact_id?: string; incident_id?: string | null; created?: boolean; version?: number };
    if (r.status === "conflict") {
      settings.version = Number(r.version ?? fresh.version);
      continue;
    }
    if (r.status === "disabled") return { status: "disabled" };
    if (r.created && r.incident_id && fresh.notifyOwner) await notifyOwnerOfIncident(admin, userId, r.incident_id);
    log("mass_incident_ingested", { user_id: userId, source: meta.source, incident_id: r.incident_id ?? null, created: Boolean(r.created) });
    return { status: "ok", contactId: String(r.contact_id), incidentId: r.incident_id ?? null, created: Boolean(r.created) };
  }
  return { status: "conflict_exhausted" };
}

export async function ingestIncidentContact(admin: Admin, input: IngestInput): Promise<IngestResult> {
  try {
    const settings = await loadIncidentSettings(admin, input.userId);
    if (!settings) return { status: "disabled" };

    const { data: existing } = await admin.from("mass_incident_contacts").select("id, incident_id").eq("user_id", input.userId).eq("source", input.source).eq("source_ref", input.sourceRef).maybeSingle();
    if (existing) return { status: "duplicate", incidentId: (existing as { incident_id: string | null }).incident_id };

    const text = String(input.symptomText ?? "").slice(0, 600);
    const regional = await loadRegional(admin, input.userId);
    const country = regional.country || "US";
    const postal = normalizePostal(input.postalCode) ?? extractPostal(input.address) ?? extractPostal(text);
    const centroid = postal ? await resolvePostalCentroid(admin, country, postal) : null;
    const safety = screenSafety([text]);
    const sym = classifySymptom(text);

    let embedding: number[] | null = null;
    if (text.length >= 8 && embeddingProviderConfigured()) {
      const v = await embedTexts([text], "search_document", 3000);
      embedding = v?.[0] && v[0].length <= 2048 ? v[0] : null;
    }

    const contact: IncidentContact = {
      id: crypto.randomUUID(), source: input.source, contactAt: input.contactAt ?? new Date().toISOString(), postalCode: postal,
      lat: centroid?.lat ?? null, lng: centroid?.lng ?? null, geoPrecision: centroid ? "postal" : "none",
      symptomClass: sym.symptomClass, symptomText: text, isEmergency: Boolean(input.isEmergency) || safety.hold,
      hazards: safety.reasons, embedding, incidentId: null,
    };
    return await commitContact(admin, input.userId, settings, contact, {
      source: input.source, sourceRef: input.sourceRef, phone: input.phone ?? null, callId: input.callId ?? null,
      customerId: input.customerId ?? null, addressText: input.address ?? null, triageDecision: input.triageDecision ?? null,
    });
  } catch (e) {
    logErr("mass_incident_ingest_failed", e, { user_id: input.userId, source: input.source });
    return { status: "error" };
  }
}

/** Re-evaluates an existing LOOSE contact (e.g. after its address was geocoded). Idempotent; never throws. */
async function reclusterContact(admin: Admin, userId: string, settings: TenantSettings, contactId: string): Promise<void> {
  try {
    const { data } = await admin.from("mass_incident_contacts").select(`${CONTACT_COLS}, source_ref, call_id, customer_id`).eq("id", contactId).eq("user_id", userId).eq("detached", false).is("incident_id", null).maybeSingle();
    if (!data) return;
    const row = data as ContactRow & { source_ref: string; call_id: string | null; customer_id: string | null };
    await commitContact(admin, userId, settings, toContact(row), {
      source: row.source, sourceRef: row.source_ref, phone: row.contact_phone ?? null, callId: row.call_id, customerId: row.customer_id, addressText: null, triageDecision: null,
    });
  } catch (e) {
    logErr("mass_incident_recluster_failed", e, { contact_id: contactId });
  }
}

function dominantSymptom(contacts: ReadonlyArray<IncidentContact>): SymptomClass {
  const n = new Map<SymptomClass, number>();
  for (const c of contacts) n.set(c.symptomClass, (n.get(c.symptomClass) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "other";
}

async function notifyOwnerOfIncident(admin: Admin, userId: string, incidentId: string): Promise<void> {
  try {
    const { data: inc } = await admin.from("mass_incidents").select("title, member_count").eq("id", incidentId).eq("user_id", userId).maybeSingle();
    if (!inc) return;
    // `alert` in the type makes notification-router treat it as a warning and apply the owner's routing rules.
    await admin.from("notifications").insert({
      user_id: userId, type: "mass_incident_alert", title: "Possible area-wide incident",
      message: `${(inc as { title: string }).title} — ${(inc as { member_count: number }).member_count} contacts grouped. This is a suspicion, not a confirmed cause. Review it before telling customers anything.`,
      action_url: "/dashboard/mass-incidents",
    });
  } catch (e) {
    logErr("mass_incident_notify_failed", e, { incident_id: incidentId });
  }
}

// ---------------------------------------------------------------------------
// Live guidance for the voice assistant (tool: check_area_incident)
// ---------------------------------------------------------------------------

export interface GuidanceRequest {
  userId: string;
  address?: string | null;
  postalCode?: string | null;
  symptomText: string;
  vapiCallId?: string | null;
  callerPhone?: string | null;
  brandName?: string | null;
}

interface TriageEvaluation {
  triage: TriageResult;
  incident: IncidentForTriage | null;
  entry: DirectoryEntry | null;
  country: string;
  postal: string | null;
  safetyHold: boolean;
}

async function evaluateTriage(admin: Admin, userId: string, a: { postal: string | null; symptomText: string }): Promise<TriageEvaluation> {
  const regional = await loadRegional(admin, userId);
  const country = regional.country || "US";
  const centroid = a.postal ? await resolvePostalCentroid(admin, country, a.postal) : null;
  const safety = screenSafety([a.symptomText]);
  const open = await loadOpenIncidents(admin, userId);
  const triage = triageContact(
    { symptomText: a.symptomText, hazards: safety.reasons, isEmergency: safety.hold, postalCode: a.postal, lat: centroid?.lat ?? null, lng: centroid?.lng ?? null },
    open.map(toTriageIncident),
  );
  const row = triage.incidentId ? open.find((o) => o.id === triage.incidentId) ?? null : null;
  const incident = row ? toTriageIncident(row) : null;
  let entry: DirectoryEntry | null = null;
  if (incident && triage.decision === "upstream_likely") {
    const service = CAUSE_TO_SERVICE[incident.cause];
    if (service) entry = pickDirectoryEntry(await loadDirectory(admin, userId, country), { country, region: await tenantRegion(admin, userId), postalCode: a.postal, service, userId }, new Date());
  }
  return { triage, incident, entry, country, postal: a.postal, safetyHold: safety.hold };
}

export async function getAreaGuidance(admin: Admin, req: GuidanceRequest): Promise<string> {
  const normal = "No area-wide incident information applies. Continue the normal flow and book the visit.";
  try {
    const settings = await loadIncidentSettings(admin, req.userId);
    if (!settings) return normal;
    const text = String(req.symptomText ?? "").slice(0, 600);
    const postal = normalizePostal(req.postalCode) ?? extractPostal(req.address) ?? extractPostal(text);
    const ev = await evaluateTriage(admin, req.userId, { postal, symptomText: text });

    // Count this contact (idempotent with the end-of-call ingest, which uses the same source_ref).
    if (req.vapiCallId) {
      await ingestIncidentContact(admin, {
        userId: req.userId, source: "call", sourceRef: req.vapiCallId, phone: req.callerPhone ?? null, address: req.address ?? null,
        postalCode: postal, symptomText: text, isEmergency: ev.safetyHold, triageDecision: ev.triage.decision,
      });
    }
    return buildGuidance({ triage: ev.triage, incident: ev.incident, country: ev.country, directoryEntry: ev.entry, brandName: req.brandName?.trim() || "our team" });
  } catch (e) {
    logErr("mass_incident_guidance_failed", e, { user_id: req.userId });
    return normal; // never block the call; the normal flow is always safe
  }
}

// ---------------------------------------------------------------------------
// SMS: count the text and (only if the owner opted in) send ONE hedged reply
// ---------------------------------------------------------------------------

/**
 * Returns true ONLY when this function already answered the customer, so sms-webhook skips its generic auto-reply
 * for that message (no double reply). Never throws.
 */
export async function handleIncidentSms(admin: Admin, a: { userId: string; sourceRef: string; phone: string; body: string; brandName?: string | null }): Promise<boolean> {
  try {
    const settings = await loadIncidentSettings(admin, a.userId);
    if (!settings) return false;
    const text = a.body.slice(0, 600);
    let postal = extractPostal(text);
    if (!postal) {
      const { data: job } = await admin.from("jobs").select("address").eq("user_id", a.userId).eq("customer_phone", a.phone).order("created_at", { ascending: false }).limit(1).maybeSingle();
      postal = extractPostal((job as { address?: string | null } | null)?.address ?? null);
    }
    const ev = await evaluateTriage(admin, a.userId, { postal, symptomText: text });
    const res = await ingestIncidentContact(admin, {
      userId: a.userId, source: "sms", sourceRef: a.sourceRef, phone: a.phone, postalCode: postal, symptomText: text, isEmergency: ev.safetyHold, triageDecision: ev.triage.decision,
    });
    if (!settings.autoReplySms || ev.triage.decision !== "upstream_likely" || !ev.incident || res.status === "error") return false;

    // One automatic reply per caller per incident: a later text from the same person gets the normal flow.
    const { count } = await admin.from("mass_incident_contacts").select("id", { count: "exact", head: true })
      .eq("user_id", a.userId).eq("incident_id", ev.incident.id).eq("source", "sms").eq("contact_phone", a.phone);
    if ((count ?? 0) > 1) return false;

    const reply = buildSmsAutoReplyText({ brandName: a.brandName?.trim() || "Your service team", cause: ev.incident.cause, causeStatus: ev.incident.causeStatus, directoryEntry: ev.entry });
    const sent = await sendCompliantSms(admin, a.userId, a.phone, reply, { purpose: "service", source: "mass_incident_auto_reply", dedupeKey: `mass-auto:${ev.incident.id}:${a.phone}` });
    if (sent.ok) {
      await admin.from("mass_incident_events").insert({ user_id: a.userId, incident_id: ev.incident.id, kind: "sms_auto_reply", detail: { deferred: sent.deferred === true } });
    }
    return sent.ok;
  } catch (e) {
    logErr("mass_incident_sms_failed", e, { user_id: a.userId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Booking: tell the dispatcher, and link the job (informational only — never blocks or reassigns a booking)
// ---------------------------------------------------------------------------

export async function getBookingIncidentNote(admin: Admin, userId: string, vapiCallId: string | null): Promise<string | null> {
  if (!vapiCallId) return null;
  try {
    const { data: c } = await admin.from("mass_incident_contacts").select("incident_id, triage_decision").eq("user_id", userId).eq("source", "call").eq("source_ref", vapiCallId).maybeSingle();
    const row = c as { incident_id: string | null; triage_decision: string | null } | null;
    if (!row || row.triage_decision !== "upstream_likely" || !row.incident_id) return null;
    const { data: i } = await admin.from("mass_incidents").select("title, status").eq("id", row.incident_id).eq("user_id", userId).maybeSingle();
    const inc = i as { title: string; status: IncidentStatus } | null;
    return inc && (inc.status === "active" || inc.status === "monitoring") ? buildBookingNote(inc.title) : null;
  } catch {
    return null;
  }
}

export async function linkJobToIncidentContact(admin: Admin, userId: string, vapiCallId: string | null, jobId: string): Promise<void> {
  if (!vapiCallId) return;
  try {
    await admin.rpc("mass_incident_link_job", { p_user_id: userId, p_source: "call", p_source_ref: vapiCallId, p_job_id: jobId });
  } catch (e) {
    logErr("mass_incident_link_job_failed", e, { job_id: jobId });
  }
}

/** Static context appended to the existing `service_area_context` prompt variable ("" when nothing is active). */
export async function buildIncidentVoiceContext(admin: Admin, userId: string): Promise<string> {
  try {
    const settings = await loadIncidentSettings(admin, userId);
    if (!settings) return "";
    const { count } = await admin.from("mass_incidents").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", ["active", "monitoring"]).gte("confidence", LIMITS.informCallersMinConfidence);
    if (!count) return "";
    return (
      "AREA INCIDENT MODE: the business may currently be seeing an area-wide event (storm, outage or main break). " +
      "After you know the caller's ZIP or address and what is wrong, call check_area_incident BEFORE booking and follow its instructions exactly. " +
      "Never mention an area incident unless that tool returns one, never state a cause as fact, never invent a utility phone number, and never refuse a booking. " +
      "Gas smell, smoke, sparks, flooding, carbon monoxide or a medically vulnerable person are ALWAYS emergencies: use flag_emergency_call, not this tool."
    );
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Sweep (cron): inactivity lifecycle, signal expiry, directory staleness
// ---------------------------------------------------------------------------

const NWS_UA = "Vireek Dashboard (mass-incident, support@vireek.com)";
const GEOCODE_BATCH = 15;
const GEOCODE_GAP_MS = 1100; // Nominatim policy: max 1 request per second

interface NwsAlert { id?: string; event?: string; headline?: string; areaDesc?: string; onset?: string; effective?: string; expires?: string; ends?: string }

async function fetchNwsAlerts(lat: number, lng: number): Promise<NwsAlert[]> {
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`, {
      headers: { "User-Agent": NWS_UA, Accept: "application/geo+json" }, signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return ((data?.features ?? []) as Array<{ properties?: NwsAlert }>).map((f) => f.properties ?? {}).filter((p) => p.id && p.event);
  } catch (e) {
    logErr("mass_incident_nws_failed", e);
    return [];
  }
}

/** Official evidence for tenants that have an open incident, independent of the surge automation. */
async function pollOfficialAlerts(admin: Admin, userId: string, open: IncidentRow[]): Promise<number> {
  const target = open[0];
  if (!target) return 0;
  const since = new Date(Date.now() - 9 * 60_000).toISOString();
  const { count } = await admin.from("mass_incident_signals").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("source", "nws").gte("created_at", since);
  if ((count ?? 0) > 0) return 0;
  const regional = await loadRegional(admin, userId);
  const zip = target.scope.postalCodes[0] ?? null;
  const point = target.scope.center
    ? { lat: target.scope.center[0], lng: target.scope.center[1] }
    : zip ? await resolvePostalCentroid(admin, regional.country || "US", zip) : null;
  if (!point) return 0;
  const alerts = await fetchNwsAlerts(point.lat, point.lng);
  for (const a of alerts) {
    await recordWeatherSignal(admin, {
      userId, alertId: String(a.id), event: String(a.event), headline: a.headline ?? null, areaDesc: a.areaDesc ?? null, zip: zip ?? "",
      lat: point.lat, lng: point.lng, effectiveAt: a.onset ?? a.effective ?? null, expiresAt: a.ends ?? a.expires ?? null,
    });
  }
  return 1;
}

/** Background street-level geocoding (1 request/second). The address is erased as soon as it has been used or given up on. */
async function geocodeQueue(admin: Admin, enabled: Set<string>): Promise<Map<string, string[]>> {
  const done = new Map<string, string[]>();
  const { data } = await admin.from("mass_incident_contacts").select("id, user_id, address_text, geocode_attempts")
    .not("address_text", "is", null).neq("geo_precision", "address").lt("geocode_attempts", 3)
    .gte("contact_at", new Date(Date.now() - 48 * 3_600_000).toISOString()).order("contact_at", { ascending: false }).limit(GEOCODE_BATCH);
  let first = true;
  for (const r of (data ?? []) as Array<{ id: string; user_id: string; address_text: string; geocode_attempts: number }>) {
    if (!enabled.has(r.user_id)) continue;
    if (!first) await new Promise((res) => setTimeout(res, GEOCODE_GAP_MS));
    first = false;
    try {
      const point = looksGeocodable(r.address_text) ? await geocodeAddress(r.address_text) : null;
      if (point) {
        const { error } = await admin.rpc("mass_incident_set_geo", { p_user_id: r.user_id, p_contact_id: r.id, p_lat: point.lat, p_lng: point.lng });
        if (error) throw error;
        done.set(r.user_id, [...(done.get(r.user_id) ?? []), r.id]);
      } else {
        const attempts = r.geocode_attempts + 1;
        await admin.from("mass_incident_contacts").update({ geocode_attempts: attempts, address_text: attempts >= 3 ? null : r.address_text }).eq("id", r.id);
      }
    } catch (e) {
      logErr("mass_incident_geocode_failed", e, { contact_id: r.id });
    }
  }
  return done;
}

export async function sweepIncidents(admin: Admin, now = new Date()): Promise<{ tenants: number; updated: number; geocoded: number; nwsPolled: number; directoryMarkedStale: number }> {
  let updated = 0;
  let nwsPolled = 0;
  const { data: tenants } = await admin.from("mass_incident_settings").select("user_id").eq("enabled", true).limit(2000);
  const enabled = new Set(((tenants ?? []) as Array<{ user_id: string }>).map((t) => t.user_id));
  const geocoded = await geocodeQueue(admin, enabled);

  for (const userId of enabled) {
    try {
      const settings = await loadIncidentSettings(admin, userId);
      if (!settings) continue;
      const openRows = await loadOpenIncidents(admin, userId);
      nwsPolled += await pollOfficialAlerts(admin, userId, openRows);
      for (const id of geocoded.get(userId) ?? []) await reclusterContact(admin, userId, settings, id);
      const signals = await loadSignals(admin, userId, now);
      for (const inc of await loadOpenIncidents(admin, userId)) {
        const { data: m } = await admin.from("mass_incident_contacts").select(CONTACT_COLS).eq("incident_id", inc.id).limit(500);
        const members = ((m ?? []) as ContactRow[]).map(toContact);
        const calm = members.filter((c) => !c.isEmergency && c.hazards.length === 0);
        const scope = computeScope(calm.length ? calm : members);
        const cause = inferCause(calm.length ? calm : members, signals, now, inc.owner_confirmed_cause);
        const score = scoreIncident(members, scope, cause, settings.params);
        const status = nextStatusByInactivity(inc.status, inc.last_contact_at, now, settings.params.windowMinutes);
        const changed = status !== inc.status || Math.abs(score.value - Number(inc.confidence)) > 0.02 || cause.status !== inc.cause_status;
        if (!changed) continue;
        const { error } = await admin.rpc("mass_incident_apply_update", {
          p_user_id: userId, p_incident_id: inc.id, p_event: status !== inc.status ? `status_${status}_auto` : "rescored",
          p_fields: {
            status, confidence: score.value, confidence_breakdown: score, scope, suspected_cause: cause.cause, cause_status: cause.status,
            cause_confidence: cause.confidence, cause_uncertainty: cause.uncertainty, cause_basis: cause.basis, alternatives: cause.alternatives, corroborated_by: cause.corroboratedBy,
          },
        });
        if (error) throw error;
        updated++;
      }
    } catch (e) {
      logErr("mass_incident_sweep_tenant_failed", e, { user_id: userId });
    }
  }
  const cutoff = new Date(now.getTime() - LIMITS.directoryStaleDays * 86_400_000).toISOString();
  const { data: stale } = await admin.from("mass_incident_directory").update({ status: "stale", updated_at: now.toISOString() }).eq("status", "verified").lt("verified_at", cutoff).select("id");
  return { tenants: enabled.size, updated, geocoded: [...geocoded.values()].reduce((n, a) => n + a.length, 0), nwsPolled, directoryMarkedStale: (stale ?? []).length };
}

// ---------------------------------------------------------------------------
// Owner-triggered broadcast to the callers of one incident
// ---------------------------------------------------------------------------

export interface BroadcastResult { eligible: number; sent: number; deferred: number; skipped: number; preview: string }

export async function broadcastToIncident(
  admin: Admin,
  args: { userId: string; incidentId: string; kind: "update" | "resolved"; actorId: string | null; dryRun: boolean; brandName?: string | null },
): Promise<BroadcastResult | { error: string }> {
  const { data: inc } = await admin.from("mass_incidents").select("id, status, suspected_cause, cause_status, confidence, scope").eq("id", args.incidentId).eq("user_id", args.userId).maybeSingle();
  if (!inc) return { error: "incident_not_found" };
  const row = inc as { suspected_cause: SuspectedCause; cause_status: "suspected" | "corroborated" | "owner_confirmed"; status: IncidentStatus; confidence: number };
  if (args.kind === "update" && Number(row.confidence) < LIMITS.informCallersMinConfidence) return { error: "confidence_too_low_to_message_customers" };
  const regional = await loadRegional(admin, args.userId);
  const service = CAUSE_TO_SERVICE[row.suspected_cause];
  const entry = service && args.kind === "update"
    ? pickDirectoryEntry(await loadDirectory(admin, args.userId, regional.country || "US"), { country: regional.country || "US", region: await tenantRegion(admin, args.userId), postalCode: null, service, userId: args.userId }, new Date())
    : null;
  const preview = buildBroadcastText({ brandName: args.brandName?.trim() || "Your service team", cause: row.suspected_cause, causeStatus: row.cause_status, directoryEntry: entry, kind: args.kind });

  const { data: members } = await admin.from("mass_incident_contacts").select("id, contact_phone, is_emergency, customer_id, detached")
    .eq("incident_id", args.incidentId).eq("user_id", args.userId).not("contact_phone", "is", null).limit(1000);
  const phones = new Map<string, string | null>();
  for (const m of (members ?? []) as Array<{ contact_phone: string; is_emergency: boolean; customer_id: string | null }>) {
    if (!m.is_emergency && /^\+[1-9]\d{6,14}$/.test(m.contact_phone) && !phones.has(m.contact_phone)) phones.set(m.contact_phone, m.customer_id);
  }
  if (args.dryRun) return { eligible: phones.size, sent: 0, deferred: 0, skipped: 0, preview };

  let sent = 0, deferred = 0, skipped = 0;
  for (const [phone, customerId] of phones) {
    const r = await sendCompliantSms(admin, args.userId, phone, preview, {
      purpose: "service", customerId, source: "mass_incident", dedupeKey: `mass:${args.incidentId}:${args.kind}:${phone}`,
    });
    if (!r.ok) skipped++;
    else if (r.deferred) deferred++;
    else sent++;
  }
  await admin.from("mass_incident_events").insert({
    user_id: args.userId, incident_id: args.incidentId, kind: `broadcast_${args.kind}`, actor: args.actorId, detail: { eligible: phones.size, sent, deferred, skipped },
  });
  return { eligible: phones.size, sent, deferred, skipped, preview };
}

export const NWS_EVENT_CORROBORATES: Array<{ re: RegExp; causes: SuspectedCause[] }> = [
  { re: /(flood|flash flood)/i, causes: ["severe_weather", "sewer_main_issue", "water_supply_issue"] },
  { re: /(heat|excessive heat)/i, causes: ["extreme_temperature", "power_grid_outage"] },
  { re: /(freeze|frost|cold|winter|ice|blizzard|snow)/i, causes: ["extreme_temperature", "severe_weather", "power_grid_outage"] },
  { re: /(wind|thunderstorm|tornado|hurricane|tropical|storm)/i, causes: ["severe_weather", "power_grid_outage"] },
];

/** Records an NWS alert as VERIFIED external evidence (called from weather-surge-check). Never throws. */
export async function recordWeatherSignal(
  admin: Admin,
  a: { userId: string; alertId: string; event: string; headline: string | null; areaDesc: string | null; zip: string; lat: number; lng: number; effectiveAt: string | null; expiresAt: string | null },
): Promise<void> {
  try {
    const causes = NWS_EVENT_CORROBORATES.find((x) => x.re.test(a.event))?.causes ?? [];
    await admin.from("mass_incident_signals").upsert({
      user_id: a.userId, kind: "weather_alert", source: "nws", external_id: a.alertId, headline: (a.headline ?? a.event).slice(0, 300),
      area_desc: a.areaDesc?.slice(0, 500) ?? null, postal_codes: [a.zip], lat: a.lat, lng: a.lng, radius_miles: 25, corroborates: causes,
      verified: true, effective_at: a.effectiveAt, expires_at: a.expiresAt,
    }, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
  } catch (e) {
    logErr("mass_incident_weather_signal_failed", e, { user_id: a.userId });
  }
}
