// supabase/functions/voice-health-tick/index.ts
//
// Cron (every minute). 1) actively probes primary providers, 2) evaluates circuit breakers from recorded outcomes,
// 3) derives component health, 4) steps the degradation ladder with hysteresis, 5) on a level change writes an audit
// event, updates the public status incident and alerts owners.
// Auth: x-push-dispatch-secret or service-role bearer (same as synthetic-probe). Deploy: --no-verify-jwt.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import { twilioCarrier, vapiEngine } from "../_shared/voice-resilience/adapters.ts";
import { DEFAULT_BREAKER, INITIAL_BREAKER, evaluateBreaker, type BreakerSnapshot, type Outcome } from "../_shared/voice-resilience/circuitBreaker.ts";
import {
  DEFAULT_LADDER, componentsFromScores, initialLadder, stepLadder, targetLevel, type ComponentHealth, type Health, type LadderState, type Level,
} from "../_shared/voice-resilience/ladder.ts";
import { ownerAlert, publicIncident } from "../_shared/voice-resilience/incidentCopy.ts";
import { activeChaos, notifyInApp, recordOutcome, sendOwnerSms } from "../_shared/voice-resilience/runtime.ts";

type Admin = ReturnType<typeof createClient>;
interface OutRow { provider_id: string; capability: string; ok: boolean; latency_ms: number | null; at: string }

const CHAOS_TARGET: Record<string, { provider: string; capability: string; slow?: boolean }> = {
  engine_down: { provider: "vapi", capability: "voice_engine" },
  engine_slow: { provider: "vapi", capability: "voice_engine", slow: true },
  carrier_down: { provider: "twilio", capability: "carrier" },
  sms_down: { provider: "twilio", capability: "sms" },
  tools_down: { provider: "tools", capability: "tools" },
};

async function probeActive(admin: Admin): Promise<void> {
  const vk = Deno.env.get("VAPI_PRIVATE_KEY");
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const jobs: Promise<unknown>[] = [];
  if (vk) jobs.push(vapiEngine({ privateKey: vk }).healthCheck().then((h) => recordOutcome(admin, { providerId: "vapi", capability: "voice_engine", ok: h.ok, latencyMs: h.latencyMs, errorCode: h.detail })));
  if (sid && tok) {
    const c = twilioCarrier({ accountSid: sid, authToken: tok });
    jobs.push(c.healthCheck().then((h) => Promise.all([
      recordOutcome(admin, { providerId: "twilio", capability: "carrier", ok: h.ok, latencyMs: h.latencyMs, errorCode: h.detail }),
    ])));
  }
  await Promise.all(jobs);
}

async function injectChaos(admin: Admin): Promise<string[]> {
  const faults = [...(await activeChaos(admin))];
  for (const f of faults) {
    const t = CHAOS_TARGET[f];
    if (!t) continue;
    // 6 synthetic outcomes per tick comfortably exceed minSamples; clearly marked so they are never mistaken for production.
    await admin.from("voice_provider_outcomes").insert(Array.from({ length: 6 }, () => ({
      provider_id: t.provider, capability: t.capability, ok: !!t.slow, latency_ms: t.slow ? 9_000 : 50, error_code: "chaos",
    })));
  }
  return faults;
}

export function worstHealth(list: Health[]): Health {
  return list.includes("down") ? "down" : list.includes("degraded") ? "degraded" : "healthy";
}

