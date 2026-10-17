// Stripe REST helpers for payment plans: form-encoding, idempotency keys, structured errors.

export class StripeError extends Error {
  constructor(message: string, public type: string, public code: string | null, public paymentIntentId: string | null, public status: number) {
    super(message);
  }
}

function encode(params: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams();
  const walk = (value: unknown, prefix: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${prefix}[${i}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}[${k}]`);
    else body.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return body;
}

export async function stripe(method: "GET" | "POST", path: string, secretKey: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body: method === "POST" ? encode(params ?? {}) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new StripeError(e.message || `Stripe API error (${res.status})`, e.type ?? "api_error", e.code ?? null, e.payment_intent?.id ?? null, res.status);
  }
  return data;
}
