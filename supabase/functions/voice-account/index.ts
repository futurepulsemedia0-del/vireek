// supabase/functions/voice-account/index.ts
//
// Enrolment for "Call your Vireek": verify a phone number with an SMS code and set the call PIN in ONE step
// (the PIN can never be set or changed without proving control of the phone). Numbers and PIN hashes live in
// voice_callers, which only the service role can read; the browser never sees a hash.
//
// Deploy: supabase functions deploy voice-account      (JWT verified by the platform; re-checked in code)
// Secrets: TWILIO_* (SMS), nothing else.
//
// POST {action:"status"}
//      {action:"send_code", phone}
//      {action:"enroll", phone, code, pin}
//      {action:"remove", id}

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";
import { canSeeBilling, type BriefingRole } from "../../../src/lib/dailyBriefing.ts";
import {
  generateOtp, hashSecret, isWeakPin, maskPhone, newSaltHex, OTP_TTL_MINUTES, toE164, verifySecret,
} from "../_shared/voice/callSafety.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const MAX_NUMBERS = 3;
const MAX_OTP_TRIES = 5;
type Admin = SupabaseClient;

async function resolve(admin: Admin, userId: string): Promise<{ ownerId: string } | null> {
  const { data: p } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (p) return { ownerId: userId };
  const { data: m } = await admin.from("team_members").select("account_owner_id,role,permissions").eq("user_id", userId).eq("invite_status", "active").limit(1).maybeSingle();
  if (!m || !canSeeBilling((m.role ?? "member") as BriefingRole, m.permissions)) return null;   // same eligibility as Ask Vireek
  return { ownerId: m.account_owner_id };
}
async function limited(admin: Admin, key: string, max: number, sec: number): Promise<boolean> {
  const { data, error } = await admin.rpc("voice_consume_rate_limit", { p_key: key, p_max: max, p_window_seconds: sec });
  return error ? true : data === false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = jwt ? await admin.auth.getUser(jwt) : { data: null };
  if (!u?.user) return json({ error: "Not signed in." }, 401);
  const me = u.user.id;
  const acct = await resolve(admin, me);
  if (!acct) return json({ error: "Phone access is available to owners, admins and team members with billing access." }, 403);

  let body: { action?: string; phone?: string; code?: string; pin?: string; id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  if (body.action === "status") {
    const { data } = await admin.from("voice_callers").select("id,phone_e164,pin_hash,locked_until,verified_at").eq("user_id", me).is("revoked_at", null);
    return json({ numbers: (data ?? []).map((n: { id: string; phone_e164: string; pin_hash: string | null; locked_until: string | null; verified_at: string | null }) => ({
      id: n.id, masked: maskPhone(n.phone_e164), verified: !!n.verified_at, hasPin: !!n.pin_hash, locked: !!n.locked_until && Date.parse(n.locked_until) > Date.now(),
    })) });
  }

  const phone = toE164(body.phone);
  if (body.action === "send_code") {
    if (!phone) return json({ error: "Enter a valid phone number, including the country code." }, 400);
    if (await limited(admin, `enroll:${me}`, 5, 3600)) return json({ error: "Too many codes requested. Try again in an hour." }, 429);
    const { count } = await admin.from("voice_callers").select("id", { count: "exact", head: true }).eq("user_id", me).is("revoked_at", null);
    if ((count ?? 0) >= MAX_NUMBERS) return json({ error: `You can add up to ${MAX_NUMBERS} numbers. Remove one first.` }, 400);
    const code = generateOtp();
    const salt = newSaltHex();
    const sent = await sendSms(phone, `Your Vireek phone setup code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request it, ignore this message.`);
    if (!sent.ok) return json({ error: "We couldn't send the code. Check the number and try again." }, 502);
    await admin.from("voice_enroll_otps").insert({ user_id: me, phone_e164: phone, code_hash: `${salt}:${await hashSecret(code, salt)}`, expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString() });
    return json({ ok: true, expiresInMinutes: OTP_TTL_MINUTES });
  }

  if (body.action === "enroll") {
    const code = (body.code ?? "").replace(/\D/g, "");
    const pin = (body.pin ?? "").replace(/\D/g, "");
    if (!phone || code.length !== 6) return json({ error: "Enter the six digit code we texted you." }, 400);
    if (isWeakPin(pin, phone)) return json({ error: "Choose a six digit PIN that isn't a repeat, a sequence, or part of your phone number." }, 400);
    const { data: otp } = await admin.from("voice_enroll_otps").select("id,code_hash,attempts,expires_at").eq("user_id", me).eq("phone_e164", phone).is("consumed_at", null)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!otp || otp.attempts >= MAX_OTP_TRIES) return json({ error: "That code has expired. Request a new one." }, 400);
    const [salt, hash] = String(otp.code_hash).split(":");
    if (!(await verifySecret(code, salt, hash))) {
      await admin.from("voice_enroll_otps").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
      return json({ error: "That code didn't match." }, 400);
    }
    await admin.from("voice_enroll_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id).is("consumed_at", null);
    const pinSalt = newSaltHex();
    const fields = { pin_hash: await hashSecret(pin, pinSalt), pin_salt: pinSalt, pin_set_at: new Date().toISOString(), failed_attempts: 0, locked_until: null, verified_at: new Date().toISOString() };
    const { data: mine } = await admin.from("voice_callers").select("id").eq("user_id", me).eq("phone_e164", phone).is("revoked_at", null).maybeSingle();
    const { error } = mine
      ? await admin.from("voice_callers").update(fields).eq("id", mine.id)
      : await admin.from("voice_callers").insert({ user_id: me, account_owner_id: acct.ownerId, phone_e164: phone, ...fields });
    if (error) return json({ error: error.code === "23505" ? "That number is already linked to another Vireek login." : "We couldn't save that. Please try again." }, error.code === "23505" ? 409 : 500);
    return json({ ok: true, masked: maskPhone(phone) });
  }

  if (body.action === "remove") {
    if (!body.id) return json({ error: "Missing number." }, 400);
    await admin.from("voice_callers").update({ revoked_at: new Date().toISOString() }).eq("id", body.id).eq("user_id", me).is("revoked_at", null);
    return json({ ok: true });
  }
  return json({ error: "Unknown action" }, 400);
});
