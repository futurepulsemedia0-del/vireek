// supabase/functions/win-cards/index.ts
//
// Owner-side API for Win Cards. POST { action, ... } with the signed-in user's JWT.
// Authorisation: caller must pass public.identity_is_manager(); every query is scoped to
// public.get_account_owner_id() on top of the service-role client, and every write is audited.
//
// Actions: list | scan | preview | approve | revoke | dismiss | extend | share | chat_targets | post_chat | get_settings | update_settings
//
// DEPLOYMENT: supabase functions deploy win-cards            (verify_jwt stays ON)
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SITE_URL, WIN_CARD_HASH_SALT

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendToRoute } from "../_shared/chat-notify/delivery.ts";
import type { MessageModel } from "../_shared/chat-notify/events.ts";
import { suggestCaptions } from "../_shared/win-cards/captions.ts";
import { buildPublicFields, cleanText, RedactionError } from "../_shared/win-cards/redact.ts";
import { renderCardSvg } from "../_shared/win-cards/render.ts";
import { attributionRef, generateToken } from "../_shared/win-cards/token.ts";
import {
  detectAfterHoursBooking, detectEmergencyHandled, detectFiveStarAiJob, detectMilestone, detectRecoveredLargeJob,
  findSpeedRecords, type Candidate, type CallRow, type RecoveryRow, type ReviewRequestRow, type SpeedRow,
} from "../_shared/win-cards/triggers.ts";
import { DEFAULT_CARD_SETTINGS, DEFAULT_SELECTION, type CardSettings, type PrivateFacts, type Selection, type Theme } from "../_shared/win-cards/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DAILY_APPROVAL_LIMIT = 20;
const SCAN_WINDOW_DAYS = 30;
const MAX_NEW_PER_SCAN = 25;

const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
const adminClient = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message?: string) { super(message ?? code); this.status = status; this.code = code; }
}

interface Ctx { admin: SupabaseClient; ownerId: string; actorId: string }
interface SettingsRow {
  enabled: boolean; staff_locked: boolean; default_expiry_days: number; theme: Theme; show_business_name: boolean;
  white_label: boolean; brand_name: string | null; accent_color: string | null; show_cta: boolean;
  business_hours_start: number; business_hours_end: number; timezone: string; large_job_threshold_cents: number;
}
const DEFAULT_ROW: SettingsRow = {
  enabled: true, staff_locked: false, default_expiry_days: 30, theme: "light", show_business_name: true, white_label: false,
  brand_name: null, accent_color: null, show_cta: true, business_hours_start: 8, business_hours_end: 18,
  timezone: DEFAULT_CARD_SETTINGS.timezone, large_job_threshold_cents: DEFAULT_CARD_SETTINGS.largeJobThresholdCents,
};

async function authenticate(req: Request): Promise<Ctx> {
  const auth = req.headers.get("Authorization");
  if (!auth) throw new HttpError(401, "UNAUTHENTICATED");
  const userClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) throw new HttpError(401, "UNAUTHENTICATED");
  const { data: allowed } = await userClient.rpc("identity_is_manager");
  if (allowed !== true) throw new HttpError(403, "FORBIDDEN");
  const { data: ownerId } = await userClient.rpc("get_account_owner_id");
  if (typeof ownerId !== "string" || !UUID_RE.test(ownerId)) throw new HttpError(403, "FORBIDDEN");
  return { admin: adminClient(), ownerId, actorId: u.user.id };
}

async function loadSettings(c: Ctx): Promise<SettingsRow> {
  const { data } = await c.admin.from("win_card_settings").select("*").eq("user_id", c.ownerId).maybeSingle();
  return { ...DEFAULT_ROW, ...((data as Partial<SettingsRow> | null) ?? {}) };
}
const toCardSettings = (s: SettingsRow): CardSettings => ({
  timezone: s.timezone, businessHoursStart: s.business_hours_start, businessHoursEnd: s.business_hours_end, largeJobThresholdCents: s.large_job_threshold_cents,
});
function assertEnabled(s: SettingsRow) {
  if (!s.enabled || s.staff_locked) throw new HttpError(403, "DISABLED", s.staff_locked ? "Win Cards are locked for this account." : "Win Cards are turned off for this account.");
}

