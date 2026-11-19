// _shared/http/webhookGuard.ts — replay protection for inbound provider webhooks: freshness + exactly-once handling.
// Complements webhook.ts (verifyWebhook keeps its permanent claim). Same state machine as claim_billing_event().
import { constantTimeEqual } from "./core.ts";
import { hmacSha256 } from "./webhook.ts";
import type { RpcClient } from "./rateLimit.ts";

export type ClaimOutcome = "new" | "retry" | "duplicate" | "in_progress";

export interface WebhookEventStore {
  begin(provider: string, eventId: string, leaseSeconds?: number): Promise<ClaimOutcome>;
  finish(provider: string, eventId: string, error?: string | null): Promise<void>;
}

const OUTCOMES: ReadonlySet<string> = new Set(["new", "retry", "duplicate", "in_progress"]);

export function dbWebhookEventStore(db: RpcClient): WebhookEventStore {
  return {
    async begin(provider, eventId, leaseSeconds = 300) {
      const { data, error } = await db.rpc("begin_webhook_event", { p_provider: provider, p_event_id: eventId, p_lease_seconds: leaseSeconds });
      if (error || typeof data !== "string" || !OUTCOMES.has(data)) throw new Error("webhook event store unavailable");
      return data as ClaimOutcome;
    },
    async finish(provider, eventId, error = null) {
      const { error: e } = await db.rpc("finish_webhook_event", { p_provider: provider, p_event_id: eventId, p_error: error });
      if (e) throw new Error("webhook event store unavailable");
    },
  };
}

export interface FreshnessOptions {
  toleranceSeconds?: number;
  now?: () => number;
}

export function isFresh(timestampSeconds: number, o: FreshnessOptions = {}): boolean {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return false;
  const nowSeconds = (o.now ?? (() => Date.now()))() / 1000;
  return Math.abs(nowSeconds - timestampSeconds) <= (o.toleranceSeconds ?? 300);
}

export function parseStripeStyleHeader(header: string | null | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > 2048) return null;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v.toLowerCase());
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0 || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: "no_secret" | "bad_header" | "stale_timestamp" | "bad_signature" };

export async function verifyStripeStyleSignature(o: {
  payload: string;
  header: string | null | undefined;
  secrets: ReadonlyArray<string | null | undefined>;
} & FreshnessOptions): Promise<SignatureResult> {
  const secrets = o.secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };
  const parsed = parseStripeStyleHeader(o.header);
  if (!parsed) return { ok: false, reason: "bad_header" };
  if (!isFresh(parsed.timestamp, o)) return { ok: false, reason: "stale_timestamp" };
  let ok = false;
  for (const secret of secrets) {
    const expected = await hmacSha256(secret, `${parsed.timestamp}.${o.payload}`, "hex");
    for (const sig of parsed.signatures) ok = constantTimeEqual(sig, expected) || ok;
  }
  return ok ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "bad_signature" };
}

export async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RunOnceOptions {
  store: WebhookEventStore;
  provider: string;
  eventId: string;
  leaseSeconds?: number;
  headers?: Record<string, string>;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const log = (event: string, fields: Record<string, unknown>) => console.warn(JSON.stringify({ event, ...fields }));

export async function runOnce(o: RunOnceOptions, handler: () => Promise<Response>): Promise<Response> {
  const h = o.headers ?? {};
  let outcome: ClaimOutcome;
  try {
    outcome = await o.store.begin(o.provider, o.eventId, o.leaseSeconds);
  } catch {
    log("webhook_replay_store_unavailable", { provider: o.provider });
    return jsonResponse(503, { error: "temporarily_unavailable" }, { "Retry-After": "30", ...h });
  }
  if (outcome === "duplicate") {
    log("webhook_replay_duplicate", { provider: o.provider });
    return jsonResponse(200, { received: true, duplicate: true }, h);
  }
  if (outcome === "in_progress") {
    log("webhook_replay_in_progress", { provider: o.provider });
    return jsonResponse(409, { error: "event_in_progress" }, { "Retry-After": "5", ...h });
  }

  let res: Response;
  let failure: string | null = null;
  try {
    res = await handler();
    if (res.status >= 500) failure = `http_${res.status}`;
  } catch (e) {
    failure = e instanceof Error ? e.message.slice(0, 500) : "handler_threw";
    log("webhook_handler_failed", { provider: o.provider, error: failure });
    res = jsonResponse(500, { error: "internal" }, h);
  }
  try {
    await o.store.finish(o.provider, o.eventId, failure);
  } catch {
    log("webhook_replay_finish_failed", { provider: o.provider, failed: failure !== null });
  }
  return res;
}
