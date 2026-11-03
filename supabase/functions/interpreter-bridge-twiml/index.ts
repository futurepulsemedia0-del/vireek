// supabase/functions/interpreter-bridge-twiml/index.ts
//
// Twilio Voice webhook for the interpreter bridge number. The live call is moved
// here by the `interpreter` function (action start_bridge). This endpoint:
//   1. verifies X-Twilio-Signature (public endpoint, verify_jwt = false);
//   2. identifies the business from the dialled number (settings.bridge_number);
//   3. pairs the call with its pending session — by the 6-digit code sent as the
//      transfer extension (DTMF), else, only if EXACTLY ONE session is pending for
//      that business and it is under 2 minutes old;
//   4. answers with <Connect><Stream> to the bridge worker, passing a signed,
//      short-lived session token (never a database credential).
// A call that cannot be paired is told so and hung up; it is never connected blind.
//
// Secrets: TWILIO_AUTH_TOKEN, INTERPRETER_BRIDGE_SECRET (>= 32 chars),
//          INTERPRETER_TWIML_BASE (this function's exact public URL, no query string),
//          INTERPRETER_WORKER_WSS_URL (wss://… of services/interpreter-bridge).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { validTwilioSignature, twiml } from "../_shared/pbx/twilio.ts";
import { signClaims } from "../_shared/interpreter/bridgeToken.ts";
import { xml } from "../_shared/pbx/logic.ts";

const PAIR_WINDOW_MS = 120_000;
const say = (t: string) => `<Say language="en-US">${xml(t)}</Say>`;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  (await req.formData()).forEach((v, k) => { if (typeof v === "string") params[k] = v; });

  const base = Deno.env.get("INTERPRETER_TWIML_BASE") ?? "";
  if (!base || !(await validTwilioSignature(base + url.search, params, req.headers.get("X-Twilio-Signature"), Deno.env.get("TWILIO_AUTH_TOKEN") ?? ""))) {
    return new Response("Forbidden", { status: 403 });
  }
  const secret = Deno.env.get("INTERPRETER_BRIDGE_SECRET") ?? "";
  const wss = Deno.env.get("INTERPRETER_WORKER_WSS_URL") ?? "";
  if (secret.length < 32 || !wss.startsWith("wss://")) return twiml(say("The interpreter is not configured.") + "<Hangup/>");

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: settings } = await admin.from("interpreter_settings").select("user_id, enabled").eq("bridge_number", params.To ?? "").maybeSingle();
  if (!settings?.enabled) return twiml(say("This number is not in service.") + "<Hangup/>");

  const digits = (params.Digits ?? "").replace(/\D/g, "");
  const step = url.searchParams.get("step") ?? "";

  if (!digits && step !== "fallback") {
    // Ask for the pairing code (the Vapi transfer normally sends it as the extension).
    const self = xml(`${base}?step=fallback`);
    return twiml(`<Gather input="dtmf" numDigits="6" timeout="3" action="${self}" method="POST"></Gather><Redirect method="POST">${self}</Redirect>`);
  }

  const since = new Date(Date.now() - PAIR_WINDOW_MS).toISOString();
  let q = admin.from("interpreter_sessions").select("id, user_id, staff_destination, caller_language").eq("user_id", settings.user_id).eq("status", "pending").gte("created_at", since);
  if (digits.length === 6) q = q.eq("pairing_code", digits);
  const { data: pending } = await q.limit(2);
  if (!pending || pending.length !== 1) {
    return twiml(say("Sorry, we could not connect the interpreter. Please call back.") + "<Hangup/>");
  }
  const s = pending[0];
  // Atomic claim: two calls can never be paired to the same session.
  const { data: claimed } = await admin.from("interpreter_sessions").update({ status: "active", started_at: new Date().toISOString() }).eq("id", s.id).eq("status", "pending").select("id").maybeSingle();
  if (!claimed) return twiml(say("Sorry, we could not connect the interpreter. Please call back.") + "<Hangup/>");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await signClaims({ sid: s.id, uid: s.user_id, role: "caller", exp, dest: s.staff_destination ?? undefined }, secret);
  return twiml(`<Connect><Stream url="${xml(wss)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect>`);
});
