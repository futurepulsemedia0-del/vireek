// supabase/functions/_shared/agent-run/twilioLookup.ts
//
// Deterministic provider lookup used ONLY to resolve the ambiguous crash/timeout window:
// "we have an attempt row but no Twilio SID — did Twilio actually accept the message?"
// Never used on the hot path. Returns 'unavailable' (never guesses) when it cannot answer.

export type SmsLookup = (q: { to: string; body: string; createdAfterMs: number }) => Promise<{ sid: string } | null | "unavailable">;

/** Same rule as _shared/compliance/dncCheck.ts normalizePhone (kept pure for tests). */
export function normalizePhoneE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone.startsWith("+") ? phone : `+${digits}`;
}

const ACCEPTED = new Set(["accepted", "queued", "sending", "sent", "delivered", "receiving", "received"]);

export function twilioSmsLookup(
  creds: { accountSid?: string; authToken?: string },
  fetchFn: typeof fetch = fetch,
): SmsLookup {
  return async ({ to, body, createdAfterMs }) => {
    if (!creds.accountSid || !creds.authToken) return "unavailable";
    const sinceDay = new Date(createdAfterMs - 24 * 3600_000).toISOString().slice(0, 10);
    const qs = new URLSearchParams({ To: normalizePhoneE164(to), PageSize: "100", "DateSent>": sinceDay });
    try {
      const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json?${qs}`, {
        headers: { Authorization: `Basic ${btoa(`${creds.accountSid}:${creds.authToken}`)}` },
      });
      if (!res.ok) return "unavailable";
      const json = (await res.json()) as { messages?: Array<{ sid: string; body: string; direction: string; status: string; date_created: string }> };
      const hit = (json.messages ?? []).find((m) =>
        m.body === body && m.direction.startsWith("outbound") && ACCEPTED.has(m.status) && Date.parse(m.date_created) >= createdAfterMs - 5_000,
      );
      return hit ? { sid: hit.sid } : null;
    } catch {
      return "unavailable";
    }
  };
}
