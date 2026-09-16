// Minimal Stripe REST client for Deno edge functions — no SDK. Stripe's
// API takes application/x-www-form-urlencoded with bracket notation for
// nested objects/arrays, so flatten() builds that from a plain object.

function flatten(params: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object") out.push(...flatten(item as Record<string, unknown>, `${path}[${i}]`));
        else out.push([`${path}[${i}]`, String(item)]);
      });
    } else if (typeof value === "object") {
      out.push(...flatten(value as Record<string, unknown>, path));
    } else {
      out.push([path, String(value)]);
    }
  }
  return out;
}

export async function stripeRequest(
  path: string,
  params: Record<string, unknown>,
  secretKey: string,
): Promise<any> {
  const body = new URLSearchParams(flatten(params));
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe API error (${res.status})`);
  return data;
}

// Verifies a Stripe webhook signature without the Stripe SDK.
// Header format: "t=<unix ts>,v1=<hex hmac>[,v0=...]"
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}
