// supabase/functions/capacity-guard-tick/index.ts
//
// Cron-driven orchestrator for Capacity Guard.
//   ?phase=backfill  every minute      -> offers freed slots (SMS, time-limited claim link)
//   ?phase=holds     every 15 minutes  -> places / releases value holds, releases campaign holds, reconciles consumed holds
// Auth: header X-Cron-Secret must equal CAPACITY_GUARD_CRON_SECRET (fails CLOSED if the secret is not configured).
// Deploy: supabase functions deploy capacity-guard-tick --no-verify-jwt
//
// Every outbound text goes through sendCompliantSms() (A2P + DNC + quiet hours). Shadow mode never sends.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadCapacityContext, buildRequest } from "../_shared/booking/capacityBooking.ts";
import { computeAvailability, formatSlotLocal, localDateKey } from "../_shared/booking/capacityEngine.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import { getPreferences, mayContact } from "../_shared/compliance/preferenceCheck.ts";
import {
  DAY_MS, campaignHoldsToRelease, campaignKeepFraction, checkEligibility, demandMultiplier, hashToken, newClaimToken, planValueHolds,
  rankCandidates, valueHoldsToRelease, type ActiveHold, type Candidate, type CandidateType, type FreeSlot, type TradeRule,
} from "../_shared/capacity-guard/engine.ts";

type Row = Record<string, unknown>;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
const log = (event: string, extra: Row = {}) => console.log(JSON.stringify({ event, ...extra }));

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CAPACITY_GUARD_CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const phase = new URL(req.url).searchParams.get("phase") ?? "all";
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: accounts, error } = await admin.from("capacity_guard_settings").select("*").eq("enabled", true).limit(500);
  if (error) return json({ error: error.message }, 500);

  const results: Row[] = [];
  for (const s of (accounts ?? []) as Row[]) {
    const userId = s.user_id as string;
    const out: Row = { user_id: userId };
    try {
      if (phase === "holds" || phase === "all") out.holds = await runHolds(admin, userId, s);
      if (phase === "backfill" || phase === "all") out.backfill = await runBackfill(admin, userId, s);
    } catch (e) {
      // One tenant failing must never stop the others.
      out.error = e instanceof Error ? e.message : String(e);
      log("capacity_guard_tick_failed", { user_id: userId, error: out.error });
    }
    results.push(out);
  }
  return json({ phase, accounts: results.length, results });
});

