// supabase/functions/_shared/audit/providers.ts
// Real provider adapters (fetch only). NOT LIVE-VERIFIED from the authoring environment (no network egress to these
// vendors): endpoints and field names follow each vendor's public API as known at authoring time; confirm in staging
// with the checklist in docs/compliance/missed-call-audit.md before enabling.

import { timingSafeEqual } from "./crypto.ts";
import type { RawCallReport } from "./outcome.ts";
import type { BotCheck, CallProvider, LineLookup, Mailer, OtpProvider, PlaceResult } from "./ports.ts";
import { buildVapiAuditCall } from "./script.ts";

const TIMEOUT_MS = 10_000;
async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}
const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);

export function twilioVerifyOtp(o: { accountSid: string; authToken: string; verifyServiceSid: string }): OtpProvider {
  const base = `https://verify.twilio.com/v2/Services/${o.verifyServiceSid}`;
  const headers = { Authorization: basic(o.accountSid, o.authToken), "Content-Type": "application/x-www-form-urlencoded" };
  return {
    async start(to, channel) {
      const r = await http(`${base}/Verifications`, { method: "POST", headers, body: new URLSearchParams({ To: to, Channel: channel === "voice" ? "call" : "sms" }) });
      if (!r.ok) throw new Error(`twilio_verify_start_${r.status}`);
      const j = await r.json().catch(() => ({}));
      return { ref: typeof j.sid === "string" ? j.sid : null };
    },
    async check(to, code) {
      const r = await http(`${base}/VerificationCheck`, { method: "POST", headers, body: new URLSearchParams({ To: to, Code: code }) });
      if (r.status === 404) return false; // expired / already used
      if (!r.ok) throw new Error(`twilio_verify_check_${r.status}`);
      const j = await r.json().catch(() => ({}));
      return j.status === "approved" && j.valid !== false;
    },
  };
}

export function twilioLookup(o: { accountSid: string; authToken: string }): LineLookup {
  return {
    async lookup(e164) {
      const r = await http(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, { headers: { Authorization: basic(o.accountSid, o.authToken) } });
      if (!r.ok) throw new Error(`twilio_lookup_${r.status}`);
      const j = await r.json().catch(() => ({}));
      const t = j?.line_type_intelligence?.type;
      return { type: typeof t === "string" ? t : null };
    },
  };
}

export function resendMailer(o: { apiKey: string; from: string; replyTo?: string }): Mailer {
  return {
    async send(m) {
      const r = await http("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers, ...(o.replyTo ? { reply_to: o.replyTo } : {}) }),
      });
      if (!r.ok) throw new Error(`resend_${r.status}`);
      const j = await r.json().catch(() => ({}));
      return { id: typeof j.id === "string" ? j.id : null };
    },
  };
}

export function turnstileBot(secret: string): BotCheck {
  return {
    async verify(token, ip) {
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set("remoteip", ip);
      try {
        const r = await http("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
        if (!r.ok) return false; // fail closed
        return (await r.json())?.success === true;
      } catch { return false; }
    },
  };
}

const usdToCents = (v: unknown) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);

/** Maps a Vapi call object to the minimal RawCallReport. Transcript is passed through ONLY for stop-detection. */
export function vapiCallToReport(c: Record<string, any>): RawCallReport { // deno-lint-ignore no-explicit-any
  const started = typeof c.startedAt === "string" ? Date.parse(c.startedAt) : NaN;
  const ended = typeof c.endedAt === "string" ? Date.parse(c.endedAt) : NaN;
  return {
    endedReason: typeof c.endedReason === "string" ? c.endedReason : null,
    startedAt: c.startedAt ?? null,
    endedAt: c.endedAt ?? null,
    durationSeconds: isFinite(started) && isFinite(ended) && ended >= started ? Math.round((ended - started) / 1000) : null,
    structured: c.analysis?.structuredData ?? c.artifact?.structuredOutputs ?? null,
    transientTranscript: typeof c.artifact?.transcript === "string" ? c.artifact.transcript : typeof c.transcript === "string" ? c.transcript : null,
    costUsd: usdToCents(c.cost),
  };
}

export function vapiCalls(o: { apiKey: string; phoneNumberId: string; serverUrl: string; serverSecret: string; voice?: unknown; model?: { provider: string; model: string } }): CallProvider {
  const auth = { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" };
  return {
    async place(i): Promise<PlaceResult> {
      const payload = buildVapiAuditCall({ phoneNumberId: o.phoneNumberId, toE164: i.toE164, businessName: i.businessName, auditCallId: i.auditCallId, serverUrl: o.serverUrl, serverSecret: o.serverSecret, voice: o.voice, model: o.model });
      let r: Response;
      try { r = await http("https://api.vapi.ai/call", { method: "POST", headers: auth, body: JSON.stringify(payload), timeoutMs: 15_000 }); }
      catch { throw new Error("vapi_place_unknown"); } // may have connected: caller records dial_state_unknown, NEVER retries
      if (r.status >= 400 && r.status < 500) return { ok: false, definitive: true, reason: `vapi_http_${r.status}` };
      if (!r.ok) throw new Error(`vapi_place_${r.status}`); // 5xx: state unknown
      const j = await r.json().catch(() => ({}));
      if (typeof j.id !== "string") throw new Error("vapi_place_no_id");
      return { ok: true, providerCallId: j.id };
    },
    async fetchReport(id) {
      const r = await http(`https://api.vapi.ai/call/${encodeURIComponent(id)}`, { headers: auth });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j || j.status !== "ended") return null;
      return vapiCallToReport(j);
    },
  };
}

export { timingSafeEqual };
