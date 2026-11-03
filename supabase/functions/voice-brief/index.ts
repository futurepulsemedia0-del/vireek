// supabase/functions/voice-brief/index.ts
//
// Audio Morning Brief. Built from real measured data only (calls, bookings, overdue invoices, expiring quotes,
// today's schedule, NWS weather alerts, on-call) -> deterministic script (<=150 words, _shared/voice/briefScript.ts)
// -> ElevenLabs audio (Sarah's voice or the owner's cloned voice) -> stored privately -> delivered by
// in-app player, web push (text only + deep link), email (transcript + 24h audio link) and WhatsApp (audio message).
//
//   cron : POST {"mode":"cron"} with header `x-briefing-secret: $BRIEFING_CRON_SECRET` (hourly, dispatch_voice_briefs()).
//   self : POST with the user's `Authorization: Bearer <jwt>` and {"mode":"get"|"preview"|"sample", ...}.
//
// Deploy:  supabase functions deploy voice-brief --no-verify-jwt     (auth is enforced in code, like daily-briefing)
// Secrets: BRIEFING_CRON_SECRET (already set for daily-briefing), ELEVENLABS_API_KEY, SARAH_VOICE_ID,
//          VAPID_* + SITE_URL (already set), RESEND_API_KEY (email), WHATSAPP_BRIEF_TEMPLATE (optional, see runbook).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { getFeatureGate } from "../_shared/ai-transparency/gate.ts";
import { DAY_MS, invoiceTotalCents } from "../../../src/lib/changesSinceYesterday.ts";
import { canSeeBilling, DEFAULT_TIMEZONE, localDayBoundsUtc, localParts, type BriefingRole } from "../../../src/lib/dailyBriefing.ts";
import { composeBriefScript, dueNow, LANGS, pushText, type BriefFacts, type Lang, type WeatherKind } from "../_shared/voice/briefScript.ts";
import { constantTimeEqualSafe, sha256Hex } from "../_shared/voice/callSafety.ts";
import { synthesize, ttsCostCents } from "../_shared/voice/tts.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-briefing-secret, apikey, x-client-info",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Admin = SupabaseClient;
const BUCKET = "voice-briefs";
const TIME_BUDGET_MS = 110_000;
const CONCURRENCY = 4;
const INACTIVE_JOB = ["completed", "cancelled", "no_show"];

interface Pref {
  user_id: string; account_owner_id: string; brief_enabled: boolean; send_hour: number; timezone: string | null;
  quiet_start: number; quiet_end: number; skip_when_quiet: boolean; language: string; voice_choice: "sarah" | "custom"; speed: number;
  channel_push: boolean; channel_whatsapp: boolean; channel_email: boolean; channel_in_app: boolean;
  whatsapp_number: string | null; daily_cost_cap_cents: number; last_brief_on: string | null;
}
interface Who { role: BriefingRole; canSeeMoney: boolean; name: string | null; email: string | null; company: string | null }
type Delivered = Record<string, { ok: boolean; detail?: string }>;

async function load<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[] | null> {
  try { const { data, error } = await q; return error || !Array.isArray(data) ? null : (data as T[]); } catch { return null; }
}
const firstName = (s: string | null) => (s ?? "").trim().split(/\s+/)[0] || null;
const asLang = (s: string): Lang => ((LANGS as readonly string[]).includes(s) ? (s as Lang) : "en");

// ------------------------------------------------------------------ who
async function resolveWho(admin: Admin, p: Pref): Promise<Who | null> {
  if (p.user_id === p.account_owner_id) {
    const { data } = await admin.from("profiles").select("full_name,email,company_name").eq("id", p.account_owner_id).maybeSingle();
    return { role: "owner", canSeeMoney: true, name: firstName(data?.full_name ?? null), email: data?.email ?? null, company: data?.company_name ?? null };
  }
  const { data: m } = await admin.from("team_members").select("role,permissions,member_name,member_email")
    .eq("user_id", p.user_id).eq("account_owner_id", p.account_owner_id).eq("invite_status", "active").maybeSingle();
  if (!m) return null;   // removed / pending members never get briefs
  const role = (m.role ?? "member") as BriefingRole;
  return { role, canSeeMoney: canSeeBilling(role, m.permissions), name: firstName(m.member_name), email: m.member_email ?? null, company: null };
}