// ============================================================ holds
async function runHolds(admin: SupabaseClient, userId: string, s: Row): Promise<Row> {
  const now = Date.now();
  const rules = ((s.trade_rules as TradeRule[] | null) ?? []).filter((r) => r && typeof r.trade === "string");
  const loaded = await loadCapacityContext(admin, userId, now, { force: true });
  if (!loaded) return { skipped: "no_capacity_context" };
  const tz = loaded.ctx.timezone;
  const horizonMs = (s.hold_horizon_days as number) * DAY_MS;

  const { data: activeRows } = await admin.from("capacity_holds").select("id, kind, technician_id, trade, slot_start, slot_end, reservation_id")
    .eq("user_id", userId).eq("status", "active");
  const active: ActiveHold[] = ((activeRows ?? []) as Row[]).map((h) => ({
    id: h.id as string, kind: h.kind as "value" | "campaign", technicianId: h.technician_id as string, trade: (h.trade as string | null) ?? null,
    start: Date.parse(h.slot_start as string), end: Date.parse(h.slot_end as string), dayKey: localDateKey(Date.parse(h.slot_start as string), tz), reservationId: (h.reservation_id as string | null) ?? null,
  }));

  // 1) reconcile: an active hold overlapped by a real open job for the same technician was consumed by that job.
  let consumed = 0;
  for (const h of active) {
    const job = loaded.ctx.jobs.find((j) => j.technician_id === h.technicianId && j.start < h.end && j.end > h.start);
    if (job) { if ((await admin.rpc("capacity_guard_consume_hold", { p_user_id: userId, p_hold_id: h.id, p_job_id: job.id })).data === true) consumed += 1; }
  }
  const live = active.filter((h) => !loaded.ctx.jobs.some((j) => j.technician_id === h.technicianId && j.start < h.end && j.end > h.start));

  // 2) demand per trade (history) x weather/regional multiplier
  const since = new Date(now - 56 * DAY_MS).toISOString();
  const { data: hist } = await admin.from("jobs").select("service_type").eq("user_id", userId).gte("created_at", since).limit(5000);
  const { data: sig } = await admin.from("capacity_guard_signals").select("source, factor").eq("user_id", userId).gt("active_until", new Date(now).toISOString());
  const weather = ((sig ?? []) as Row[]).some((x) => x.source === "weather");
  const regional = ((sig ?? []) as Row[]).filter((x) => x.source === "regional").map((x) => Number(x.factor));
  const mult = demandMultiplier({ weatherSurge: weather, regionalSurgeFactor: regional.length ? Math.max(...regional) : null });
  const demandPerDay: Record<string, number> = {};
  for (const r of rules) {
    const t = r.trade.toLowerCase();
    const n = ((hist ?? []) as Row[]).filter((j) => { const st = String(j.service_type ?? "").toLowerCase(); return st.includes(t) || st.includes(t.replace(/_/g, " ")); }).length;
    demandPerDay[r.trade] = (n / 56) * mult;
  }

  // 3) place value holds (only when the owner defined at least one trade rule)
  let placed = 0;
  if (rules.length > 0) {
    const free: FreeSlot[] = [];
    for (const r of rules) {
      const req = await buildRequest(admin, userId, loaded, { serviceType: r.trade });
      const avail = computeAvailability(loaded.ctx, req, { maxOffered: 400 });
      for (const sl of avail.slots) {
        const st = Date.parse(sl.start);
        if (!sl.offered || !sl.technician_id || st > now + horizonMs) continue;
        free.push({ technicianId: sl.technician_id, start: st, end: Date.parse(sl.end), dayKey: localDateKey(st, tz), score: sl.score, trade: r.trade });
      }
    }
    const drafts = planValueHolds({ freeSlots: free, rules, globalSharePct: s.hold_share_pct as number, demandPerDay, now, minReleaseProbability: Number(s.min_release_probability), existing: live });
    if (drafts.length) {
      const { data } = await admin.rpc("capacity_guard_place_holds", {
        p_user_id: userId, p_kind: "value",
        p_holds: drafts.map((d) => ({ technician_id: d.technicianId, slot_start: new Date(d.start).toISOString(), slot_end: new Date(d.end).toISOString(), trade: d.trade, demand_probability: d.demandProbability })),
      });
      placed = Number(data ?? 0);
    }
  }

  // 4) release: value holds whose demand probability fell; campaign holds on shortfall / window end
  const releases = valueHoldsToRelease(live, demandPerDay, now, Number(s.min_release_probability));
  const { data: resRows } = await admin.from("capacity_campaign_reservations").select("*").eq("user_id", userId).eq("status", "active");
  for (const r of (resRows ?? []) as Row[]) {
    const ws = Date.parse(r.window_start as string), we = Date.parse(r.window_end as string);
    const observed = await observedResponses(admin, userId, r, ws, now);
    const curveShares = curveSharesFor(r);
    const k = campaignKeepFraction({ expectedResponses: Number(r.expected_responses), shares: curveShares, windowStart: ws, windowEnd: we, observed, graceMs: (s.campaign_release_grace_hours as number) * 3_600_000 }, now);
    const mine = live.filter((h) => h.reservationId === r.id);
    if (k.reason) releases.push(...campaignHoldsToRelease(mine, k.keep, k.reason, now));
    await admin.from("capacity_campaign_reservations").update({ observed_responses: observed, ...(k.reason === "campaign_window_over" ? { status: "completed", released_at: new Date().toISOString() } : {}) }).eq("id", r.id);
  }
  // campaign holds with no live reservation row logic left: past-slot holds are covered by campaignHoldsToRelease / valueHoldsToRelease
  const byReason = new Map<string, string[]>();
  for (const d of releases) byReason.set(d.reason, [...(byReason.get(d.reason) ?? []), d.id]);
  let released = 0;
  for (const [reason, ids] of byReason) released += Number((await admin.rpc("capacity_guard_release_holds", { p_user_id: userId, p_ids: ids, p_reason: reason })).data ?? 0);
  return { placed, released, consumed, shadow: s.mode === "shadow", multiplier: mult };
}

/** Responses = leads created in the window whose attribution touch names this campaign. NOT verified for direct mail (see notes). */
async function observedResponses(admin: SupabaseClient, userId: string, r: Row, from: number, now: number): Promise<number> {
  const { count } = await admin.from("marketing_attribution_touches").select("lead_id", { count: "exact", head: true })
    .eq("user_id", userId).eq("campaign", String(r.source_id)).not("lead_id", "is", null)
    .gte("occurred_at", new Date(from).toISOString()).lte("occurred_at", new Date(now).toISOString());
  return count ?? 0;
}