async function audit(c: Ctx, action: string, targetId: string | null, meta: Record<string, unknown> = {}) {
  // Metadata is deliberately PII-free: ids, statuses, trigger names, counts only.
  const { error } = await c.admin.rpc("log_audit_event", {
    p_user_id: c.ownerId, p_action: action, p_target_table: "win_cards", p_target_id: targetId, p_metadata: { actor_id: c.actorId, ...meta },
  });
  if (error) console.error(JSON.stringify({ event: "win_card_audit_failed", action, error: error.message }));
}

// ------------------------------------------------------------------ input parsing

function parseSelection(raw: unknown, s: SettingsRow): Selection {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const b = (k: string, d: boolean) => (typeof r[k] === "boolean" ? (r[k] as boolean) : d);
  const t = (k: string, max: number) => (typeof r[k] === "string" ? cleanText(r[k] as string, max) || null : null);
  return {
    showValue: b("showValue", DEFAULT_SELECTION.showValue),
    showTimeBucket: b("showTimeBucket", DEFAULT_SELECTION.showTimeBucket),
    showMonth: b("showMonth", DEFAULT_SELECTION.showMonth),
    showBusinessName: s.show_business_name && b("showBusinessName", DEFAULT_SELECTION.showBusinessName),
    showCta: s.show_cta && b("showCta", true),
    serviceLabel: t("serviceLabel", 40),
    caption: t("caption", 280),
  };
}
const asUuid = (v: unknown) => { if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, "INVALID_ID"); return v; };
const asTheme = (v: unknown, d: Theme): Theme => (v === "light" || v === "dark" ? v : d);

async function loadCard(c: Ctx, id: string) {
  const { data } = await c.admin.from("win_cards").select("*").eq("id", id).eq("user_id", c.ownerId).maybeSingle();
  if (!data) throw new HttpError(404, "NOT_FOUND");
  return data as Record<string, unknown> & { id: string; status: string; private_facts: PrivateFacts; trigger_type: string; token: string | null; theme: Theme };
}
async function businessName(c: Ctx): Promise<string | null> {
  const { data } = await c.admin.from("profiles").select("company_name").eq("id", c.ownerId).maybeSingle();
  return (data as { company_name: string | null } | null)?.company_name ?? null;
}

function buildOrThrow(facts: PrivateFacts, sel: Selection, s: SettingsRow, biz: string | null) {
  try {
    return buildPublicFields({ facts, selection: sel, settings: { timezone: s.timezone, businessHoursStart: s.business_hours_start, businessHoursEnd: s.business_hours_end }, businessName: biz });
  } catch (e) {
    if (e instanceof RedactionError) {
      // Report the KINDS of problem, never the offending text.
      const kinds = [...new Set(e.findings.map((f) => f.kind))];
      throw new HttpError(422, e.message === "HYPE_REJECTED" ? "HYPE_REJECTED" : "REDACTION_FAILED", `Not published: ${kinds.join(", ")}.`);
    }
    throw e;
  }
}

// ------------------------------------------------------------------ actions

async function actList(c: Ctx) {
  const settings = await loadSettings(c);
  const { data, error } = await c.admin.from("win_cards")
    .select("id,trigger_type,status,private_facts,public_fields,theme,token,attribution_ref,expires_at,approved_at,revoked_at,suspended_at,view_count,cta_count,share_count,report_count,created_at")
    .eq("user_id", c.ownerId).order("created_at", { ascending: false }).limit(60);
  if (error) throw new HttpError(500, "INTERNAL");
  return { settings, cards: data ?? [], siteUrl: siteUrl() };
}