// ------------------------------------------------------------------ weather (NWS, same source as weather-surge-check)
const KIND_RULES: [RegExp, WeatherKind][] = [
  [/tornado|thunderstorm|storm|hurricane|tropical/i, "storm"], [/flood/i, "flood"], [/heat/i, "heat"],
  [/freeze|frost|cold|chill/i, "cold"], [/snow|blizzard|winter|ice/i, "snow"], [/wind/i, "wind"], [/rain/i, "rain"],
];
async function weatherRisk(zip: string | null): Promise<BriefFacts["weather"]> {
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  try {
    const ua = { "User-Agent": "Vireek Dashboard (voice-brief, support@vireek.com)" };
    const g = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: AbortSignal.timeout(6000) });
    if (!g.ok) return null;
    const place = (await g.json())?.places?.[0];
    const lat = Number(place?.latitude), lon = Number(place?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: ua, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const events = ((await r.json())?.features ?? []).map((f: { properties?: { event?: string } }) => String(f?.properties?.event ?? "")).filter(Boolean);
    if (events.length === 0) return { risk: "none", kind: "storm" };
    const severe = events.find((e: string) => /warning/i.test(e));
    const pick: string = severe ?? events[0];
    const kind = KIND_RULES.find(([rx]) => rx.test(pick))?.[1];
    return kind ? { risk: severe ? "severe" : "watch", kind } : null;   // unknown event type: say nothing rather than guess
  } catch { return null; }
}