async function run(admin: Admin): Promise<Response> {
  const now = Date.now();
  await probeActive(admin);
  const chaos = await injectChaos(admin);

  const { data: outs, error: oErr } = await admin.rpc("voice_recent_outcomes", { p_window_seconds: Math.ceil(DEFAULT_BREAKER.windowMs / 1000) });
  if (oErr) return json({ error: oErr.message }, 500);
  const { data: hrows } = await admin.from("voice_provider_health").select("*");
  const byKey = new Map<string, Outcome[]>();
  for (const r of (outs ?? []) as OutRow[]) {
    const k = `${r.provider_id}|${r.capability}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push({ at: Date.parse(r.at), ok: r.ok, latencyMs: r.latency_ms });
  }
  const prevByKey = new Map((hrows ?? []).map((h: Record<string, unknown>) => [`${h.provider_id}|${h.capability}`, h]));
  for (const k of prevByKey.keys()) if (!byKey.has(k)) byKey.set(k, []);

  const scores = new Map<string, { score: number; state: string }>();
  for (const [k, outcomes] of byKey) {
    const [providerId, capability] = k.split("|");
    const p = prevByKey.get(k) as Record<string, unknown> | undefined;
    const prev: BreakerSnapshot = p ? {
      state: p.state as BreakerSnapshot["state"], openedAt: p.opened_at ? Date.parse(String(p.opened_at)) : null,
      consecutiveOpens: Number(p.consecutive_opens), halfOpenAt: p.half_open_at ? Date.parse(String(p.half_open_at)) : null,
    } : INITIAL_BREAKER;
    const res = evaluateBreaker(prev, outcomes, now);
    scores.set(k, { score: res.score, state: res.snapshot.state });
    await admin.from("voice_provider_health").upsert({
      provider_id: providerId, capability, state: res.snapshot.state,
      opened_at: res.snapshot.openedAt ? new Date(res.snapshot.openedAt).toISOString() : null,
      half_open_at: res.snapshot.halfOpenAt ? new Date(res.snapshot.halfOpenAt).toISOString() : null,
      consecutive_opens: res.snapshot.consecutiveOpens, score: res.score, stats: res.stats, updated_at: new Date(now).toISOString(),
    }, { onConflict: "provider_id,capability" });
  }

  const components = componentsFromScores(Object.fromEntries([...scores].map(([k, v]) => [k, v.score])));
  const target = targetLevel(components);

  const { data: st } = await admin.from("voice_ladder_state").select("*").eq("scope", "platform").maybeSingle();
  const prevState: LadderState = st ? {
    level: st.level as Level, since: Date.parse(st.since), pending: st.pending as Level | null, pendingSince: st.pending_since ? Date.parse(st.pending_since) : null,
    recent: ((st.recent as number[]) ?? []).map(Number), pin: st.pin_level != null && st.pin_until ? { level: st.pin_level as Level, until: Date.parse(st.pin_until), by: st.pin_by ?? "staff" } : null,
  } : initialLadder(now);
  const step = stepLadder(prevState, target, now, DEFAULT_LADDER);
  const s = step.state;
  await admin.from("voice_ladder_state").upsert({
    scope: "platform", level: s.level, since: new Date(s.since).toISOString(), pending: s.pending,
    pending_since: s.pendingSince ? new Date(s.pendingSince).toISOString() : null, recent: s.recent,
    pin_level: s.pin && s.pin.until > now ? s.pin.level : null, pin_until: s.pin && s.pin.until > now ? new Date(s.pin.until).toISOString() : null, pin_by: s.pin?.by ?? null,
    components, updated_at: new Date(now).toISOString(),
  }, { onConflict: "scope" });

  if (step.changed) await announce(admin, step.from, step.to, step.reason, components);
  return json({ level: s.level, target, changed: step.changed, reason: step.reason, components, chaos });
}

async function announce(admin: Admin, from: Level, to: Level, reason: string, components: ComponentHealth): Promise<void> {
  const { data: ev } = await admin.from("voice_ladder_events").insert({ scope: "platform", from_level: from, to_level: to, reason, components }).select("id").single();

  // Public status (generic copy) via the existing incident RPCs + subscriber notification.
  const pub = publicIncident(to, from);
  try {
    const { data: comp } = await admin.from("slo_definitions").select("component_id").eq("key", "voice_availability").maybeSingle();
    const componentId = Deno.env.get("VOICE_STATUS_COMPONENT_ID") ?? comp?.component_id ?? null;
    if (pub.resolved) {
      await admin.rpc("synthetic_resolve_incident", { p_dedupe_key: "voice-ladder", p_message: pub.message });
    } else if (componentId) {
      await admin.rpc("synthetic_open_incident", { p_dedupe_key: "voice-ladder", p_title: pub.title, p_impact: pub.impact, p_component_id: componentId, p_region: "global", p_message: pub.message });
    }
    const base = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), secret = Deno.env.get("STATUS_NOTIFY_WEBHOOK_SECRET");
    if (base && svc) {
      await fetch(`${base}/functions/v1/notify-status-subscribers`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc}`, ...(secret ? { "X-Webhook-Secret": secret } : {}) },
        body: JSON.stringify({ title: pub.title, impact: pub.impact, status: pub.resolved ? "resolved" : "investigating", summary: pub.message }),
      }).catch(() => null);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "voice_status_update_failed", error: e instanceof Error ? e.message : String(e) }));
  }

  // Owner alerts: every account with a phone number. SMS only for L>=2 (and recovery to L0), in-app always.
  const { data: nums } = await admin.from("phone_numbers").select("account_id").limit(5000);
  const owners = [...new Set((nums ?? []).map((n: { account_id: string }) => n.account_id))];
  const BATCH = 20;
  for (let i = 0; i < owners.length; i += BATCH) {
    await Promise.all(owners.slice(i, i + BATCH).map(async (owner) => {
      try {
        const [{ data: org }, { data: prof }] = await Promise.all([
          admin.from("voice_org_resilience").select("language, alert_sms").eq("user_id", owner).maybeSingle(),
          admin.from("profiles").select("phone").eq("id", owner).maybeSingle(),
        ]);
        const a = ownerAlert(from, to, org?.language === "es" ? "es" : "en");
        await notifyInApp(admin, owner, a.title, a.body);
        const wantSms = (to >= 2 || to === 0) && org?.alert_sms !== false && prof?.phone;
        if (wantSms) await sendOwnerSms(admin, owner, String(prof!.phone), a.sms, `ladder:${ev?.id ?? ""}:${owner}`);
      } catch { /* one owner's failure must not stop the rest */ }
    }));
  }
  if (ev?.id) await admin.from("voice_ladder_events").update({ notified_at: new Date().toISOString() }).eq("id", ev.id);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  return await run(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
});
