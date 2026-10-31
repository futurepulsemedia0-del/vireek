// Entry-point logic of the Vapi webhook, extracted from vapi-webhook/index.ts so it can be tested
// without Deno. Behaviour is unchanged except: constant-time secret check, body-size cap, and
// every handler failure is logged to webhook_logs as an error.
import { parseVapiBody, verifyVapiSecret } from "./webhookAuth.ts";

/** Every Vapi message.type this function acts on, and which handler owns it. Anything else is acknowledged (200) and ignored. */
export const HANDLED_EVENTS = {
  "assistant-request": "assistantRequest",
  "transfer-destination-request": "transfer",
  "tool-calls": "toolCalls",
  "status-update": "lifecycle",
  "end-of-call-report": "lifecycle",
  "hang": "lifecycle",
  "speech-update": "lifecycle",
} as const;

export type HandlerKey = (typeof HANDLED_EVENTS)[keyof typeof HANDLED_EVENTS];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-vapi-secret",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

type Handler<A, M> = (admin: A, message: M, requestId: string) => Promise<Response>;

export interface WebhookPorts<A, M extends { type?: string }> {
  getEnv(name: string): string | undefined;
  createAdmin(url: string, serviceRoleKey: string): A;
  newRequestId(): string;
  logEvent(event: string, requestId: string, extra?: Record<string, unknown>): void;
  logError(event: string, requestId: string, error: unknown, extra?: Record<string, unknown>): void;
  logToDb(admin: A, opts: { eventType: string; status: "success" | "error"; requestId: string; errorMessage?: string }): Promise<void>;
  trackLiveCall(admin: A, message: M, requestId: string): Promise<void>;
  handlers: Record<HandlerKey, Handler<A, M>>;
}

export async function processWebhook<A, M extends { type?: string }>(req: Request, ports: WebhookPorts<A, M>): Promise<Response> {
  const requestId = ports.newRequestId();

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expectedSecret = ports.getEnv("VAPI_SERVER_SECRET");
  if (!expectedSecret) {
    ports.logError("config_error_missing_secret", requestId, "VAPI_SERVER_SECRET is not set");
    return json({ error: "Server not configured" }, 500);
  }
  if (!verifyVapiSecret(req.headers.get("x-vapi-secret"), expectedSecret)) {
    ports.logEvent("unauthorized_request", requestId, {});
    return json({ error: "Unauthorized" }, 401);
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch (error) {
    ports.logError("invalid_json_body", requestId, error);
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseVapiBody(raw);
  if (!parsed.ok) {
    ports.logEvent("malformed_payload", requestId, { reason: parsed.error });
    return json({ error: parsed.error }, parsed.status);
  }
  const message = parsed.message as unknown as M & { type: string };

  const supabaseUrl = ports.getEnv("SUPABASE_URL");
  const serviceRoleKey = ports.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    ports.logError("config_error_missing_supabase_env", requestId, "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    return json({ error: "Server not configured" }, 500);
  }
  const admin = ports.createAdmin(supabaseUrl, serviceRoleKey);

  ports.logEvent("webhook_received", requestId, { type: message.type });
  await ports.logToDb(admin, { eventType: message.type, status: "success", requestId });
  try {
    await ports.trackLiveCall(admin, message, requestId);
  } catch (error) {
    ports.logError("live_call_tracking_failed", requestId, error, { type: message.type });
  }

  const key = (HANDLED_EVENTS as Record<string, HandlerKey | undefined>)[message.type];
  if (!key) {
    ports.logEvent("unhandled_event_type", requestId, { type: message.type });
    return json({ received: true });
  }

  try {
    return await ports.handlers[key](admin, message, requestId);
  } catch (error) {
    ports.logError("unhandled_exception", requestId, error, { type: message.type });
    await ports.logToDb(admin, {
      eventType: message.type,
      status: "error",
      requestId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "Internal server error" }, 500);
  }
}
