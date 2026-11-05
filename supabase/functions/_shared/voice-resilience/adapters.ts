// Concrete adapters behind the ports. Credentials are injected (no Deno globals) so they are unit-testable.
//
// STATUS (honest): only request-building and response-mapping are unit-tested with a fake fetch.
// NONE of these has been exercised against the live vendor API from this repo. The Telnyx adapter in
// particular needs a Telnyx account, a messaging profile and a 10DLC/toll-free registration before it can send.

import type { CarrierPort, PortHealth, ProviderCallRef, SmsPort, VoiceEnginePort } from "./providers.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function timed(fetchFn: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; ms: number }> {
  const t0 = Date.now();
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { res, ms: Date.now() - t0 };
}

const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);

// ------------------------------------------------------------------ Vapi (voice engine, primary)
export function vapiEngine(cfg: { privateKey: string; fetch?: FetchLike; baseUrl?: string }): VoiceEnginePort {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl ?? "https://api.vapi.ai";
  const hdr = { Authorization: `Bearer ${cfg.privateKey}`, "Content-Type": "application/json" };
  return {
    id: "vapi",
    capability: "voice_engine",
    async healthCheck(): Promise<PortHealth> {
      try {
        const { res, ms } = await timed(f, `${base}/call?limit=1`, { headers: hdr }, 8_000);
        return { ok: res.ok, latencyMs: ms, detail: res.ok ? undefined : `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, latencyMs: 8_000, detail: e instanceof Error ? e.message : "error" };
      }
    },
    async listCalls({ since, until, limit }): Promise<ProviderCallRef[]> {
      const qs = new URLSearchParams({ createdAtGe: since.toISOString(), createdAtLe: until.toISOString(), limit: String(Math.min(limit, 1000)) });
      const { res } = await timed(f, `${base}/call?${qs}`, { headers: hdr }, 15_000);
      if (!res.ok) throw new Error(`Vapi list calls failed (${res.status})`);
      const rows = (await res.json()) as Record<string, unknown>[];
      return (Array.isArray(rows) ? rows : []).map(mapVapiCall).filter((c): c is ProviderCallRef => c !== null);
    },
    async getCall(id) {
      const { res } = await timed(f, `${base}/call/${encodeURIComponent(id)}`, { headers: hdr }, 15_000);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Vapi get call failed (${res.status})`);
      return (await res.json()) as Record<string, unknown>;
    },
    async transfer(): Promise<void> {
      // Live transfer is implemented in live-call-control / csr-call-transfer via controlUrl (not live-verified there either).
      throw new Error("Use live-call-control for transfers");
    },
  };
}

export function mapVapiCall(r: Record<string, unknown>): ProviderCallRef | null {
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  const started = typeof r.startedAt === "string" ? r.startedAt : typeof r.createdAt === "string" ? r.createdAt : null;
  const ended = typeof r.endedAt === "string" ? r.endedAt : null;
  const s = started ? Date.parse(started) : NaN;
  const e = ended ? Date.parse(ended) : NaN;
  const type = typeof r.type === "string" ? r.type : "";
  const pn = (r.phoneNumber ?? {}) as { number?: string };
  const cust = (r.customer ?? {}) as { number?: string };
  // Only INBOUND phone calls are in scope: outbound campaigns and web calls have their own records.
  if (type && type !== "inboundPhoneCall") return null;
  return {
    providerCallId: id,
    to: pn.number ?? null,
    from: cust.number ?? null,
    startedAt: started,
    endedAt: ended,
    status: r.status === "ended" || ended ? "ended" : r.status ? "in_progress" : "unknown",
    durationSeconds: Number.isFinite(s) && Number.isFinite(e) && e >= s ? Math.round((e - s) / 1000) : null,
  };
}

// ------------------------------------------------------------------ Twilio (carrier, primary)
export function twilioCarrier(cfg: { accountSid: string; authToken: string; fetch?: FetchLike }): CarrierPort {
  const f = cfg.fetch ?? fetch;
  const base = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}`;
  const hdr = { Authorization: basic(cfg.accountSid, cfg.authToken) };
  return {
    id: "twilio",
    capability: "carrier",
    async healthCheck() {
      try {
        const { res, ms } = await timed(f, `${base}/Calls.json?PageSize=1`, { headers: hdr }, 8_000);
        return { ok: res.ok, latencyMs: ms, detail: res.ok ? undefined : `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, latencyMs: 8_000, detail: e instanceof Error ? e.message : "error" };
      }
    },
    async listCalls({ since, until, limit }) {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const qs = new URLSearchParams({ "StartTime>": day(since), "StartTime<": day(new Date(until.getTime() + 86_400_000)), PageSize: String(Math.min(limit, 1000)), Direction: "inbound" } as Record<string, string>);
      const { res } = await timed(f, `${base}/Calls.json?${qs}`, { headers: hdr }, 15_000);
      if (!res.ok) throw new Error(`Twilio list calls failed (${res.status})`);
      const body = (await res.json()) as { calls?: Record<string, unknown>[] };
      return (body.calls ?? []).map((c): ProviderCallRef => {
        const start = typeof c.start_time === "string" ? new Date(c.start_time).toISOString() : null;
        const end = typeof c.end_time === "string" ? new Date(c.end_time).toISOString() : null;
        const dur = typeof c.duration === "string" ? Number(c.duration) : null;
        return {
          providerCallId: String(c.sid), to: (c.to as string) ?? null, from: (c.from as string) ?? null, startedAt: start, endedAt: end,
          status: c.status === "completed" || c.status === "no-answer" || c.status === "busy" || c.status === "failed" || c.status === "canceled" ? "ended" : "in_progress",
          durationSeconds: dur != null && Number.isFinite(dur) ? dur : null,
        };
      });
    },
    async placeCall({ to, from, twiml, timeoutSeconds, statusCallback }) {
      const form = new URLSearchParams({ To: to, From: from, Twiml: twiml, Timeout: String(timeoutSeconds ?? 30) });
      if (statusCallback) {
        form.set("StatusCallback", statusCallback);
        for (const ev of ["ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
      }
      const { res } = await timed(f, `${base}/Calls.json`, { method: "POST", headers: { ...hdr, "Content-Type": "application/x-www-form-urlencoded" }, body: form }, 10_000);
      if (!res.ok) throw new Error(`Twilio place call failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
      const j = (await res.json()) as { sid?: string };
      if (!j.sid) throw new Error("Twilio place call: no sid");
      return { callSid: j.sid };
    },
  };
}

// ------------------------------------------------------------------ SMS: Twilio (primary) and Telnyx (secondary)
export function twilioSms(cfg: { accountSid: string; authToken: string; from: string; fetch?: FetchLike }): SmsPort {
  const f = cfg.fetch ?? fetch;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}`;
  return {
    id: "twilio",
    capability: "sms",
    async healthCheck() {
      try {
        const { res, ms } = await timed(f, `${url}.json`, { headers: { Authorization: basic(cfg.accountSid, cfg.authToken) } }, 8_000);
        return { ok: res.ok, latencyMs: ms };
      } catch (e) {
        return { ok: false, latencyMs: 8_000, detail: e instanceof Error ? e.message : "error" };
      }
    },
    async send({ to, body, from }) {
      const { res } = await timed(f, `${url}/Messages.json`, {
        method: "POST",
        headers: { Authorization: basic(cfg.accountSid, cfg.authToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: from ?? cfg.from, Body: body }),
      }, 10_000);
      if (!res.ok) throw new Error(`Twilio SMS failed (${res.status})`);
      const j = (await res.json()) as { sid?: string };
      return { providerMessageId: j.sid ?? null };
    },
  };
}

export function telnyxSms(cfg: { apiKey: string; from: string; messagingProfileId?: string; fetch?: FetchLike }): SmsPort {
  const f = cfg.fetch ?? fetch;
  const hdr = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
  return {
    id: "telnyx",
    capability: "sms",
    async healthCheck() {
      try {
        const { res, ms } = await timed(f, "https://api.telnyx.com/v2/balance", { headers: hdr }, 8_000);
        return { ok: res.ok, latencyMs: ms, detail: res.ok ? undefined : `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, latencyMs: 8_000, detail: e instanceof Error ? e.message : "error" };
      }
    },
    async send({ to, body, from }) {
      const payload: Record<string, unknown> = { from: from ?? cfg.from, to, text: body, type: "SMS" };
      if (cfg.messagingProfileId) payload.messaging_profile_id = cfg.messagingProfileId;
      const { res } = await timed(f, "https://api.telnyx.com/v2/messages", { method: "POST", headers: hdr, body: JSON.stringify(payload) }, 10_000);
      if (!res.ok) throw new Error(`Telnyx SMS failed (${res.status})`);
      const j = (await res.json()) as { data?: { id?: string } };
      return { providerMessageId: j.data?.id ?? null };
    },
  };
}

/** Send through the first working provider, in the order given (already chosen by selectProvider). */
export async function sendWithFailover(
  ports: SmsPort[], msg: { to: string; body: string },
  onOutcome?: (providerId: string, ok: boolean, latencyMs: number, error?: string) => void,
): Promise<{ ok: boolean; providerId: string | null; error?: string }> {
  let last = "no_sms_provider";
  for (const p of ports) {
    const t0 = Date.now();
    try {
      await p.send(msg);
      onOutcome?.(p.id, true, Date.now() - t0);
      return { ok: true, providerId: p.id };
    } catch (e) {
      last = e instanceof Error ? e.message : "error";
      onOutcome?.(p.id, false, Date.now() - t0, last);
    }
  }
  return { ok: false, providerId: null, error: last };
}