// ------------------------------------------------------------------ facts (every query is explicitly tenant-filtered)
async function loadFacts(admin: Admin, p: Pref, who: Who, tz: string, lang: Lang, now: number): Promise<BriefFacts> {
  const owner = p.account_owner_id;
  const day = localDayBoundsUtc(now, tz);
  const yStart = localDayBoundsUtc(day.start - 3_600_000, tz).start;
  const today = localParts(day.start + 12 * 3_600_000, tz).date;
  const plus3 = localParts(day.start + 12 * 3_600_000 + 3 * DAY_MS, tz).date;
  const iso = (ms: number) => new Date(ms).toISOString();

  const [calls, jobsToday, overdue, quotes, profile, bookings, schedules] = await Promise.all([
    load<{ id: string; call_datetime: string; status: string | null; is_emergency: boolean | null }>(
      admin.from("calls").select("id,call_datetime,status,is_emergency").eq("user_id", owner).gte("call_datetime", iso(Math.min(yStart, now - DAY_MS))).limit(2000)),
    load<{ scheduled_datetime: string | null; job_status: string; assigned_technician_id: string | null }>(
      admin.from("jobs").select("scheduled_datetime,job_status,assigned_technician_id").eq("user_id", owner).gte("scheduled_datetime", iso(day.start)).lt("scheduled_datetime", iso(day.end)).limit(500)),
    who.canSeeMoney ? load<{ line_items: never; tax_percent: number | null }>(
      admin.from("invoices").select("line_items,tax_percent").eq("user_id", owner).in("status", ["sent", "viewed"]).is("paid_at", null).lt("due_date", today).limit(1000)) : Promise.resolve(null),
    who.canSeeMoney ? load<{ line_items: never; tax_percent: number | null }>(
      admin.from("quotes").select("line_items,tax_percent").eq("user_id", owner).eq("status", "sent").gte("valid_until", today).lte("valid_until", plus3).limit(500)) : Promise.resolve(null),
    load<{ weather_zip_code: string | null }>(admin.from("business_profile").select("weather_zip_code").eq("user_id", owner).limit(1)),
    admin.from("jobs").select("id", { count: "exact", head: true }).eq("user_id", owner).gte("created_at", iso(yStart)).lt("created_at", iso(day.start)),
    load<{ id: string }>(admin.from("on_call_schedules").select("id").eq("user_id", owner).eq("is_active", true).limit(1)),
  ]);

  let callFacts: BriefFacts["calls"] = null;
  if (calls) {
    const yday = calls.filter((c) => c.status !== "spam" && Date.parse(c.call_datetime) >= yStart && Date.parse(c.call_datetime) < day.start);
    const emerg = calls.filter((c) => c.is_emergency && Date.parse(c.call_datetime) >= now - DAY_MS);
    const missed = yday.filter((c) => c.status === "missed").length;
    if (emerg.length === 0) {
      callFacts = { total: yday.length, missed, emergencies: 0, emergenciesUnhandled: 0 };
    } else {
      const withJob = await load<{ call_id: string }>(admin.from("jobs").select("call_id").eq("user_id", owner).in("call_id", emerg.map((c) => c.id)));
      if (withJob) {   // if the lookup failed we say nothing about calls rather than guess
        const handled = new Set(withJob.map((x) => x.call_id));
        callFacts = { total: yday.length, missed, emergencies: emerg.length, emergenciesUnhandled: emerg.filter((c) => !handled.has(c.id)).length };
      }
    }
  }

  const active = jobsToday?.filter((j) => !INACTIVE_JOB.includes(j.job_status)) ?? null;
  const first = active?.map((j) => j.scheduled_datetime).filter(Boolean).sort()[0] ?? null;
  const fmt = new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone: tz });
  const sum = (rows: { line_items: never; tax_percent: number | null }[] | null) => rows ? { count: rows.length, cents: rows.reduce((s, r) => s + invoiceTotalCents(r), 0) } : null;

  let onCall: string | null = null;
  if (schedules?.[0]) {
    const { data: memberId } = await admin.rpc("get_current_on_call", { p_schedule_id: schedules[0].id });   // id came from the owner-scoped query above
    if (memberId) {
      const { data: m } = await admin.from("team_members").select("member_name").eq("id", memberId as string).eq("account_owner_id", owner).maybeSingle();
      onCall = firstName(m?.member_name ?? null);
    }
  }

  return {
    date: today,
    ownerName: who.name,
    calls: callFacts,
    bookings: bookings.error ? null : { created: bookings.count ?? 0 },
    overdue: sum(overdue),
    expiringQuotes: sum(quotes),
    schedule: active ? { jobs: active.length, unassigned: active.filter((j) => !j.assigned_technician_id).length, firstAt: first ? fmt.format(new Date(first)) : null } : null,
    weather: await weatherRisk(profile?.[0]?.weather_zip_code ?? null),
    onCall,
    canSeeMoney: who.canSeeMoney,
  };
}

// ------------------------------------------------------------------ voice + audio
async function resolveVoice(admin: Admin, p: Pref): Promise<{ key: "sarah" | "custom"; id: string }> {
  const sarah = Deno.env.get("SARAH_VOICE_ID") ?? "";
  if (p.voice_choice === "custom") {
    const { data } = await admin.from("business_profile").select("custom_voice_id,custom_voice_status").eq("user_id", p.account_owner_id).maybeSingle();
    if (data?.custom_voice_id && data.custom_voice_status === "ready") {
      const gate = await getFeatureGate(admin, p.account_owner_id, "ai_voice_cloning");
      if (gate.allowed) return { key: "custom", id: data.custom_voice_id };
    }
  }
  return { key: "sarah", id: sarah };
}
const signed = async (admin: Admin, path: string, ttl: number) => (await admin.storage.from(BUCKET).createSignedUrl(path, ttl)).data?.signedUrl ?? null;