async function actScan(c: Ctx) {
  const settings = await loadSettings(c);
  assertEnabled(settings);
  const cs = toCardSettings(settings);
  const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 86_400_000).toISOString();
  const found: Candidate[] = [];

  // 1) after-hours + emergency (booked calls) — job value only when a real invoice exists
  const { data: calls } = await c.admin.from("calls")
    .select("id,call_datetime,is_emergency,status,booking_outcome,caller_name,caller_phone")
    .eq("user_id", c.ownerId).eq("booking_outcome", "booked").gte("call_datetime", since).order("call_datetime", { ascending: false }).limit(200);
  const callRows = (calls ?? []) as CallRow[];
  const jobByCall = new Map<string, { invoice_amount: number | null }>();
  if (callRows.length) {
    const { data: jobs } = await c.admin.from("jobs").select("call_id,invoice_amount").eq("user_id", c.ownerId).in("call_id", callRows.map((r) => r.id));
    for (const j of (jobs ?? []) as { call_id: string; invoice_amount: number | null }[]) if (j.call_id) jobByCall.set(j.call_id, { invoice_amount: j.invoice_amount });
  }
  for (const call of callRows) {
    const job = jobByCall.get(call.id) ?? null;
    const cand = detectEmergencyHandled(call, job) ?? detectAfterHoursBooking(call, cs, job);
    if (cand) found.push(cand);
  }

  // 2) recovered large jobs (ledger — real collected amounts)
  const { data: rec } = await c.admin.from("revenue_recovery_events")
    .select("id,source_type,status,recovered_amount_cents,occurred_at,customer_name,customer_phone")
    .eq("user_id", c.ownerId).eq("status", "recovered").gte("recovered_amount_cents", cs.largeJobThresholdCents)
    .order("occurred_at", { ascending: false }).limit(100);
  for (const ev of (rec ?? []) as RecoveryRow[]) { const cand = detectRecoveredLargeJob(ev, cs); if (cand) found.push(cand); }

  // 3) milestone (answered calls = all calls that are not 'missed')
  const { count } = await c.admin.from("calls").select("id", { count: "exact", head: true }).eq("user_id", c.ownerId).neq("status", "missed");
  const { data: mk } = await c.admin.from("win_cards").select("dedupe_key").eq("user_id", c.ownerId).like("dedupe_key", "milestone:%");
  const existing = new Set<number>(((mk ?? []) as { dedupe_key: string }[]).map((r) => Number(r.dedupe_key.split(":")[1])).filter(Number.isFinite));
  const m = detectMilestone(count ?? 0, existing, new Date().toISOString());
  if (m) found.push(m);

  // 4) speed-to-lead records (strictly better than all earlier attempts, ≥20 history)
  const { data: sp } = await c.admin.from("speed_to_lead_requests")
    .select("id,time_to_first_dial_ms,sla_met,received_at,first_name,full_name,phone_e164")
    .eq("account_owner_id", c.ownerId).not("time_to_first_dial_ms", "is", null).order("received_at", { ascending: true }).limit(2000);
  found.push(...findSpeedRecords((sp ?? []) as SpeedRow[], since));

  // 5) 5-star review → job → booked call
  const { data: rr } = await c.admin.from("review_requests")
    .select("id,job_id,rating,status,completed_at,customer_name,customer_phone")
    .eq("user_id", c.ownerId).eq("status", "completed").eq("rating", 5).gte("completed_at", since).limit(100);
  const rrRows = (rr ?? []) as (ReviewRequestRow & { job_id: string | null })[];
  const jobIds = rrRows.map((r) => r.job_id).filter((x): x is string => !!x);
  const outcomeByJob = new Map<string, string | null>();
  if (jobIds.length) {
    const { data: jobs } = await c.admin.from("jobs").select("id,call_id").eq("user_id", c.ownerId).in("id", jobIds);
    const callIds = ((jobs ?? []) as { id: string; call_id: string | null }[]).map((j) => j.call_id).filter((x): x is string => !!x);
    const { data: cs2 } = callIds.length ? await c.admin.from("calls").select("id,booking_outcome").eq("user_id", c.ownerId).in("id", callIds) : { data: [] };
    const oc = new Map(((cs2 ?? []) as { id: string; booking_outcome: string | null }[]).map((x) => [x.id, x.booking_outcome]));
    for (const j of (jobs ?? []) as { id: string; call_id: string | null }[]) outcomeByJob.set(j.id, j.call_id ? oc.get(j.call_id) ?? null : null);
  }
  for (const r of rrRows) {
    const cand = detectFiveStarAiJob(r, r.job_id && outcomeByJob.has(r.job_id) ? { call_booking_outcome: outcomeByJob.get(r.job_id) ?? null } : null);
    if (cand) found.push(cand);
  }

  // Idempotent insert: (user_id, dedupe_key) is UNIQUE, duplicates are ignored. A call can only ever yield one card.
  const rows = found.slice(0, MAX_NEW_PER_SCAN).map((f) => ({
    user_id: c.ownerId, trigger_type: f.trigger, source_table: f.sourceTable, source_id: f.sourceId, dedupe_key: f.dedupeKey, status: "suggested", private_facts: f.facts,
  }));
  let inserted = 0;
  if (rows.length) {
    const { data: ins, error } = await c.admin.from("win_cards").upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true }).select("id");
    if (error) throw new HttpError(500, "INTERNAL");
    inserted = ins?.length ?? 0;
  }
  if (inserted) await audit(c, "win_cards_scanned", null, { new_suggestions: inserted });
  return { inserted, candidates: found.length };
}

