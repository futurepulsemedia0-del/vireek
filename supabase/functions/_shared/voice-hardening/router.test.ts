import { describe, expect, it, vi } from "vitest";
import { HANDLED_EVENTS, processWebhook, type WebhookPorts } from "./router.ts";

type Msg = { type?: string; call?: { id?: string } };
const SECRET = "s3cret-value";

function makePorts(over: Partial<WebhookPorts<string, Msg>> = {}) {
  const calls: string[] = [];
  const handler = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
      return new Response(JSON.stringify({ handled: name }), { status: 200 });
    });
  const handlers = {
    assistantRequest: handler("assistantRequest"),
    transfer: handler("transfer"),
    toolCalls: handler("toolCalls"),
    lifecycle: handler("lifecycle"),
  };
  const env: Record<string, string | undefined> = { VAPI_SERVER_SECRET: SECRET, SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k" };
  const ports: WebhookPorts<string, Msg> = {
    getEnv: (n) => env[n],
    createAdmin: () => "admin",
    newRequestId: () => "req-1",
    logEvent: vi.fn(),
    logError: vi.fn(),
    logToDb: vi.fn(async () => {}),
    trackLiveCall: vi.fn(async () => {}),
    handlers,
    ...over,
  };
  return { ports, handlers, calls, env };
}

const post = (body: unknown, headers: Record<string, string> = { "x-vapi-secret": SECRET }) =>
  new Request("https://f.test/vapi-webhook", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("webhook secret verification", () => {
  it("401 when header missing, wrong, or empty — no handler, no DB client, no log row", async () => {
    for (const headers of [{}, { "x-vapi-secret": "nope" }, { "x-vapi-secret": "" }, { "x-vapi-secret": SECRET + "x" }, { "x-vapi-secret": SECRET.slice(0, -1) }]) {
      const { ports, calls } = makePorts();
      const createAdmin = vi.spyOn(ports, "createAdmin");
      const res = await processWebhook(post({ message: { type: "end-of-call-report" } }, headers), ports);
      expect(res.status).toBe(401);
      expect(calls).toEqual([]);
      expect(createAdmin).not.toHaveBeenCalled();
      expect(ports.logToDb).not.toHaveBeenCalled();
    }
  });
  it("500 (fail closed) when VAPI_SERVER_SECRET is not configured, even if the header is empty-equal", async () => {
    const { ports, env, calls } = makePorts();
    env.VAPI_SERVER_SECRET = undefined;
    const res = await processWebhook(post({ message: { type: "hang" } }, { "x-vapi-secret": "" }), ports);
    expect(res.status).toBe(500);
    expect(calls).toEqual([]);
  });
  it("500 when Supabase env is missing", async () => {
    const { ports, env } = makePorts();
    env.SUPABASE_SERVICE_ROLE_KEY = undefined;
    expect((await processWebhook(post({ message: { type: "hang" } }), ports)).status).toBe(500);
  });
  it("405 for GET, 200 for OPTIONS preflight", async () => {
    const { ports } = makePorts();
    expect((await processWebhook(new Request("https://f.test/", { method: "GET" }), ports)).status).toBe(405);
    expect((await processWebhook(new Request("https://f.test/", { method: "OPTIONS" }), ports)).status).toBe(200);
  });
});

describe("malformed payloads", () => {
  it.each([
    ["not json", "{oops", 400],
    ["empty body", "", 400],
    ["json null", "null", 400],
    ["no message", { foo: 1 }, 400],
    ["message is array", { message: [] }, 400],
    ["message is string", { message: "x" }, 400],
    ["no type", { message: {} }, 400],
    ["type not a string", { message: { type: 5 } }, 400],
    ["empty type", { message: { type: "" } }, 400],
    ["huge type", { message: { type: "x".repeat(101) } }, 400],
    ["oversized body", JSON.stringify({ message: { type: "hang", pad: "x".repeat(2_000_001) } }), 413],
  ])("%s -> %i without invoking handlers", async (_n, body, status) => {
    const { ports, calls } = makePorts();
    const res = await processWebhook(post(body as string | object), ports);
    expect(res.status).toBe(status);
    expect(calls).toEqual([]);
  });
});

describe("event routing — every handled event type reaches exactly its handler", () => {
  for (const [type, key] of Object.entries(HANDLED_EVENTS)) {
    it(`${type} -> ${key}`, async () => {
      const { ports, handlers, calls } = makePorts();
      const res = await processWebhook(post({ message: { type, call: { id: "c1" } } }), ports);
      expect(res.status).toBe(200);
      expect(calls).toEqual([key]);
      expect(handlers[key]).toHaveBeenCalledWith("admin", expect.objectContaining({ type }), "req-1");
      expect(ports.trackLiveCall).toHaveBeenCalledTimes(1);
    });
  }
  it("covers exactly the 7 documented types", () => {
    expect(Object.keys(HANDLED_EVENTS).sort()).toEqual(
      ["assistant-request", "end-of-call-report", "hang", "speech-update", "status-update", "tool-calls", "transfer-destination-request"],
    );
  });
  it.each(["transcript", "conversation-update", "model-output", "voice-input", "totally-new"])("unknown type %s is acknowledged 200 and ignored", async (type) => {
    const { ports, calls } = makePorts();
    const res = await processWebhook(post({ message: { type } }), ports);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(calls).toEqual([]);
    expect(ports.trackLiveCall).toHaveBeenCalled(); // live-call tracker still sees transcript-style events
  });
});

describe("failure handling", () => {
  it("handler exception -> 500, error logged to DB, no secret/PII in response", async () => {
    const { ports, handlers } = makePorts();
    handlers.lifecycle.mockRejectedValueOnce(new Error("db down"));
    const res = await processWebhook(post({ message: { type: "end-of-call-report", call: { id: "c1" } } }), ports);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(ports.logToDb).toHaveBeenLastCalledWith("admin", expect.objectContaining({ status: "error", errorMessage: "db down", eventType: "end-of-call-report" }));
  });
  it("live-call tracker throwing never blocks the real handler", async () => {
    const { ports, calls } = makePorts({ trackLiveCall: vi.fn(async () => { throw new Error("live table missing"); }) });
    const res = await processWebhook(post({ message: { type: "tool-calls" } }), ports);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["toolCalls"]);
    expect(ports.logError).toHaveBeenCalledWith("live_call_tracking_failed", "req-1", expect.any(Error), expect.anything());
  });
  it("handler 500 responses (e.g. persist failed -> provider retry) are passed through unchanged", async () => {
    const { ports, handlers } = makePorts();
    handlers.lifecycle.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect((await processWebhook(post({ message: { type: "end-of-call-report" } }), ports)).status).toBe(500);
  });
});
