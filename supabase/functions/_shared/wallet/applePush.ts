// supabase/functions/_shared/wallet/applePush.ts
//
// Wallet "pass changed" push: an EMPTY JSON payload to APNs for the device's push token, topic = passTypeIdentifier,
// authenticated with the Pass Type ID certificate as a TLS client certificate. The device then calls our web
// service to fetch the updated pass. APNs requires HTTP/2.

import { normalizePem } from "./applePkpass.ts";

export interface ApnsResult { ok: boolean; status: number; gone: boolean; detail?: string }
export interface ApnsCreds { certPem: string; keyPem: string; passTypeIdentifier: string }

const APNS_HOST = "api.push.apple.com";

type DenoWithClient = typeof Deno & { createHttpClient?: (o: { cert: string; key: string }) => unknown };

// deno-lint-ignore no-explicit-any
let cachedClient: any = null;
let cachedFor = "";

// deno-lint-ignore no-explicit-any
function viaFetch(token: string, c: ApnsCreds): Promise<ApnsResult> | null {
  const d = Deno as DenoWithClient;
  if (typeof d.createHttpClient !== "function") return null;
  if (!cachedClient || cachedFor !== c.certPem) {
    cachedClient = d.createHttpClient({ cert: normalizePem(c.certPem), key: normalizePem(c.keyPem) });
    cachedFor = c.certPem;
  }
  return (async () => {
    const res = await fetch(`https://${APNS_HOST}/3/device/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "apns-topic": c.passTypeIdentifier },
      body: "{}",
      // deno-lint-ignore no-explicit-any
      client: cachedClient,
    } as RequestInit & { client: any });
    const text = res.ok ? "" : await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, gone: res.status === 410, detail: text.slice(0, 200) || undefined };
  })();
}

async function viaHttp2(token: string, c: ApnsCreds): Promise<ApnsResult> {
  const http2 = await import("node:http2");
  return await new Promise<ApnsResult>((resolve) => {
    const session = http2.connect(`https://${APNS_HOST}`, { cert: normalizePem(c.certPem), key: normalizePem(c.keyPem) });
    const done = (r: ApnsResult) => { try { session.close(); } catch { /* ignore */ } resolve(r); };
    session.on("error", (e: Error) => done({ ok: false, status: 0, gone: false, detail: e.message }));
    const req = session.request({ ":method": "POST", ":path": `/3/device/${token}`, "apns-topic": c.passTypeIdentifier });
    let status = 0;
    let body = "";
    req.on("response", (h: Record<string, unknown>) => { status = Number(h[":status"] ?? 0); });
    req.on("data", (chunk: Uint8Array) => { body += new TextDecoder().decode(chunk); });
    req.on("end", () => done({ ok: status === 200, status, gone: status === 410, detail: body.slice(0, 200) || undefined }));
    req.on("error", (e: Error) => done({ ok: false, status, gone: false, detail: e.message }));
    req.end("{}");
  });
}

export async function sendApnsPush(token: string, creds: ApnsCreds): Promise<ApnsResult> {
  try {
    return (await viaFetch(token, creds)) ?? (await viaHttp2(token, creds));
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
