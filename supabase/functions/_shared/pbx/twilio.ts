// supabase/functions/_shared/pbx/twilio.ts
// Twilio primitives: webhook signature check, REST helper, Voice SDK access token.

const enc = new TextEncoder();

async function hmac(key: string, data: string, hash: 'SHA-1' | 'SHA-256'): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** https://www.twilio.com/docs/usage/security#validating-requests */
export async function validTwilioSignature(
  url: string, params: Record<string, string>, header: string | null, authToken: string,
): Promise<boolean> {
  if (!header || !authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(b64(await hmac(authToken, data, 'SHA-1')), header);
}

export function twiml(inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

export const LEG_STATUS: Record<string, string> = {
  queued: 'queued', initiated: 'queued', ringing: 'ringing', 'in-progress': 'in_progress',
  completed: 'completed', busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled',
};

const accountSid = () => Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const basicAuth = () => 'Basic ' + btoa(`${accountSid()}:${Deno.env.get('TWILIO_AUTH_TOKEN') ?? ''}`);

export async function twilioApi(
  path: string, init: { method?: 'GET' | 'POST' | 'DELETE'; form?: Record<string, string> } = {},
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid()}/${path}`, {
    method: init.method ?? (init.form ? 'POST' : 'GET'),
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: init.form ? new URLSearchParams(init.form) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : await res.json();
}

/** Downloads a Twilio-hosted recording. Host is pinned to api.twilio.com. */
export async function twilioDownload(recordingUrl: string): Promise<Uint8Array> {
  const u = new URL(recordingUrl);
  if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com') throw new Error('Unexpected recording host');
  const res = await fetch(`${u.toString()}.mp3`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Recording download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Recording too large');
  return bytes;
}

/** Voice SDK access token (JWT, HS256) — identity is the only thing the browser can claim. */
export async function mintVoiceToken(identity: string, ttlSeconds = 3600): Promise<string> {
  const keySid = Deno.env.get('TWILIO_API_KEY_SID');
  const secret = Deno.env.get('TWILIO_API_KEY_SECRET');
  const appSid = Deno.env.get('TWILIO_TWIML_APP_SID');
  if (!keySid || !secret || !appSid) throw new Error('Twilio Voice is not configured');
  const now = Math.floor(Date.now() / 1000);
  const seg = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const input = `${seg({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' })}.${seg({
    jti: `${keySid}-${now}`, iss: keySid, sub: accountSid(), nbf: now, exp: now + ttlSeconds,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } },
  })}`;
  return `${input}.${b64url(await hmac(secret, input, 'SHA-256'))}`;
}
