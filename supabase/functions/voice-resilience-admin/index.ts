// supabase/functions/voice-resilience-admin/index.ts
//
// JWT-authenticated control plane.
//   Account owner/team (own account only):  status, set_org, wizard_plan, wizard_start, wizard_status
//   Vireek staff only:                       switch_provider, clear_switch, pin_ladder, clear_pin, set_chaos, slis
// All writes use the service role AFTER the caller is identified; the account is always derived from the JWT
// (get_account_owner_id), never from the request body. Deploy: supabase functions deploy voice-resilience-admin

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { twilioCarrier } from "../_shared/voice-resilience/adapters.ts";
import { E164, expiryFor, evaluateForwardTest, planFor, type CarrierFamily, type ForwardCheck } from "../_shared/voice-resilience/carrierForwarding.ts";
import { isValidE164 } from "../_shared/voice-hardening/escalation.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const CAPS = new Set(["voice_engine", "carrier", "asr", "tts", "sms"]);
const FAULTS = new Set(["engine_down", "engine_slow", "carrier_down", "sms_down", "tts_fail", "keys_expired", "db_slow", "tools_down"]);
const FAMILIES = new Set<CarrierFamily>(["gsm_standard", "verizon", "landline_voip_pbx"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !svc) return json({ error: "Server not configured" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "Unauthorized" }, 401);

  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await asUser.auth.getUser();
  if (!u?.user) return json({ error: "Unauthorized" }, 401);
  const { data: owner } = await asUser.rpc("get_account_owner_id");
  if (typeof owner !== "string") return json({ error: "No account" }, 403);
  const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: prof } = await admin.from("profiles").select("is_staff, phone, forwarding_number").eq("id", u.user.id).maybeSingle();
  const isStaff = prof?.is_staff === true;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action ?? "");

  switch (action) {
    case "status": {
      const [{ data: org }, { data: lad }, { data: fb }, { data: checks }] = await Promise.all([
        admin.from("voice_org_resilience").select("*").eq("user_id", owner).maybeSingle(),
        admin.from("voice_ladder_state").select("level, since, components").eq("scope", "platform").maybeSingle(),
        admin.from("voice_fallback_calls").select("call_sid, level, outcome, is_emergency, created_at").eq("user_id", owner).order("created_at", { ascending: false }).limit(20),
        admin.from("voice_forward_checks").select("id, kind, status, started_at, finished_at").eq("user_id", owner).order("started_at", { ascending: false }).limit(5),
      ]);
      return json({ org, platform_level: lad?.level ?? 0, since: lad?.since ?? null, recent_fallback_calls: fb ?? [], checks: checks ?? [] });
    }

    case "set_org": {
      const patch: Record<string, unknown> = { user_id: owner, updated_at: new Date().toISOString() };
      if (body.forward_numbers !== undefined) {
        const list = Array.isArray(body.forward_numbers) ? (body.forward_numbers as unknown[]).map(String) : [];
        if (list.length > 5 || !list.every(isValidE164)) return json({ error: "forward_numbers must be up to 5 E.164 numbers" }, 400);
        patch.forward_numbers = list;
      }
      if (body.static_message !== undefined) {
        const m = body.static_message === null ? null : String(body.static_message).trim().slice(0, 500);
        patch.static_message = m || null;
      }
      if (body.language !== undefined) { if (body.language !== "en" && body.language !== "es") return json({ error: "language" }, 400); patch.language = body.language; }
      if (body.alert_sms !== undefined) patch.alert_sms = body.alert_sms === true;
      if (body.front_door_enabled !== undefined) patch.front_door_enabled = body.front_door_enabled === true;
      if (body.reduced_assistant_id !== undefined) {
        const v = body.reduced_assistant_id === null ? null : String(body.reduced_assistant_id).trim();
        if (v && !/^[A-Za-z0-9_-]{8,64}$/.test(v)) return json({ error: "reduced_assistant_id" }, 400);
        patch.reduced_assistant_id = v;
      }
      if (body.forced_level !== undefined) {
        if (body.forced_level === null) { patch.forced_level = null; patch.forced_until = null; }
        else {
          const lvl = Number(body.forced_level), mins = Number(body.forced_minutes ?? 60);
          if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4 || !Number.isFinite(mins) || mins < 1 || mins > 1440) return json({ error: "forced_level 0-4, forced_minutes 1-1440" }, 400);
          patch.forced_level = lvl; patch.forced_until = new Date(Date.now() + mins * 60_000).toISOString();
        }
      }
      if (body.provider_overrides !== undefined) {
        const arr = Array.isArray(body.provider_overrides) ? (body.provider_overrides as Record<string, unknown>[]) : null;
        const okArr = arr && arr.length <= 10 && arr.every((o) => CAPS.has(String(o.capability)) && ["pin", "prefer", "block"].includes(String(o.mode)) && /^[a-z0-9_-]{2,32}$/.test(String(o.providerId)));
        if (!okArr) return json({ error: "provider_overrides invalid" }, 400);
        patch.provider_overrides = arr!.map((o) => ({ capability: String(o.capability), mode: String(o.mode), providerId: String(o.providerId) }));
      }
      const { error } = await admin.from("voice_org_resilience").upsert(patch, { onConflict: "user_id" });
      return error ? json({ error: "Could not save" }, 500) : json({ ok: true });
    }

    case "wizard_plan": {
      const family = String(body.family) as CarrierFamily, vn = String(body.vireek_number ?? "");
      if (!FAMILIES.has(family) || !E164.test(vn)) return json({ error: "family or vireek_number invalid" }, 400);
      const { data: mine } = await admin.from("phone_numbers").select("id").eq("account_id", owner).eq("phone_number", vn).maybeSingle();
      if (!mine) return json({ error: "That Vireek number is not on your account" }, 403);
      return json({ codes: planFor(family, vn, Number(body.ring_seconds) || 20), warning: "Codes are a guide. Only a passing test call proves forwarding works. Turn off carrier voicemail for this line, or it may answer first." });
    }

    case "wizard_start": {
      const kind = body.kind === "forward_off" ? "forward_off" : body.kind === "forward_on" ? "forward_on" : null;
      const vn = String(body.vireek_number ?? ""), bn = String(body.business_number ?? "");
      if (!kind || !E164.test(vn) || !E164.test(bn)) return json({ error: "kind, vireek_number, business_number required (E.164)" }, 400);
      const { data: mine } = await admin.from("phone_numbers").select("id").eq("account_id", owner).eq("phone_number", vn).maybeSingle();
      if (!mine) return json({ error: "That Vireek number is not on your account" }, 403);
      // Only the account's OWN business number may be rung: this endpoint must never become a harassment dialer.
      const own = [prof?.phone, prof?.forwarding_number].filter(isValidE164);
      if (!own.includes(bn)) return json({ error: "business_number must be the phone number saved on your account" }, 403);
      const probeFrom = Deno.env.get("VOICE_PROBE_FROM");
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN"), base = Deno.env.get("VOICE_FRONT_DOOR_BASE");
      if (!probeFrom || !isValidE164(probeFrom) || !sid || !tok || !base) return json({ error: "Test calls are not configured (VOICE_PROBE_FROM, Twilio, VOICE_FRONT_DOOR_BASE)" }, 503);
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const { count } = await admin.from("voice_forward_checks").select("id", { count: "exact", head: true }).eq("user_id", owner).gte("started_at", since);
      if ((count ?? 0) >= 5) return json({ error: "Too many test calls this hour" }, 429);

      const ring = Math.min(30, Math.max(5, Number(body.ring_seconds) || 20));
      const startedAt = Date.now();
      const { data: row, error } = await admin.from("voice_forward_checks").insert({
        user_id: owner, kind, business_number: bn, vireek_number: vn, probe_from: probeFrom, ring_seconds: ring, expires_at: new Date(expiryFor(startedAt, ring)).toISOString(),
      }).select("id").single();
      if (error || !row) return json({ error: "Could not start" }, 500);
      try {
        const placed = await twilioCarrier({ accountSid: sid, authToken: tok }).placeCall({
          to: bn, from: probeFrom, timeoutSeconds: ring + 15,
          twiml: `<Response><Say>This is a Vireek phone test. Please do not answer.</Say><Pause length="${ring + 20}"/></Response>`,
          statusCallback: `${base}?action=check-status&check=${row.id}`,
        });
        await admin.from("voice_forward_checks").update({ outbound_sid: placed.callSid, outbound_status: "ringing" }).eq("id", row.id);
      } catch (e) {
        await admin.from("voice_forward_checks").update({ status: "error", finished_at: new Date().toISOString() }).eq("id", row.id);
        return json({ error: "Test call could not be placed", detail: e instanceof Error ? e.message.slice(0, 120) : "error" }, 502);
      }
      return json({ check_id: row.id, instruction: kind === "forward_on" ? "Let your phone ring. Do NOT answer." : "Let your phone ring. After cancelling forwarding it must ring out here only." });
    }

    case "wizard_status": {
      const id = String(body.check_id ?? "");
      const { data: r } = await admin.from("voice_forward_checks").select("*").eq("id", id).eq("user_id", owner).maybeSingle();
      if (!r) return json({ error: "Not found" }, 404);
      let status = r.status as string;
      if (status === "pending") {
        const check: ForwardCheck = {
          id: r.id, kind: r.kind, businessNumber: r.business_number, vireekNumber: r.vireek_number, probeFrom: r.probe_from,
          startedAt: Date.parse(r.started_at), expiresAt: Date.parse(r.expires_at), outboundStatus: r.outbound_status,
        };
        status = evaluateForwardTest(check, (r.arrivals as never[]) ?? [], Date.now());
        if (status !== "pending") await admin.from("voice_forward_checks").update({ status, finished_at: new Date().toISOString() }).eq("id", id);
      }
      return json({ status, kind: r.kind, outbound_status: r.outbound_status });
    }
  }

  // ---- staff-only
  if (!isStaff) return json({ error: "Forbidden" }, 403);
  switch (action) {
    case "switch_provider": {
      const cap = String(body.capability), pid = String(body.provider_id), mins = Number(body.minutes ?? 60);
      if (!CAPS.has(cap) || !/^[a-z0-9_-]{2,32}$/.test(pid) || !(mins >= 1 && mins <= 1440)) return json({ error: "invalid" }, 400);
      const { data: p } = await admin.from("voice_providers").select("enabled").eq("capability", cap).eq("provider_id", pid).maybeSingle();
      if (!p?.enabled) return json({ error: "Provider unknown or disabled" }, 400);
      await admin.from("voice_platform_switch").upsert({ capability: cap, force_provider_id: pid, until: new Date(Date.now() + mins * 60_000).toISOString(), set_by: u.user.id }, { onConflict: "capability" });
      return json({ ok: true });
    }
    case "clear_switch": {
      await admin.from("voice_platform_switch").delete().eq("capability", String(body.capability));
      return json({ ok: true });
    }
    case "pin_ladder": {
      const lvl = Number(body.level), mins = Number(body.minutes ?? 30);
      if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4 || !(mins >= 1 && mins <= 720)) return json({ error: "invalid" }, 400);
      await admin.from("voice_ladder_state").update({ pin_level: lvl, pin_until: new Date(Date.now() + mins * 60_000).toISOString(), pin_by: u.user.id }).eq("scope", "platform");
      return json({ ok: true });
    }
    case "clear_pin": {
      await admin.from("voice_ladder_state").update({ pin_level: null, pin_until: null, pin_by: null }).eq("scope", "platform");
      return json({ ok: true });
    }
    case "set_chaos": {
      if (Deno.env.get("VOICE_CHAOS_ENABLED") !== "true") return json({ error: "Chaos is disabled in this environment" }, 403);
      const f = String(body.fault);
      if (!FAULTS.has(f)) return json({ error: "invalid fault" }, 400);
      const mins = Math.min(60, Math.max(1, Number(body.minutes ?? 10)));
      await admin.from("voice_chaos_flags").upsert({ fault: f, active: body.active !== false, until: new Date(Date.now() + mins * 60_000).toISOString(), updated_at: new Date().toISOString() }, { onConflict: "fault" });
      return json({ ok: true });
    }
    case "slis": {
      const { data } = await admin.rpc("voice_resilience_slis", { p_hours: Math.min(720, Math.max(1, Number(body.hours ?? 24))) });
      return json(data ?? {});
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
