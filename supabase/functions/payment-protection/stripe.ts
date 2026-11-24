// Minimal Stripe REST helper for payment protection: Connect header, idempotency keys, query-string GET, typed errors.
// Deliberately separate from _shared/disputes/stripeApi.ts, which has no idempotency support.

export class StripeApiError extends Error {
  constructor(public status: number, public code: string | null, message: string) {
    super(message);
  }
  /** True when Stripe definitively rejected the request (safe to treat as failed, not retry). */
  get definitive(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

function flatten(value: unknown, prefix: string, out: URLSearchParams) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, `${prefix}[${k}]`, out);
  else out.append(prefix, String(value));
}

export async function stripe<T = any>(
  method: "GET" | "POST",
  path: string,
  secretKey: string,
  opts: { params?: Record<string, unknown>; account?: string | null; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (opts.account) headers["Stripe-Account"] = opts.account;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params ?? {})) flatten(v, k, qs);
  let url = `https://api.stripe.com/v1/${path}`;
  let body: string | undefined;
  if (method === "GET") {
    const s = qs.toString();
    if (s) url += `?${s}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = qs.toString();
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    // Network error / timeout: the outcome is UNKNOWN. Status 0 is never "definitive".
    throw new StripeApiError(0, null, `Stripe request failed: ${(e as Error).message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeApiError(res.status, data?.error?.code ?? null, data?.error?.message ?? `Stripe API error (${res.status})`);
  return data as T;
}
