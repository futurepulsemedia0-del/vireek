// supabase/functions/_shared/http/inboundSignature.ts
// Shared helpers for inbound provider webhooks that lacked verification (Meta/WhatsApp, Twilio SMS).
// Rollout is shadow-first: WEBHOOK_SIG_MODE=shadow (default) logs what WOULD be rejected and lets the
// request through; WEBHOOK_SIG_MODE=enforce rejects. Flip to enforce only after shadow logs show 0
// `webhook_sig_would_reject` for legitimate traffic.
import { constantTimeEqual } from "./core.ts";
import { hmacSha256 } from "./webhook.ts";

export type SigMode = "shadow" | "enforce";
export const sigMode = (): SigMode => (Deno.env.get("WEBHOOK_SIG_MODE") === "enforce" ? "enforce" : "shadow");

/** Meta (WhatsApp/Messenger) signature: header `X-Hub-Signature-256: sha256=<hex hmac(appSecret, rawBody)>`. */
export async function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecrets: ReadonlyArray<string | null | undefined>,
): Promise<{ ok: boolean; reason?: string }> {
  const secrets = appSecrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no app secret configured" };
  if (!header || !header.startsWith("sha256=")) return { ok: false, reason: "missing or malformed signature" };
  const sent = header.slice(7).trim().toLowerCase();
  let ok = false;
  for (const s of secrets) ok = constantTimeEqual(sent, await hmacSha256(s, rawBody, "hex")) || ok;
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}

/**
 * Applies shadow/enforce policy. Returns a Response to send (reject) or null to continue.
 * Never logs payloads or secrets.
 */
export function applySigPolicy(provider: string, result: { ok: boolean; reason?: string }): Response | null {
  if (result.ok) return null;
  const mode = sigMode();
  console.warn(JSON.stringify({
    event: mode === "enforce" ? "webhook_sig_rejected" : "webhook_sig_would_reject",
    provider, reason: result.reason, mode,
  }));
  return mode === "enforce" ? new Response("Forbidden", { status: 403 }) : null;
}
