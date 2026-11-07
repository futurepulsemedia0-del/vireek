// supabase/functions/_shared/price-book/jobberWebhook.ts
//
// Parsing + de-duplication key for Jobber webhooks. Shape per Jobber's "Setting up Webhooks" page (fetched 2026-11-03):
//   {"data":{"webHookEvent":{"topic","appId","accountId","itemId","occurredAt"}}}
// Apps created before 2023-12-08 send the misspelt `occuredAt`; both are accepted.
// Delivery is AT LEAST ONCE, so every event gets a deterministic key and is processed once.

export interface JobberWebhookEvent {
  topic: string;
  appId: string;
  accountId: string;
  itemId: string;
  occurredAt: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Returns null for anything that is not a well-formed Jobber webhook event (callers acknowledge and ignore it). */
export function parseJobberWebhook(raw: string): JobberWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const ev = (parsed as { data?: { webHookEvent?: Record<string, unknown> } } | null)?.data?.webHookEvent;
  if (!ev || typeof ev !== "object") return null;
  const topic = str(ev.topic);
  const accountId = str(ev.accountId);
  if (!topic || !accountId) return null;
  return { topic, appId: str(ev.appId), accountId, itemId: str(ev.itemId), occurredAt: str(ev.occurredAt) || str(ev.occuredAt) };
}

/** SHA-256 hex over the identifying fields; stable across redeliveries of the same event. */
export async function jobberEventKey(e: JobberWebhookEvent): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([e.topic, e.appId, e.accountId, e.itemId, e.occurredAt]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