interface BriefRow {
  id: string; brief_date: string; language: string; voice_key: string; status: string; skip_reason: string | null; script: string | null;
  word_count: number | null; evidence: unknown; script_hash: string | null; audio_path: string | null; audio_seconds: number | null;
  tts_chars: number; cost_cents: number; cache_hit: boolean; delivered: Delivered;
}

async function buildBrief(admin: Admin, p: Pref, who: Who, now: number, mode: "cron" | "preview"): Promise<{ row: BriefRow | null; skipped?: string }> {
  const tz = p.timezone || await ownerTz(admin, p.account_owner_id);
  const lang = asLang(p.language);
  const voice = await resolveVoice(admin, p);
  const local = localParts(now, tz);
  const key = { user_id: p.user_id, brief_date: local.date, language: lang, voice_key: voice.key };

  const { data: existing } = await admin.from("voice_briefs").select("*").match(key).maybeSingle();
  if (mode === "cron" && existing) return { row: existing.status === "skipped" ? null : (existing as BriefRow), skipped: existing.status === "skipped" ? existing.skip_reason ?? "skipped" : undefined };

  const facts = await loadFacts(admin, p, who, tz, lang, now);
  const out = composeBriefScript(facts, lang);
  if (mode === "cron" && p.skip_when_quiet && !out.notable) {
    await admin.from("voice_briefs").upsert({ ...key, account_owner_id: p.account_owner_id, status: "skipped", skip_reason: "nothing_notable" }, { onConflict: "user_id,brief_date,language,voice_key" });
    return { row: null, skipped: "nothing_notable" };
  }

  const hash = await sha256Hex(`${voice.id}|${lang}|${out.script}`);
  if (existing && existing.script_hash === hash && existing.audio_path) {
    return { row: { ...(existing as BriefRow), cache_hit: true, cost_cents: 0 } };   // same words, same voice: reuse, cost 0
  }

  // Daily cost cap (cache hits above are free and never reach this point).
  const est = ttsCostCents(out.script.length);
  const { data: spent } = await admin.rpc("voice_spend_since", { p_owner: p.account_owner_id, p_since: new Date(localDayBoundsUtc(now, tz).start).toISOString() });
  const capped = Number(spent ?? 0) + est > p.daily_cost_cap_cents;

  let audioPath: string | null = null, seconds: number | null = null, cost = 0, ttsNote = capped ? "daily cost cap reached" : "";
  if (!capped) {
    const tts = await synthesize(out.script, voice.id);
    if (tts.ok) {
      const path = `${p.account_owner_id}/${p.user_id}/${local.date}-${hash.slice(0, 16)}.mp3`;
      const up = await admin.storage.from(BUCKET).upload(path, tts.audio, { contentType: "audio/mpeg", upsert: true });
      if (up.error) ttsNote = "audio upload failed"; else { audioPath = path; seconds = tts.seconds; cost = tts.costCents; }
    } else ttsNote = tts.error === "not_configured" ? "voice is not configured" : "voice provider unavailable";
  }
  const delivered: Delivered = { ...(existing?.delivered ?? {}), ...(audioPath ? {} : { tts: { ok: false, detail: ttsNote } }) };
  const { data: row, error } = await admin.from("voice_briefs").upsert({
    ...key, account_owner_id: p.account_owner_id, status: "generated", skip_reason: null, script: out.script, word_count: out.wordCount,
    evidence: out.evidence, script_hash: hash, audio_path: audioPath, audio_seconds: seconds, tts_chars: audioPath ? out.script.length : 0,
    cost_cents: cost, cache_hit: false, delivered,
  }, { onConflict: "user_id,brief_date,language,voice_key" }).select("*").single();
  if (error) throw error;
  if (existing?.audio_path && existing.audio_path !== audioPath) await admin.storage.from(BUCKET).remove([existing.audio_path]);   // tidy superseded audio
  return { row: row as BriefRow };
}

async function ownerTz(admin: Admin, owner: string): Promise<string> {
  const { data } = await admin.from("briefing_preferences").select("timezone").eq("account_owner_id", owner).is("team_member_id", null).maybeSingle();
  return data?.timezone || DEFAULT_TIMEZONE;
}

