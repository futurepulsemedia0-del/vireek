// supabase/functions/pbx-actions/index.ts
//
// Authenticated actions for the softphone and Phone System pages. Every action
// proves tenancy with the CALLER's JWT (RLS read of the call), then uses the
// service role only for the audited state change. Phone numbers are never taken
// from the client except for an explicit, validated, prefix-restricted transfer target.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isValidE164 } from "../_shared/pbx/logic.ts";
import { mintVoiceToken } from "../_shared/pbx/twilio.ts";
import {
  FALLBACK_HOLD_MUSIC, callerIdFor, clientIdentity, confSid, createLeg, endLeg, loadSettings,
  setEndOnExit, setHold, type Row,
} from "../_shared/pbx/runtime.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f-]{36}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not authenticated" }, 401);

  // deno-lint-ignore no-explicit-any
  const body = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!body?.action) return json({ error: "action is required" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: owner } = await userClient.rpc("get_account_owner_id");
  if (!owner) return json({ error: "No account" }, 403);

  try {
    // ---- playback of recordings / voicemails (authorised + audited in SQL)
    if (body.action === "media_url") {
      if (!["recording", "voicemail"].includes(body.kind) || !UUID.test(body.id ?? "")) return json({ error: "Bad request" }, 400);
      const { data: path, error } = await userClient.rpc("pbx_authorize_media", { p_kind: body.kind, p_id: body.id });
      if (error || !path) return json({ error: "Not available" }, error?.code === "42501" ? 403 : 404);
      const { data: signed } = await admin.storage.from("pbx-media").createSignedUrl(path, 120);
      return signed ? json({ url: signed.signedUrl }) : json({ error: "Could not sign URL" }, 502);
    }

    const { data: me } = await admin.from("pbx_extensions").select("*").eq("account_owner_id", owner).eq("user_id", user.id).maybeSingle();
    if (!me) return json({ error: "You do not have an extension yet. Ask an admin to create one." }, 404);

    if (body.action === "token") {
      const identity = clientIdentity(me.id);
      return json({ token: await mintVoiceToken(identity), identity, extension: me.extension, display_name: me.display_name });
    }

    // ---- everything below acts on one call
    const callId = String(body.call_id ?? body.slot_call_id ?? "");
    let call: Row | null = null;

    if (body.action === "retrieve") {
      const slot = Number(body.slot);
      if (!Number.isInteger(slot)) return json({ error: "slot is required" }, 400);
      const { data: s } = await admin.from("pbx_parking_slots").select("call_id").eq("account_owner_id", owner).eq("slot", slot).maybeSingle();
      if (!s) return json({ error: "Nothing is parked there" }, 404);
      call = (await admin.from("pbx_calls").select("*").eq("id", s.call_id).maybeSingle()).data;
    } else {
      if (!UUID.test(callId)) return json({ error: "call_id is required" }, 400);
      call = (await userClient.from("pbx_calls").select("*").eq("id", callId).maybeSingle()).data; // RLS-scoped
    }
    if (!call) return json({ error: "Call not found" }, 404);

    const settings = await loadSettings(admin, owner);
    const music = settings.default_hold_music_url || FALLBACK_HOLD_MUSIC;

    if (body.action === "retrieve") {
      if (call.status !== "parked") return json({ error: "That call is no longer parked" }, 409);
      const ok = await createLeg(admin, call, { role: "consult", target: { extensionId: me.id }, from: await callerIdFor(admin, call, me), ringSeconds: 25, joinAction: "agent-join" });
      return ok ? json({ success: true, expect_incoming: true }) : json({ error: "Could not reach your softphone" }, 502);
    }

    const { data: legRows } = await admin.from("pbx_call_legs").select("*").eq("call_id", call.id).in("status", ["ringing", "in_progress"]);
    const legs = (legRows ?? []) as Row[];
    const mine = legs.find((l) => l.extension_id === me.id && l.status === "in_progress" && !l.target_number);
    if (!mine) return json({ error: "You are not on that call" }, 403);
    const others = legs.filter((l) => l.id !== mine.id && l.status === "in_progress" && l.call_sid);
    const cs = await confSid(admin, call);
    if (!cs) return json({ error: "The call is not connected yet" }, 409);

    switch (body.action) {
      case "hold": {
        for (const o of others) await setHold(cs, o.call_sid, body.hold !== false, music);
        return json({ success: true });
      }

      case "park": {
        if (call.status !== "in_progress") return json({ error: "Only a connected call can be parked" }, 409);
        const { data: slot } = await admin.rpc("pbx_park_call", { p_call_id: call.id, p_extension_id: me.id, p_timeout: settings.park_timeout_seconds });
        if (slot == null) return json({ error: "No free parking slot" }, 409);
        for (const o of others) await setHold(cs, o.call_sid, true, music);
        await setEndOnExit(cs, mine.call_sid, false);
        await endLeg(mine.call_sid, "completed");
        return json({ success: true, slot });
      }

      // Warm transfer step 1 (mode=warm holds the others) / 3-way (mode=conference keeps everyone live).
      case "add_participant": {
        if (call.status !== "in_progress") return json({ error: "The call is not active" }, 409);
        if (legs.length >= 4) return json({ error: "The conference is full" }, 409);
        const t = body.target ?? {};
        let target: { extensionId?: string; number?: string };
        if (t.type === "extension" && UUID.test(t.id ?? "")) {
          const { data: ext } = await admin.from("pbx_extensions").select("id").eq("id", t.id).eq("account_owner_id", owner).maybeSingle();
          if (!ext) return json({ error: "Extension not found" }, 404);
          const { data: ok } = await admin.rpc("pbx_available_extensions", { p_owner: owner, p_ids: [ext.id], p_wrap_seconds: 0 });
          if (!ok?.length) return json({ error: "That extension is unavailable" }, 409);
          target = { extensionId: ext.id };
        } else if (t.type === "external" && isValidE164(t.number)) {
          if (!(settings.outbound_country_codes as string[]).some((p) => t.number.startsWith(p))) return json({ error: "Destination not permitted" }, 403);
          target = { number: t.number };
        } else return json({ error: "Invalid target" }, 400);

        const from = await callerIdFor(admin, call, me);
        if (!from) return json({ error: "No caller ID available" }, 409);
        if (body.mode === "warm") for (const o of others) await setHold(cs, o.call_sid, true, music);
        const ok = await createLeg(admin, call, { role: "consult", target, from, ringSeconds: 25, joinAction: target.number ? "pstn-join" : "agent-join" });
        if (!ok && body.mode === "warm") for (const o of others) await setHold(cs, o.call_sid, false, "");
        return ok ? json({ success: true }) : json({ error: "Could not place the call" }, 502);
      }

      case "complete_transfer": {
        const consult = legs.find((l) => l.role === "consult" && l.status === "in_progress");
        if (!consult) return json({ error: "The transfer target has not answered yet" }, 409);
        if (consult.extension_id) await admin.from("pbx_calls").update({ extension_id: consult.extension_id }).eq("id", call.id);
        for (const o of others) await setHold(cs, o.call_sid, false, "");
        await setEndOnExit(cs, mine.call_sid, false);
        await endLeg(mine.call_sid, "completed");
        return json({ success: true });
      }

      case "cancel_consult": {
        for (const l of legs.filter((x) => x.role === "consult" && x.call_sid)) {
          try { await endLeg(l.call_sid, l.status === "ringing" ? "canceled" : "completed"); } catch { /* ended */ }
        }
        for (const o of others.filter((x) => x.role !== "consult")) await setHold(cs, o.call_sid, false, "");
        return json({ success: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "pbx_actions_error", action: body.action, error: String(e) }));
    return json({ error: "Something went wrong. Please try again." }, 502);
  }
});