function curveSharesFor(r: Row): number[] {
  const v = Array.isArray(r.curve_shares) ? (r.curve_shares as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : [];
  return v.length ? v : [0.3, 0.25, 0.15, 0.1, 0.08, 0.06, 0.06];
}

// ============================================================ backfill
async function runBackfill(admin: SupabaseClient, userId: string, s: Row): Promise<Row> {
  const nowIso = new Date().toISOString();
  if (s.backfill_enabled !== true) return { skipped: "backfill_disabled" };
  // Expire stale offers and past gaps.
  await admin.from("backfill_offers").update({ status: "expired" }).eq("user_id", userId).eq("status", "sent").lte("expires_at", nowIso);
  await admin.from("backfill_gaps").update({ status: "expired" }).eq("user_id", userId).in("status", ["open", "offered"]).lte("slot_start", nowIso);

  const { data: gaps } = await admin.from("backfill_gaps").select("*").eq("user_id", userId).in("status", ["open", "offered"]).order("slot_start").limit(25);
  let sent = 0, blocked = 0;
  const shadow = s.mode === "shadow";
  for (const g of (gaps ?? []) as Row[]) {
    const { data: live } = await admin.from("backfill_offers").select("id").eq("gap_id", g.id).eq("status", "sent").gt("expires_at", nowIso).limit(1);
    if ((live ?? []).length > 0) continue; // a batch is still in its claim window
    const r = await offerBatch(admin, userId, s, g, shadow);
    sent += r.sent; blocked += r.blocked;
  }
  return { gaps: (gaps ?? []).length, sent, blocked, shadow };
}

async function offerBatch(admin: SupabaseClient, userId: string, s: Row, g: Row, shadow: boolean): Promise<{ sent: number; blocked: number }> {
  const { data: already } = await admin.from("backfill_offers").select("candidate_type, candidate_ref").eq("gap_id", g.id);
  const seen = new Set(((already ?? []) as Row[]).map((o) => `${o.candidate_type}:${o.candidate_ref}`));
  const cands = (await gatherCandidates(admin, userId, g)).filter((c) => !seen.has(`${c.type}:${c.ref}`));
  const ranked = rankCandidates(cands).slice(0, 40);
  const caps = { max24h: s.backfill_max_offers_per_customer_24h as number, max7d: s.backfill_max_offers_per_customer_7d as number };
  const ttlMs = (s.backfill_offer_ttl_minutes as number) * 60_000;
  const batch = s.backfill_batch_size as number;
  const { data: bp } = await admin.from("business_profile").select("*").eq("user_id", userId).maybeSingle();
  const tz = typeof (bp as Row | null)?.timezone === "string" ? String((bp as Row).timezone) : "UTC";
  const company = String((bp as Row | null)?.company_name ?? (bp as Row | null)?.business_name ?? "").trim();
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  let sent = 0, blocked = 0;

  for (const c of ranked) {
    if (sent >= batch) break;
    const base = {
      gap_id: g.id, user_id: userId, candidate_type: c.type, candidate_ref: c.ref, customer_id: c.customerId, customer_name: c.name.slice(0, 120),
      phone_norm: c.phoneNorm as string, rank: c.rank, score: c.score, est_value_cents: c.estValueCents,
    };
    const elig = checkEligibility(c, caps);
    if (!elig.ok) { blocked += 1; await admin.from("backfill_offers").upsert({ ...base, status: "blocked", blocked_reason: elig.reason }, { onConflict: "gap_id,candidate_type,candidate_ref", ignoreDuplicates: true }); continue; }
    if (shadow) { blocked += 1; await admin.from("backfill_offers").upsert({ ...base, status: "blocked", blocked_reason: "shadow_mode" }, { onConflict: "gap_id,candidate_type,candidate_ref", ignoreDuplicates: true }); continue; }

    const token = newClaimToken();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    // Insert FIRST (unique per gap+candidate = no double offer even if two ticks overlap); send second.
    const { data: ins, error } = await admin.from("backfill_offers").insert({ ...base, status: "queued", token_hash: await hashToken(token), expires_at: expiresAt }).select("id").maybeSingle();
    if (error || !ins) continue; // duplicate from a concurrent tick: the other tick owns it
    const when = formatSlotLocal(Date.parse(g.slot_start as string), tz);
    const first = c.name.split(" ")[0]?.slice(0, 30) || "there";
    const body = `Hi ${first}, ${company ? company + " has" : "we have"} an opening ${when}. First to confirm gets it (held ${s.backfill_offer_ttl_minutes} min): ${siteUrl}/claim/${token} Reply STOP to opt out.`;
    const res = await sendCompliantSms(admin, userId, c.phoneNorm as string, body, { purpose: elig.purpose, customerId: c.customerId, source: "capacity-guard-backfill", onQuiet: "caller", dedupeKey: `bf:${g.id}:${c.ref}` });
    if (res.ok) {
      await admin.from("backfill_offers").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ins.id);
      await admin.from("backfill_gaps").update({ status: "offered" }).eq("id", g.id).eq("status", "open");
      sent += 1;
    } else {
      blocked += 1;
      await admin.from("backfill_offers").update({ status: res.reason === "QUIET_HOURS" || res.reason === "OPTED_OUT" || res.reason === "A2P_NOT_APPROVED" ? "blocked" : "failed", blocked_reason: res.reason.toLowerCase(), token_hash: null }).eq("id", ins.id);
    }
  }
  return { sent, blocked };
}

