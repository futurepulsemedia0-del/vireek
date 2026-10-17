// Small Stripe REST helpers for disputes (GET + multipart upload + optional Connect header).
// The shared stripeRequest() only POSTs form bodies on the platform account, so these live here.

export async function stripeCall(
  method: "GET" | "POST",
  path: string,
  secretKey: string,
  params?: Record<string, unknown>,
  stripeAccount?: string | null,
): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  let body: URLSearchParams | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams();
    const walk = (value: unknown, prefix: string) => {
      if (value === undefined || value === null) return;
      if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}[${k}]`);
      else body!.append(prefix, String(value));
    };
    for (const [k, v] of Object.entries(params ?? {})) walk(v, k);
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe API error (${res.status})`);
  return data;
}

export async function stripeUploadEvidenceFile(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  secretKey: string,
  stripeAccount?: string | null,
): Promise<string> {
  const form = new FormData();
  form.append("purpose", "dispute_evidence");
  form.append("file", new Blob([bytes], { type: mimeType }), fileName);
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const res = await fetch("https://files.stripe.com/v1/files", { method: "POST", headers, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) throw new Error(data?.error?.message || `Stripe file upload failed (${res.status})`);
  return data.id as string;
}