async function actPreview(c: Ctx, body: Record<string, unknown>) {
  const settings = await loadSettings(c);
  const card = await loadCard(c, asUuid(body.cardId));
  const sel = parseSelection(body.selection, settings);
  const pub = buildOrThrow(card.private_facts, sel, settings, await businessName(c));
  const theme = asTheme(body.theme, settings.theme);
  const o = { theme, whiteLabel: settings.white_label, brandName: settings.brand_name, accent: settings.accent_color, seed: "preview" } as const;
  return {
    public: pub,
    captions: suggestCaptions(pub),
    // These strings are rendered from `pub` ONLY — what you see is exactly what becomes public.
    previews: { og: renderCardSvg(pub, { ...o, format: "og" }), square: renderCardSvg(pub, { ...o, format: "square" }), story: renderCardSvg(pub, { ...o, format: "story" }) },
  };
}

async function actApprove(c: Ctx, body: Record<string, unknown>) {
  const settings = await loadSettings(c);
  assertEnabled(settings);
  const card = await loadCard(c, asUuid(body.cardId));
  if (card.status === "approved") return { card, alreadyApproved: true, url: `${siteUrl()}/win/${card.token}` };
  if (card.status !== "suggested") throw new HttpError(409, "INVALID_STATE");
  const sel = parseSelection(body.selection, settings);
  const pub = buildOrThrow(card.private_facts, sel, settings, await businessName(c)); // server-side rebuild: never trust client output
  const days = typeof body.expiryDays === "number" && Number.isInteger(body.expiryDays) ? body.expiryDays : settings.default_expiry_days;
  if (days < 1 || days > 90) throw new HttpError(400, "INVALID_EXPIRY");
  const theme = asTheme(body.theme, settings.theme);
  const token = generateToken();
  const ref = await attributionRef(card.id, Deno.env.get("WIN_CARD_HASH_SALT") ?? "");
  const { data, error } = await c.admin.rpc("win_card_approve", {
    p_card_id: card.id, p_user_id: c.ownerId, p_actor: c.actorId, p_public_fields: pub, p_theme: theme,
    p_expiry_days: days, p_token: token, p_ref: ref, p_daily_limit: DAILY_APPROVAL_LIMIT,
  });
  if (error) {
    const m = error.message ?? "";
    if (m.includes("RATE_LIMITED")) throw new HttpError(429, "RATE_LIMITED", `Limit of ${DAILY_APPROVAL_LIMIT} approved cards per 24 hours reached.`);
    if (m.includes("NOT_FOUND")) throw new HttpError(404, "NOT_FOUND");
    if (m.includes("INVALID_STATE")) throw new HttpError(409, "INVALID_STATE");
    console.error(JSON.stringify({ event: "win_card_approve_failed", error: m }));
    throw new HttpError(500, "INTERNAL");
  }
  const row = data as { id: string; token: string; trigger_type: string; expires_at: string };
  await audit(c, "win_card_approved", row.id, { trigger: row.trigger_type, expires_at: row.expires_at, fields_shown: Object.entries(sel).filter(([k, v]) => k.startsWith("show") && v).map(([k]) => k) });
  return { card: data, alreadyApproved: false, url: `${siteUrl()}/win/${row.token}` };
}

async function actRevoke(c: Ctx, body: Record<string, unknown>) {
  const id = asUuid(body.cardId);
  const { data, error } = await c.admin.from("win_cards")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: c.actorId })
    .eq("id", id).eq("user_id", c.ownerId).in("status", ["approved", "suspended"]).select("id,trigger_type").maybeSingle();
  if (error) throw new HttpError(500, "INTERNAL");
  if (!data) { const card = await loadCard(c, id); if (card.status === "revoked") return { ok: true, already: true }; throw new HttpError(409, "INVALID_STATE"); }
  await audit(c, "win_card_revoked", id, { trigger: (data as { trigger_type: string }).trigger_type });
  return { ok: true };
}

