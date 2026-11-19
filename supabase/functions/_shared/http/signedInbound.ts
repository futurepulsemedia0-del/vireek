// supabase/functions/_shared/http/signedInbound.ts
//
// HMAC verification for Vireek-signed inbound requests (fabric-ingest, synthetic-webhook-sink).
// Pure module (no Deno / npm imports). Built on verifyWebhook() so timestamp tolerance, constant-time compare,
// secret rotation and the replay store (claim_webhook_event) behave exactly like every other inbound webhook.
//
// Wire format (sender -> us):
//   X-Vireek-Timestamp: <unix seconds>
//   X-Vireek-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
//
// Rollout is shadow-first (same idea as inboundSignature.ts): mode "shadow" logs what WOULD be rejected and lets
// the request through, mode "enforce" rejects. The default is shadow so existing senders keep working until they
// sign; flip to enforce only after the logs show no `signed_inbound_would_reject` for legitimate traffic.

import { hmacSha256, verifyWebhook, type ReplayStore } from "./webhook.ts";

export const SIG_HEADER = "x-vireek-signature";
export const TS_HEADER = "x-vireek-timestamp";

export type SignedInboundMode = "shadow" | "enforce";
export const parseMode = (v: string | null | undefined): SignedInboundMode => (v === "enforce" ? "enforce" : "shadow");

export interface Verdict { ok: boolean; reason?: string }

/** Per-connection signing secret derived from a master key: nothing extra to store, rotation = change the master key. */
export async function deriveSigningSecret(masterKey: string, scope: string): Promise<string> {
  return hmacSha256(masterKey, `vireek-signed-inbound-v1:${scope}`, "hex");
}

/** What a sender computes. Exported so tests (and operators' scripts) use the same code path. */
export async function signRequest(secret: string, rawBody: string, timestampSeconds: number): Promise<Record<string, string>> {
  return {
    [TS_HEADER]: String(timestampSeconds),
    [SIG_HEADER]: `sha256=${await hmacSha256(secret, `${timestampSeconds}.${rawBody}`, "hex")}`,
  };
}

export async function verifyInboundSignature(o: {
  provider: string;
  rawBody: string;
  headers: Headers;
  secrets: ReadonlyArray<string | null | undefined>;
  replay: ReplayStore;
  toleranceSeconds?: number;
  now?: () => number;
}): Promise<Verdict> {
  const header = o.headers.get(SIG_HEADER) ?? "";
  const signature = header.toLowerCase().startsWith("sha256=") ? header.slice(7).trim().toLowerCase() : "";
  try {
    await verifyWebhook({
      provider: o.provider,
      secrets: o.secrets,
      signature: signature || null,
      encoding: "hex",
      timestamp: o.headers.get(TS_HEADER),
      signedPayload: (ts) => `${ts}.${o.rawBody}`,
      toleranceSeconds: o.toleranceSeconds ?? 300,
      now: o.now,
      eventId: signature || null,
      replay: o.replay,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "rejected";
    return { ok: false, reason: msg.replace(/^Webhook rejected: /, "").replace(/\.$/, "").slice(0, 80) };
  }
}

/** Returns a Response to send (reject) or null to continue. Never logs payloads or secrets. */
export function applySignedInboundPolicy(provider: string, verdict: Verdict, mode: SignedInboundMode): Response | null {
  if (verdict.ok) return null;
  console.warn(JSON.stringify({ event: mode === "enforce" ? "signed_inbound_rejected" : "signed_inbound_would_reject", provider, reason: verdict.reason, mode }));
  return mode === "enforce"
    ? new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401, headers: { "Content-Type": "application/json" } })
    : null;
}
