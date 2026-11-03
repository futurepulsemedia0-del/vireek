// supabase/functions/_shared/notify/apns.ts — direct APNs sender for Live Activities (FCM cannot deliver these).
// Secrets: APNS_KEY_P8 (contents of AuthKey_XXXX.p8), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (com.vireek.field),
//          APNS_ENV = "production" | "sandbox" (default production).
// NOT LIVE-VERIFIED: needs a real device + APNs key. Request shapes follow Apple's documented ActivityKit push format.

import type { LiveState } from "./liveSurface.ts";

let cachedJwt: { token: string; iat: number } | null = null;

function b64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isApnsConfigured(): boolean {
  return !!(Deno.env.get("APNS_KEY_P8") && Deno.env.get("APNS_KEY_ID") && Deno.env.get("APNS_TEAM_ID") && Deno.env.get("APNS_BUNDLE_ID"));
}

async function providerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.iat < 40 * 60) return cachedJwt.token; // Apple: refresh between 20 and 60 min
  const header = b64url(JSON.stringify({ alg: "ES256", kid: Deno.env.get("APNS_KEY_ID") }));
  const claims = b64url(JSON.stringify({ iss: Deno.env.get("APNS_TEAM_ID"), iat: now }));
  const pem = (Deno.env.get("APNS_KEY_P8") ?? "").replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  const token = `${header}.${claims}.${b64url(sig)}`; // WebCrypto returns raw r||s, which is what JWT ES256 needs
  cachedJwt = { token, iat: now };
  return token;
}

export function contentState(s: LiveState) {
  return { stage: s.stage, emergency: s.emergency, headline: s.headline, detail: s.detail,
           startedAt: Math.floor(s.startedAtMs / 1000) };
}

export type ApnsLiveKind = "start" | "update" | "end";

export function buildLiveActivityPayload(kind: ApnsLiveKind, s: LiveState, nowSec: number, dismissalSec?: number) {
  const aps: Record<string, unknown> = {
    timestamp: nowSec,
    event: kind === "start" ? "start" : kind === "end" ? "end" : "update",
    "content-state": contentState(s),
  };
  if (kind === "start") {
    aps["attributes-type"] = "VireekCallAttributes";
    aps["attributes"] = { callId: s.callId };
    aps["alert"] = { title: s.headline, body: s.detail };
    aps["interruption-level"] = s.emergency ? "time-sensitive" : "active";
  }
  if (kind === "end" && dismissalSec) aps["dismissal-date"] = dismissalSec;
  return { aps };
}

export type ApnsResult = { ok: true } | { ok: false; gone: boolean; status: number };

export async function sendLiveActivity(token: string, kind: ApnsLiveKind, s: LiveState, dismissalSec?: number): Promise<ApnsResult> {
  const host = Deno.env.get("APNS_ENV") === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const res = await fetch(`https://${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await providerToken()}`,
      "apns-topic": `${Deno.env.get("APNS_BUNDLE_ID")}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildLiveActivityPayload(kind, s, Math.floor(Date.now() / 1000), dismissalSec)),
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return { ok: true };
  return { ok: false, gone: res.status === 410 || res.status === 400, status: res.status };
}
