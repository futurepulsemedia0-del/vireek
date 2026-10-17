// supabase/functions/_shared/notify/fcm.ts
//
// Firebase Cloud Messaging (HTTP v1) sender for the native iOS / Android app.
// Secret (supabase secrets set FCM_SERVICE_ACCOUNT_JSON='<service-account JSON>'):
//   Firebase console → Project settings → Service accounts → Generate new private key.

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export type FcmResult = { ok: true } | { ok: false; unregistered: boolean };

let account: ServiceAccount | null | undefined;
let cached: { token: string; exp: number } | null = null;

function loadAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  try {
    const parsed = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON") ?? "null") as Partial<ServiceAccount> | null;
    account = parsed?.project_id && parsed.client_email && parsed.private_key ? (parsed as ServiceAccount) : null;
  } catch {
    account = null;
  }
  return account;
}

export function isFcmConfigured(): boolean {
  return loadAccount() !== null;
}

function b64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(a: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: a.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const pem = a.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`fcm_oauth_${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, exp: now + json.expires_in };
  return json.access_token;
}

export async function sendFcm(token: string, m: FcmMessage): Promise<FcmResult> {
  const a = loadAccount();
  if (!a) return { ok: false, unregistered: false };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(a)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: m.title, body: m.body },
        data: { url: m.url, tag: m.tag },
        android: { priority: "HIGH", notification: { tag: m.tag } },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
      },
    }),
  });
  if (res.ok) return { ok: true };

  let code = "";
  try {
    const json = (await res.json()) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
    code = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status ?? "";
  } catch {
    /* non-JSON error body */
  }
  return { ok: false, unregistered: res.status === 404 || code === "UNREGISTERED" };
}
