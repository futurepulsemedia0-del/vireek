// Pure helpers for US address verification through Lob (POST https://api.lob.com/v1/us_verifications).
// No Deno / Node APIs beyond fetch + btoa, so the edge function, the dashboard and vitest share ONE implementation.
//
// NOT LIVE-VERIFIED: written from Lob's public documentation and exercised only against mocked responses.
// Run a real test-mode check (docs/DIRECT_MAIL.md -> "Verify before the first live send") before relying on it.

export type VerificationStatus = "unverified" | "deliverable" | "review" | "undeliverable";
export type VerificationResult = Exclude<VerificationStatus, "unverified">;

export interface VerificationOutcome {
  status: VerificationResult;
  note: string | null;
}

export interface VerifyAddressInput {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

const MAP: Record<string, VerificationOutcome> = {
  deliverable: { status: "deliverable", note: null },
  deliverable_unnecessary_unit: { status: "deliverable", note: "The unit number is not needed for this address." },
  deliverable_incorrect_unit: { status: "review", note: "The unit number does not match USPS records." },
  deliverable_missing_unit: { status: "review", note: "USPS expects a unit or apartment number." },
  undeliverable: { status: "undeliverable", note: "USPS could not match this as a deliverable address." },
};

/** Unknown / missing values are NEVER treated as deliverable and never block mail: they ask for a human look. */
export function classifyDeliverability(value: unknown): VerificationOutcome {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MAP[key] ?? { status: "review", note: "The address check returned an unexpected result." };
}

/** Test-mode answers are simulated by the provider, so they are shown but never remove a recipient. */
export function blocksSending(apiMode: string | null | undefined): boolean {
  return apiMode === "live";
}

export function buildVerificationBody(a: VerifyAddressInput): Record<string, string> {
  const body: Record<string, string> = {
    primary_line: a.line1.trim(),
    city: a.city.trim(),
    state: a.state.trim().toUpperCase(),
    zip_code: a.zip.trim(),
  };
  const line2 = (a.line2 ?? "").trim();
  if (line2) body.secondary_line = line2;
  return body;
}

/** Returns null when the response is not a usable verification (treated as a retryable provider problem). */
export function parseVerificationResponse(data: unknown): VerificationOutcome | null {
  if (!data || typeof data !== "object") return null;
  const d = (data as { deliverability?: unknown }).deliverability;
  if (typeof d !== "string" || d.trim() === "") return null;
  return classifyDeliverability(d);
}

export type VerifyCallResult =
  | { kind: "ok"; outcome: VerificationOutcome }
  | { kind: "auth" }
  | { kind: "retry"; message: string }
  | { kind: "failed"; message: string };

interface VerifyOptions {
  fetchImpl: typeof fetch;
  apiKey: string;
  address: VerifyAddressInput;
  version?: string | null;
  timeoutMs?: number;
}

/** One verification call. Never throws: every failure is returned as a typed result. */
export async function verifyAddressWithLob(opts: VerifyOptions): Promise<VerifyCallResult> {
  try {
    const res = await opts.fetchImpl("https://api.lob.com/v1/us_verifications", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${opts.apiKey}:`)}`,
        "Content-Type": "application/json",
        ...(opts.version ? { "Lob-Version": opts.version } : {}),
      },
      body: JSON.stringify(buildVerificationBody(opts.address)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    const message = String((data as { error?: { message?: unknown } } | null)?.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
    if (res.ok) {
      const outcome = parseVerificationResponse(data);
      return outcome ? { kind: "ok", outcome } : { kind: "retry", message: "Unreadable response from the address checker." };
    }
    // 422 = Lob rejected the input itself: a deterministic answer, so ask for a human look instead of retrying forever.
    if (res.status === 422) return { kind: "ok", outcome: { status: "review", note: message } };
    if (res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500) {
      return { kind: "retry", message };
    }
    return { kind: "failed", message };
  } catch (e) {
    return { kind: "retry", message: e instanceof Error ? e.message.slice(0, 300) : "network_error" };
  }
}