// ------------------------------------------------------------------ delivery
let vapid: boolean | null = null;
function initVapid(): boolean {
  if (vapid !== null) return vapid;
  const a = Deno.env.get("VAPID_PUBLIC_KEY"), b = Deno.env.get("VAPID_PRIVATE_KEY"), c = Deno.env.get("VAPID_SUBJECT");
  vapid = Boolean(a && b && c);
  if (vapid) webpush.setVapidDetails(c!, a!, b!);
  return vapid;
}
async function deliverPush(admin: Admin, p: Pref, lang: Lang): Promise<{ ok: boolean; detail?: string }> {
  if (!initVapid()) return { ok: true, detail: "skipped: push not configured" };
  const filter = p.user_id === p.account_owner_id ? `subscriber_id.eq.${p.user_id},and(subscriber_id.is.null,user_id.eq.${p.account_owner_id})` : `subscriber_id.eq.${p.user_id}`;
  const { data: subs, error } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth_key").or(filter);
  if (error) return { ok: false, detail: "subscription lookup failed" };
  if (!subs?.length) return { ok: true, detail: "skipped: no devices" };
  const t = pushText(lang);
  const body = JSON.stringify({ title: t.title, body: t.body, url: "/dashboard/settings/voice", tag: "voice-brief" });   // lock-screen safe: no numbers
  let sent = 0;
  await Promise.all(subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth_key: string }) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, body); sent++; }
    catch (e) { const c = (e as { statusCode?: number })?.statusCode; if (c === 404 || c === 410) await admin.from("push_subscriptions").delete().eq("id", s.id); }
  }));
  return { ok: sent > 0, detail: `sent ${sent}/${subs.length}` };
}
async function deliverEmail(admin: Admin, who: Who, row: BriefRow): Promise<{ ok: boolean; detail?: string }> {
  if (!who.email) return { ok: true, detail: "skipped: no email address" };
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const url = row.audio_path ? await signed(admin, row.audio_path, 24 * 3600) : null;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const html = `<p>${esc(row.script ?? "")}</p>${url ? `<p><a href="${url}">Listen to your brief</a> (link works for 24 hours)</p>` : ""}<p><a href="${site}/dashboard/settings/voice">Open in Vireek</a></p><p style="color:#666;font-size:12px">Voice generated by AI.</p>`;
  const r = await sendEmail(who.email, "Your Vireek morning brief", html, `${row.script}\n\n${url ? `Listen: ${url}\n` : ""}Open in Vireek: ${site}/dashboard/settings/voice\nVoice generated by AI.`);
  return r.ok ? { ok: true } : { ok: false, detail: (r.error ?? "email failed").slice(0, 160) };
}
async function deliverWhatsapp(admin: Admin, p: Pref, row: BriefRow, lang: Lang): Promise<{ ok: boolean; detail?: string }> {
  if (!p.whatsapp_number) return { ok: true, detail: "skipped: no WhatsApp number" };
  const { data: conn } = await admin.from("dm_channel_connections").select("external_account_id,access_token")
    .eq("user_id", p.account_owner_id).eq("channel", "whatsapp").eq("status", "connected").maybeSingle();
  if (!conn) return { ok: false, detail: "WhatsApp is not connected" };
  const to = p.whatsapp_number.replace(/\D/g, "");
  const url = row.audio_path ? await signed(admin, row.audio_path, 3600) : null;
  const send = (payload: Record<string, unknown>) => fetch(`https://graph.facebook.com/v20.0/${conn.external_account_id}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${conn.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }), signal: AbortSignal.timeout(15_000),
  });
  if (url) {
    const r = await send({ type: "audio", audio: { link: url } });
    if (r.ok) return { ok: true };
    const err = await r.text();
    if (!err.includes("131047") && !/re-?engagement/i.test(err)) return { ok: false, detail: `whatsapp ${r.status}` };
  }
  // Outside the 24h window (or no audio): only an approved template can start the conversation.
  const tpl = Deno.env.get("WHATSAPP_BRIEF_TEMPLATE");
  if (!tpl) return { ok: false, detail: "needs an approved template (outside the 24h window)" };
  const r2 = await send({ type: "template", template: { name: tpl, language: { code: lang } } });
  return r2.ok ? { ok: true, detail: "template sent" } : { ok: false, detail: `whatsapp template ${r2.status}` };
}

async function deliver(admin: Admin, p: Pref, who: Who, row: BriefRow, lang: Lang): Promise<boolean> {
  const d: Delivered = { ...(row.delivered ?? {}) };
  const jobs: Promise<void>[] = [];
  if (p.channel_in_app && !d.in_app?.ok) d.in_app = { ok: true };
  if (p.channel_push && !d.push?.ok) jobs.push(deliverPush(admin, p, lang).then((r) => void (d.push = r)));
  if (p.channel_email && !d.email?.ok) jobs.push(deliverEmail(admin, who, row).then((r) => void (d.email = r)));
  if (p.channel_whatsapp && !d.whatsapp?.ok) jobs.push(deliverWhatsapp(admin, p, row, lang).then((r) => void (d.whatsapp = r)));
  await Promise.all(jobs);
  await admin.from("voice_briefs").update({ delivered: d }).eq("id", row.id);
  const wanted = (["push", "email", "whatsapp"] as const).filter((c) => p[`channel_${c}` as keyof Pref]);
  return wanted.every((c) => d[c]?.ok);   // retried by the next hourly tick (same content, only failed channels)
}

// ------------------------------------------------------------------ http
const SAMPLE: Record<Lang, string> = {
  en: "Hi, this is Sarah from Vireek. This is how your morning brief will sound.",
  es: "Hola, soy Sarah de Vireek. Así sonará su resumen de cada mañana.",
  fr: "Bonjour, ici Sarah de Vireek. Voici comment sonnera votre point du matin.",
};

const view = async (admin: Admin, row: BriefRow | null) => row ? {
  brief: { id: row.id, date: row.brief_date, status: row.status, language: row.language, voice: row.voice_key, script: row.script, wordCount: row.word_count,
           evidence: row.evidence, audioSeconds: row.audio_seconds, costCents: Number(row.cost_cents), cacheHit: row.cache_hit, delivered: row.delivered },
  audioUrl: row.audio_path ? await signed(admin, row.audio_path, 3600) : null,
} : { brief: null, audioUrl: null };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), secret = Deno.env.get("BRIEFING_CRON_SECRET");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = Date.now();
  let body: { mode?: string; voice_choice?: string; language?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine for cron */ }

  // ---------------- cron
  const provided = req.headers.get("x-briefing-secret");
  if (provided) {
    if (!secret || !constantTimeEqualSafe(provided, secret)) return json({ error: "Unauthorized" }, 401);
    const { data: all, error } = await admin.from("voice_preferences").select("*").eq("brief_enabled", true).limit(5000);
    if (error) return json({ error: "Failed to load preferences" }, 500);
    const owners = [...new Set((all ?? []).map((p: Pref) => p.account_owner_id))];
    const { data: tzRows } = owners.length ? await admin.from("briefing_preferences").select("account_owner_id,timezone").in("account_owner_id", owners).is("team_member_id", null) : { data: [] };
    const tzByOwner = new Map((tzRows ?? []).map((r: { account_owner_id: string; timezone: string }) => [r.account_owner_id, r.timezone]));
    const due = ((all ?? []) as Pref[]).filter((p) => {
      const tz = p.timezone || tzByOwner.get(p.account_owner_id) || DEFAULT_TIMEZONE;
      return dueNow({ sendHour: p.send_hour, quietStart: p.quiet_start, quietEnd: p.quiet_end, lastBriefOn: p.last_brief_on }, localParts(now, tz)).due;
    });
    const totals = { due: due.length, delivered: 0, skipped: 0, retryLater: 0, deferred: 0 };
    const queue = [...due];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        if (Date.now() - now > TIME_BUDGET_MS) { totals.deferred++; continue; }
        try {
          const who = await resolveWho(admin, p);
          if (!who) { totals.skipped++; continue; }
          const { row, skipped } = await buildBrief(admin, p, who, now, "cron");
          const tz = p.timezone || tzByOwner.get(p.account_owner_id) || DEFAULT_TIMEZONE;
          if (!row) { totals.skipped++; if (skipped) await admin.from("voice_preferences").update({ last_brief_on: localParts(now, tz).date }).eq("user_id", p.user_id); continue; }
          const ok = await deliver(admin, p, who, row, asLang(p.language));
          if (ok) { totals.delivered++; await admin.from("voice_preferences").update({ last_brief_on: localParts(now, tz).date }).eq("user_id", p.user_id); } else totals.retryLater++;
        } catch (e) { totals.retryLater++; console.error(JSON.stringify({ event: "voice_brief_failed", user: p.user_id, error: String(e) })); }
      }
    }));
    console.log(JSON.stringify({ event: "voice_brief_run", ...totals }));
    return json({ ok: true, ...totals });
  }

  // ---------------- self (signed-in user)
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "Unauthorized" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(bearer);
  if (uerr || !u?.user) return json({ error: "Unauthorized" }, 401);
  const { data: pref } = await admin.from("voice_preferences").select("*").eq("user_id", u.user.id).maybeSingle();
  if (!pref) return json({ error: "Save your voice settings first." }, 404);
  const p = pref as Pref;
  const who = await resolveWho(admin, p);
  if (!who) return json({ error: "You don't have access to briefs for this account." }, 403);

  const mode = body.mode ?? "get";
  if (mode === "get") {
    const { data: row } = await admin.from("voice_briefs").select("*").eq("user_id", p.user_id).eq("status", "generated").order("created_at", { ascending: false }).limit(1).maybeSingle();
    return json(await view(admin, (row as BriefRow) ?? null));
  }
  if (mode === "preview" || mode === "sample") {
    const { data: ok } = await admin.rpc("voice_consume_rate_limit", { p_key: `brief:${mode}:${p.user_id}`, p_max: mode === "preview" ? 6 : 10, p_window_seconds: 3600 });
    if (ok === false) return json({ error: "You've reached the hourly limit for tests. Try again later." }, 429);
  }
  if (mode === "preview") {
    try { return json(await view(admin, (await buildBrief(admin, p, who, now, "preview")).row)); }
    catch (e) { console.error(JSON.stringify({ event: "voice_preview_failed", error: String(e) })); return json({ error: "We couldn't build your brief. Please try again." }, 500); }
  }
  if (mode === "sample") {
    const lang = asLang(body.language ?? p.language);
    const voice = await resolveVoice(admin, { ...p, voice_choice: body.voice_choice === "custom" ? "custom" : "sarah" });
    const hash = await sha256Hex(`${voice.id}|${lang}|${SAMPLE[lang]}`);
    const path = `${p.account_owner_id}/${p.user_id}/sample-${hash.slice(0, 16)}.mp3`;
    let u2 = await signed(admin, path, 3600);
    if (!u2) {
      const t = await synthesize(SAMPLE[lang], voice.id);
      if (!t.ok) return json({ error: "The sample voice isn't available right now. Your text brief still works." }, 503);
      const up = await admin.storage.from(BUCKET).upload(path, t.audio, { contentType: "audio/mpeg", upsert: true });
      if (up.error) return json({ error: "We couldn't save the sample. Please try again." }, 500);
      u2 = await signed(admin, path, 3600);
    }
    return json({ audioUrl: u2, voice: voice.key, transcript: SAMPLE[lang] });
  }
  return json({ error: "Unknown mode" }, 400);
});
