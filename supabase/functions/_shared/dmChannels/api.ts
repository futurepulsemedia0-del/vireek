// supabase/functions/_shared/dmChannels/api.ts
//
// HTTP calls to Telegram's Bot API and Meta's Graph API. Network I/O only; the pure
// decisions (validation, error classification) live in ./protocol.ts.

import { classifyMessengerError, classifyTelegramError, DEFAULT_GRAPH_VERSION, type SendResult } from "./protocol.ts";

const TIMEOUT_MS = 10_000;

export function graphBase(): string {
  const v = (Deno.env.get("META_GRAPH_VERSION") ?? "").trim();
  return `https://graph.facebook.com/${/^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION}`;
}

// ------------------------------- Telegram ---------------------------------

export interface TelegramResponse<T = unknown> { ok: boolean; status: number; result?: T; description?: string }

export async function telegramApi<T = unknown>(token: string, method: string, payload: Record<string, unknown> = {}): Promise<TelegramResponse<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    return { ok: res.ok && json.ok === true, status: res.status, result: json.result, description: json.description };
  } catch (e) {
    return { ok: false, status: 0, description: e instanceof Error ? e.message : "network error" };
  }
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<SendResult> {
  const r = await telegramApi<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text });
  if (r.ok && r.result) return { ok: true, providerMessageId: String(r.result.message_id) };
  const c = classifyTelegramError(r.status, r.description);
  return { ok: false, code: c.code, message: c.message };
}

// ------------------------------- Messenger --------------------------------

interface GraphError { error?: { code?: number; error_subcode?: number; message?: string } }

export async function graphRequest<T = Record<string, unknown>>(
  pageToken: string, path: string, init: { method?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; data: T & GraphError }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${pageToken}` };
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  if (init.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(init.form).toString(); }
  try {
    const res = await fetch(`${graphBase()}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => ({})) as T & GraphError;
    return { ok: res.ok && !data.error, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: { message: e instanceof Error ? e.message : "network error" } } as T & GraphError };
  }
}

export async function sendMessenger(pageToken: string, psid: string, text: string): Promise<SendResult> {
  const r = await graphRequest<{ message_id?: string }>(pageToken, "/me/messages", {
    json: { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } },
  });
  if (r.ok && r.data.message_id) return { ok: true, providerMessageId: r.data.message_id };
  const c = classifyMessengerError(r.data.error?.code, r.data.error?.error_subcode);
  return { ok: false, code: c.code, message: c.message };
}

/** Best-effort display name for a PSID (User Profile API). Never throws. */
export async function fetchMessengerName(pageToken: string, psid: string): Promise<string | null> {
  const r = await graphRequest<{ first_name?: string; last_name?: string; name?: string }>(
    pageToken, `/${encodeURIComponent(psid)}?fields=first_name,last_name`,
  );
  if (!r.ok) return null;
  const name = [r.data.first_name, r.data.last_name].filter(Boolean).join(" ").trim() || r.data.name?.trim();
  return name || null;
}