// ------------------------------------------------------------ candidate sources (all scoped by user_id)
const km = (a: number, b: number, c: number, d: number) => {
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function gatherCandidates(admin: SupabaseClient, userId: string, g: Row): Promise<Candidate[]> {
  const now = Date.now();
  const sinceCalls = new Date(now - 3 * DAY_MS).toISOString();
  const [wl, qs, calls, mem, srcJob, custs, sent7] = await Promise.all([
    admin.from("capacity_waitlist_entries").select("id, customer_name, customer_phone, priority, created_at, service_type").eq("user_id", userId).eq("status", "waiting").limit(100),
    admin.from("quotes").select("id, customer_name, customer_phone, sent_at, valid_until, line_items").eq("user_id", userId).eq("status", "sent").not("customer_phone", "is", null).limit(100),
    admin.from("calls").select("id, caller_name, caller_phone, call_datetime, status, is_voicemail").eq("user_id", userId).gte("call_datetime", sinceCalls).not("caller_phone", "is", null).limit(100),
    admin.from("memberships").select("id, customer_name, customer_phone").eq("user_id", userId).eq("status", "active").not("customer_phone", "is", null).limit(200),
    admin.from("jobs").select("latitude, longitude").eq("id", g.source_job_id).eq("user_id", userId).maybeSingle(),
    admin.from("customers").select("id, name, phone, marketing_opt_in").eq("user_id", userId).is("deleted_at", null).not("phone", "is", null).limit(5000),
    admin.from("backfill_offers").select("phone_norm, sent_at").eq("user_id", userId).gte("sent_at", new Date(now - 7 * DAY_MS).toISOString()),
  ]);
  const byPhone = new Map<string, { id: string; optIn: boolean }>();
  for (const c of (custs.data ?? []) as Row[]) byPhone.set(normalizePhone(String(c.phone)), { id: c.id as string, optIn: c.marketing_opt_in === true });
  const sentRows = ((sent7.data ?? []) as Row[]).map((r) => ({ p: String(r.phone_norm), t: Date.parse(String(r.sent_at)) }));
  const counts = (p: string) => ({ d1: sentRows.filter((x) => x.p === p && x.t >= now - DAY_MS).length, d7: sentRows.filter((x) => x.p === p).length });
  const out: Candidate[] = [];
  const push = async (type: CandidateType, ref: string, name: string, rawPhone: string, value: number, ageDays: number, extra: Partial<Candidate> = {}) => {
    const phone = normalizePhone(rawPhone);
    if (!/^\+\d{10,15}$/.test(phone)) return;
    const cust = byPhone.get(phone) ?? null;
    const prefs = cust ? await getPreferences(admin, cust.id) : await getPreferences(admin, null);
    const cnt = counts(phone);
    out.push({
      type, ref, customerId: cust?.id ?? null, name: name || "there", phoneNorm: phone, estValueCents: Math.max(0, Math.round(value)), distanceKm: null, ageDays,
      marketingOptIn: cust?.optIn === true, prefsAllowSms: mayContact(prefs, "reminders", "sms").ok || (prefs !== "error" && prefs.sms),
      prefsAllowMarketing: mayContact(prefs, "marketing", "sms").ok, prefsAllowReminders: mayContact(prefs, "reminders", "sms").ok,
      sentLast24h: cnt.d1, sentLast7d: cnt.d7, ...extra,
    });
  };
  for (const w of (wl.data ?? []) as Row[]) {
    if (w.service_type && g.service_type && String(w.service_type).toLowerCase() !== String(g.service_type).toLowerCase()) continue;
    await push("waitlist", w.id as string, String(w.customer_name), String(w.customer_phone ?? ""), Number(g.est_value_cents ?? 0), (now - Date.parse(w.created_at as string)) / DAY_MS, { waitlistPriority: Number(w.priority ?? 0) });
  }
  for (const q of (qs.data ?? []) as Row[]) {
    if (q.valid_until && Date.parse(String(q.valid_until)) < now - DAY_MS) continue;
    const items = Array.isArray(q.line_items) ? (q.line_items as Row[]) : [];
    // line_items shape is not verified: sum whatever numeric total/price*qty is present; 0 is a valid (low-rank) fallback.
    const cents = items.reduce((a, i) => a + Math.round(100 * (Number(i.total) || (Number(i.price) || Number(i.unit_price) || 0) * (Number(i.quantity) || 1))), 0);
    await push("open_estimate", q.id as string, String(q.customer_name), String(q.customer_phone), cents, (now - Date.parse(String(q.sent_at ?? q.valid_until ?? new Date(now).toISOString()))) / DAY_MS);
  }
  const callPhones = ((calls.data ?? []) as Row[]).filter((c) => c.status === "missed" || c.is_voicemail === true);
  const { data: laterJobs } = callPhones.length ? await admin.from("jobs").select("customer_phone").eq("user_id", userId).gte("created_at", sinceCalls).not("customer_phone", "is", null).limit(1000) : { data: [] };
  const booked = new Set(((laterJobs ?? []) as Row[]).map((j) => normalizePhone(String(j.customer_phone))));
  for (const c of callPhones) {
    const p = normalizePhone(String(c.caller_phone));
    if (booked.has(p)) continue;
    await push("missed_call", c.id as string, String(c.caller_name ?? ""), String(c.caller_phone), Number(g.est_value_cents ?? 0), (now - Date.parse(c.call_datetime as string)) / DAY_MS);
  }
  // Agreement customers: HEURISTIC "due" = active membership and no completed job for that phone in ~10 months (no verified visit-due field).
  const { data: recentDone } = await admin.from("jobs").select("customer_phone").eq("user_id", userId).eq("job_status", "completed").gte("completed_at", new Date(now - 300 * DAY_MS).toISOString()).not("customer_phone", "is", null).limit(5000);
  const recent = new Set(((recentDone ?? []) as Row[]).map((j) => normalizePhone(String(j.customer_phone))));
  for (const m of (mem.data ?? []) as Row[]) {
    if (recent.has(normalizePhone(String(m.customer_phone)))) continue;
    await push("agreement_due", m.id as string, String(m.customer_name), String(m.customer_phone), Number(g.est_value_cents ?? 0), 0);
  }
  // Same-area: opted-in customers whose last completed job was within 15 km of the cancelled job.
  const src = srcJob.data as Row | null;
  const lat = Number(src?.latitude), lon = Number(src?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const { data: near } = await admin.from("jobs").select("customer_id, latitude, longitude, completed_at").eq("user_id", userId).eq("job_status", "completed").not("customer_id", "is", null)
      .gte("latitude", lat - 0.15).lte("latitude", lat + 0.15).gte("longitude", lon - 0.2).lte("longitude", lon + 0.2).order("completed_at", { ascending: false }).limit(200);
    const custById = new Map(((custs.data ?? []) as Row[]).map((c) => [c.id as string, c]));
    const seen = new Set<string>();
    for (const j of (near ?? []) as Row[]) {
      const cid = j.customer_id as string;
      const c = custById.get(cid);
      if (!c || seen.has(cid)) continue;
      const d = km(lat, lon, Number(j.latitude), Number(j.longitude));
      if (d > 15) continue;
      seen.add(cid);
      await push("same_area", cid, String(c.name), String(c.phone), Number(g.est_value_cents ?? 0), (now - Date.parse(String(j.completed_at ?? new Date(now).toISOString()))) / DAY_MS, { distanceKm: d });
    }
  }
  return out;
}