async function actDismiss(c: Ctx, body: Record<string, unknown>) {
  const id = asUuid(body.cardId);
  const { data } = await c.admin.from("win_cards").update({ status: "dismissed" }).eq("id", id).eq("user_id", c.ownerId).eq("status", "suggested").select("id").maybeSingle();
  if (!data) { const card = await loadCard(c, id); if (card.status === "dismissed") return { ok: true, already: true }; throw new HttpError(409, "INVALID_STATE"); }
  await audit(c, "win_card_dismissed", id);
  return { ok: true };
}

async function actExtend(c: Ctx, body: Record<string, unknown>) {
  const settings = await loadSettings(c); assertEnabled(settings);
  const id = asUuid(body.cardId);
  const days = body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, "INVALID_EXPIRY");
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  const { data } = await c.admin.from("win_cards").update({ expires_at: expires }).eq("id", id).eq("user_id", c.ownerId).eq("status", "approved").select("id").maybeSingle();
  if (!data) throw new HttpError(409, "INVALID_STATE");
  await audit(c, "win_card_extended", id, { expires_at: expires });
  return { ok: true, expiresAt: expires };
}

async function actShare(c: Ctx, body: Record<string, unknown>) {
  const id = asUuid(body.cardId);
  const channel = typeof body.channel === "string" && /^[a-z_]{2,20}$/.test(body.channel) ? body.channel : "other";
  const card = await loadCard(c, id);
  if (card.status !== "approved") throw new HttpError(409, "INVALID_STATE");
  // Best-effort counter (a lost update under a race is harmless, same trade-off as job_summaries.view_count).
  await c.admin.from("win_cards").update({ share_count: ((card as { share_count?: number }).share_count ?? 0) + 1 }).eq("id", id).eq("user_id", c.ownerId);
  await audit(c, "win_card_shared", id, { channel });
  return { ok: true };
}

async function actUpdateSettings(c: Ctx, body: Record<string, unknown>) {
  const r = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { user_id: c.ownerId };
  const bool = (k: string) => { if (k in r) { if (typeof r[k] !== "boolean") throw new HttpError(400, "INVALID_SETTING"); patch[k] = r[k]; } };
  const int = (k: string, lo: number, hi: number) => { if (k in r) { const v = r[k]; if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, "INVALID_SETTING"); patch[k] = v; } };
  bool("enabled"); bool("show_business_name"); bool("white_label"); bool("show_cta");
  int("default_expiry_days", 1, 90); int("business_hours_start", 0, 23); int("business_hours_end", 1, 24); int("large_job_threshold_cents", 50_000, 100_000_000);
  if ("theme" in r) { if (r.theme !== "light" && r.theme !== "dark") throw new HttpError(400, "INVALID_SETTING"); patch.theme = r.theme; }
  if ("brand_name" in r) { patch.brand_name = r.brand_name === null || r.brand_name === "" ? null : cleanText(String(r.brand_name), 60) || null; }
  if ("accent_color" in r) { if (r.accent_color !== null && !(typeof r.accent_color === "string" && HEX_RE.test(r.accent_color))) throw new HttpError(400, "INVALID_SETTING"); patch.accent_color = r.accent_color; }
  if ("timezone" in r) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(r.timezone) }); } catch { throw new HttpError(400, "INVALID_SETTING"); }
    patch.timezone = r.timezone;
  }
  // staff_locked is intentionally NOT writable here — only Vireek staff (service role / SQL) can set it.
  const { data, error } = await c.admin.from("win_card_settings").upsert(patch, { onConflict: "user_id" }).select("*").single();
  if (error) throw new HttpError(error.code === "23514" || error.code === "22023" ? 400 : 500, error.code === "23514" || error.code === "22023" ? "INVALID_SETTING" : "INTERNAL");
  await audit(c, "win_card_settings_changed", null, { keys: Object.keys(patch).filter((k) => k !== "user_id"), enabled: (data as SettingsRow).enabled });
  return { settings: data };
}

