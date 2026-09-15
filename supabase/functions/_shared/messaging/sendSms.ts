// supabase/functions/_shared/messaging/sendSms.ts
//
// The ONLY place in this codebase allowed to call Twilio's SMS API.
// Every future code path that texts a customer MUST go through
// sendCompliantSms() — it enforces two independent gates first:
//   1. A2P 10DLC campaign approval (a2pGate.ts) — fails loud here
//      instead of the message silently vanishing at the carrier.
//   2. STOP/opt-out suppression — reuses the existing dnc_suppressions
//      table/isDncSuppressed(), the same list outbound calling already
//      respects, so one opt-out blocks calls AND texts.
//
// NOT LIVE-VERIFIED: this is Twilio's documented Messages API shape as
// of this assistant's last verified knowledge — re-check
// https://www.twilio.com/docs/sms/send-messages before production use.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkA2pApproved } from "../compliance/a2pGate.ts";
import { isDncSuppressed, normalizePhone } from "../compliance/dncCheck.ts";

export type SendSmsResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "A2P_NOT_APPROVED" | "OPTED_OUT" | "NOT_CONFIGURED" | "TWILIO_ERROR"; detail?: string };

export async function sendCompliantSms(
  admin: SupabaseClient,
  userId: string,
  to: string,
  body: string,
): Promise<SendSmsResult> {
  const a2p = await checkA2pApproved(admin, userId);
  if (!a2p.approved) {
    return { ok: false, reason: "A2P_NOT_APPROVED", detail: a2p.status };
  }

  if (await isDncSuppressed(admin, userId, to)) {
    return { ok: false, reason: "OPTED_OUT" };
  }

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  if (!accountSid || !authToken || !messagingServiceSid) {
    return { ok: false, reason: "NOT_CONFIGURED", detail: "Twilio secrets not set" };
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
    },
    body: new URLSearchParams({ MessagingServiceSid: messagingServiceSid, To: normalizePhone(to), Body: body }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, reason: "TWILIO_ERROR", detail: json?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, sid: json.sid };
}