// ------------------------------------------------------------------ internal Slack / Teams post
// Reuses the account's EXISTING chat connection + channel list (chat_connections / chat_channels) and the existing
// sendToRoute() delivery code. The message is built from public_fields only, so chat gets exactly what the card shows.

async function actChatTargets(c: Ctx) {
  const { data: conns } = await c.admin.from("chat_connections").select("id,provider,external_name,status").eq("user_id", c.ownerId).eq("status", "connected");
  const out: { connectionId: string; provider: string; workspace: string | null; channels: { id: string; name: string }[] }[] = [];
  for (const conn of (conns ?? []) as { id: string; provider: string; external_name: string | null }[]) {
    const { data: chans } = await c.admin.from("chat_channels").select("channel_id,channel_name").eq("connection_id", conn.id).order("channel_name").limit(200);
    out.push({ connectionId: conn.id, provider: conn.provider, workspace: conn.external_name, channels: ((chans ?? []) as { channel_id: string; channel_name: string }[]).map((x) => ({ id: x.channel_id, name: x.channel_name })) });
  }
  return { targets: out };
}

async function actPostChat(c: Ctx, body: Record<string, unknown>) {
  const settings = await loadSettings(c); assertEnabled(settings);
  const card = await loadCard(c, asUuid(body.cardId));
  const pub = (card as { public_fields: import("../_shared/win-cards/types.ts").PublicFields | null }).public_fields;
  const expires = (card as { expires_at: string | null }).expires_at;
  if (card.status !== "approved" || !pub || !card.token || !expires || new Date(expires) <= new Date()) throw new HttpError(409, "INVALID_STATE");
  const connectionId = asUuid(body.connectionId);
  const channelId = typeof body.channelId === "string" && body.channelId.length > 0 && body.channelId.length <= 200 ? body.channelId : null;
  if (!channelId) throw new HttpError(400, "INVALID_CHANNEL");
  // Ownership + channel allow-list: the connection must be this account's, and the channel one Vireek already knows about.
  const { data: conn } = await c.admin.from("chat_connections").select("*").eq("id", connectionId).eq("user_id", c.ownerId).eq("status", "connected").maybeSingle();
  if (!conn) throw new HttpError(404, "CONNECTION_NOT_FOUND");
  const { data: ch } = await c.admin.from("chat_channels").select("channel_id").eq("connection_id", connectionId).eq("channel_id", channelId).maybeSingle();
  if (!ch) throw new HttpError(404, "CHANNEL_NOT_FOUND");

  const url = `${siteUrl()}/win/${card.token}`;
  const fields = [pub.valueText, pub.timeBucketText, pub.serviceText].filter((v): v is string => !!v).map((v, i) => ({ label: ["Value", "When", "Service"][i] ?? "Detail", value: v }));
  const model: MessageModel = {
    eventId: card.id, eventType: "job_completed", emoji: "🏆", severity: "success",
    title: pub.headline, summary: [pub.detail, pub.caption].filter(Boolean).join("\n"), fields,
    link: { label: "View card", url }, status: null, actions: [], technicians: [],
  };
  const result = await sendToRoute(c.admin, { channel_id: channelId }, conn, model).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!result.ok) throw new HttpError(502, "CHAT_POST_FAILED", String((result as { error?: string }).error ?? "Could not post to chat.").slice(0, 300));
  await audit(c, "win_card_posted_to_chat", card.id, { provider: (conn as { provider: string }).provider });
  return { ok: true };
}

// ------------------------------------------------------------------ entry

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const c = await authenticate(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "list": return json(await actList(c));
      case "scan": return json(await actScan(c));
      case "preview": return json(await actPreview(c, body));
      case "approve": return json(await actApprove(c, body));
      case "revoke": return json(await actRevoke(c, body));
      case "dismiss": return json(await actDismiss(c, body));
      case "extend": return json(await actExtend(c, body));
      case "share": return json(await actShare(c, body));
      case "chat_targets": return json(await actChatTargets(c));
      case "post_chat": return json(await actPostChat(c, body));
      case "get_settings": return json({ settings: await loadSettings(c) });
      case "update_settings": return json(await actUpdateSettings(c, body));
      default: return json({ error: "UNKNOWN_ACTION" }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, detail: e.message }, e.status);
    console.error(JSON.stringify({ event: "win_cards_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
