// supabase/functions/consumer-agent/index.ts
//
// PUBLIC Consumer Agent surface (v1). Separate from the owner-authenticated mcp-server.
//
//   GET  /v1/health
//   GET  /v1/challenge                      proof-of-work challenge for unsigned agents
//   GET  /v1/requests/:requestId.:token     PII-free status of one request
//   GET  /v1/b/:slug/profile.json | llms.txt | jsonld | agent-card.json
//   POST /v1/b/:slug/mcp                    MCP Streamable HTTP (JSON responses), tools: 4
//   POST /v1/b/:slug/a2a                    A2A JSON-RPC: message/send, tasks/get
//   slug "vireek-sandbox"                   fixture business, never writes
//
// Secrets (required, fails closed with 503 when missing):
//   CONSUMER_AGENT_SECRET   >= 32 chars   HMAC for challenges and status tokens
//   CONSUMER_AGENT_IP_SALT  >= 16 chars   salt for IP hashing
// Optional: CONSUMER_AGENT_DISABLED=true (global kill switch), SITE_URL.
// Deploy:  supabase functions deploy consumer-agent --no-verify-jwt

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { RPC, negotiateMcpVersion, parseRpcBody, rpcError, rpcResult, a2aTask, extractA2aInvocation, MCP_SUPPORTED_VERSIONS } from "../_shared/agent-network/protocol.ts";
import type { FeedSnapshot } from "../_shared/google-booking/availability.ts";
import {
  getRequestStatus, issueChallengeFor, runTool, type Ctx, type CreateResult, type Outcome, type PublicStore,
} from "../_shared/consumer-agent/handlers.ts";
import { buildBusinessAgentCard, buildJsonLd, buildLlmsTxt, businessUrls, parseProfile } from "../_shared/consumer-agent/profile.ts";
import { sandboxStore } from "../_shared/consumer-agent/sandbox.ts";
import { hashIp, limitsFor, POLICY, readSignatureHeaders, verifySignature, type Principal } from "../_shared/consumer-agent/security.ts";
import { CONSUMER_API_VERSION, CONSUMER_TOOLS, mcpConsumerToolDescriptor, SANDBOX_SLUG, SLUG_RE } from "../_shared/consumer-agent/spec.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Vireek-Key-Id, Vireek-Timestamp, Vireek-Nonce, Vireek-Signature",
  "Access-Control-Max-Age": "86400",
};
const secHeaders = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };

function respond(body: BodyInit | null, status: number, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...cors, ...secHeaders, "Content-Type": type, ...extra } });
}
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => respond(JSON.stringify(data), status, "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extra });
const notFound = () => json({ error: "not_found" }, 404);

// ------------------------------------------------------------------
// Store: Supabase RPCs (service role; every RPC is service_role-only)
// ------------------------------------------------------------------
function makeStore(db: SupabaseClient): PublicStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    profile: (slug) => rpc("consumer_agent_get_profile", { p_slug: slug }),
    snapshot: async (slug) => (await rpc<FeedSnapshot | null>("consumer_agent_get_snapshot", { p_slug: slug })) ?? null,
    blockedStarts: async (slug) => (await rpc<string[] | null>("consumer_agent_get_blocked_starts", { p_slug: slug })) ?? [],
    areaCheck: async (slug, postal) => (await rpc<"inside" | "outside" | "unknown">("consumer_agent_area_check", { p_slug: slug, p_postal: postal })),
    hit: async (limits) => {
      try {
        const rs = await Promise.all(limits.map((l) => rpc<{ allowed: boolean; retry_after: number }>("consumer_agent_hit", { p_key: l.key, p_window_seconds: l.windowSec, p_max: l.max })));
        const bad = rs.filter((r) => !r.allowed);
        return { allowed: bad.length === 0, retryAfter: bad.length ? Math.max(...bad.map((r) => r.retry_after)) : 0 };
      } catch (e) {
        console.error(JSON.stringify({ event: "consumer_agent_rate_failed", error: String((e as Error).message) }));
        return { allowed: false, retryAfter: 30 }; // fail closed
      }
    },
    isBlocked: async (ids) => (await Promise.all(ids.map((id) => rpc<boolean>("consumer_agent_is_blocked", { p_principal: id })))).some(Boolean),
    block: async (principal, reasons, hours) => { await rpc("consumer_agent_block", { p_principal: principal, p_reasons: reasons, p_hours: hours }); },
    stats: (principal) => rpc("consumer_agent_principal_stats", { p_principal: principal }),
    createRequest: async (i) => {
      const r = await rpc<Record<string, unknown>>("consumer_agent_create_request", { p: i });
      if (r.ok !== true) return { ok: false, error: String(r.error ?? "invalid") } as CreateResult;
      return { ok: true, replayed: r.replayed === true, request_id: String(r.request_id), status: r.status as "pending" | "held" | "accepted",
        sla_due_at: String(r.sla_due_at), hold_expires_at: (r.hold_expires_at as string | null) ?? null, expires_at: String(r.expires_at) };
    },
    requestStatus: async (id) => (await rpc<Record<string, unknown> | null>("consumer_agent_request_status", { p_id: id })) ?? null,
    log: async (e) => { await rpc("consumer_agent_log", { p: { slug: e.slug, principal: e.principal, ip_hash: e.ipHash, tool: e.tool, outcome: e.outcome, error_code: e.errorCode, flagged: e.flagged ?? false, latency_ms: e.latencyMs } }); },
  };
}

// ------------------------------------------------------------------
function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? (xff || "unknown");
}

const failResponse = (o: Extract<Outcome, { ok: false }>) =>
  json({ error: o.code, message: o.message, ...(o.extra ?? {}) }, o.httpStatus, o.retryAfter ? { "Retry-After": String(o.retryAfter) } : {});

function toolResult(o: Outcome) {
  if (o.ok) return { content: [{ type: "text", text: JSON.stringify(o.data) }], structuredContent: o.data, isError: false };
  return { content: [{ type: "text", text: JSON.stringify({ error: o.code, message: o.message, ...(o.retryAfter ? { retry_after: o.retryAfter } : {}), ...(o.extra ?? {}) }) }], isError: true };
}

const A2A_STATE: Record<string, string> = { pending: "received", held: "received", accepted: "executed", declined: "rejected", expired: "failed" };

// ------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, ...secHeaders } });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("CONSUMER_AGENT_SECRET") ?? "";
  const salt = Deno.env.get("CONSUMER_AGENT_IP_SALT") ?? "";
  if (!supabaseUrl || !serviceKey || secret.length < 32 || salt.length < 16) return json({ error: "service_not_configured" }, 503);
  if (Deno.env.get("CONSUMER_AGENT_DISABLED") === "true") return json({ error: "disabled" }, 503, { "Retry-After": "600" });

  const site = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const api = `${supabaseUrl}/functions/v1/consumer-agent`;
  const url = new URL(req.url);
  const path = (url.pathname.replace(/^\/(?:functions\/v1\/)?consumer-agent/, "").replace(/\/+$/, "")) || "/";
  const now = new Date();

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const real = makeStore(admin);
  const ipHash = await hashIp(clientIp(req), salt, now);

  if (req.method === "GET" && path === "/v1/health") return json({ status: "ok", api_version: CONSUMER_API_VERSION, mcp_versions: MCP_SUPPORTED_VERSIONS });

  // ---- challenge ----
  if (req.method === "GET" && path === "/v1/challenge") {
    const r = await issueChallengeFor({ store: real, ipHash, secret, now });
    return r.ok ? json(r.data) : failResponse(r);
  }

  // ---- request status ----
  const st = /^\/v1\/requests\/([A-Za-z0-9.-]{80,100})$/.exec(path);
  if (req.method === "GET" && st) {
    const rl = await real.hit([{ key: `status:ip:${ipHash}`, windowSec: 60, max: 60 }]);
    if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfter) });
    const r = await getRequestStatus({ store: real, secret }, st[1]);
    return r.ok ? json(r.data) : failResponse(r);
  }

  const m = /^\/v1\/b\/([a-z0-9-]{3,60})\/(profile\.json|llms\.txt|jsonld|agent-card\.json|mcp|a2a)$/.exec(path);
  if (!m || !SLUG_RE.test(m[1])) return notFound();
  const [, slug, leaf] = m;
  const store = slug === SANDBOX_SLUG ? sandboxStore(real) : real;
  const urls = { site, api, slug };

  // ---- principal ----
  let principal: Principal = { kind: "anonymous", id: ipHash, label: "unsigned agent" };
  const body = req.method === "POST" ? await req.text() : "";
  if (req.method === "POST") {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
    if (new TextEncoder().encode(body).length > POLICY.maxBodyBytes) return json(rpcError(null, RPC.INVALID_REQUEST, "Request too large"), 413);
  }
  const sig = readSignatureHeaders(req.headers);
  if (sig === "malformed") return json({ error: "invalid_signature_headers" }, 401);
  if (sig !== "absent") {
    let agent: { id: string; name: string; public_key: string } | null = null;
    try { agent = await admin.rpc("consumer_agent_lookup_key", { p_key_id: sig.keyId }).then((r) => (r.data as typeof agent) ?? null); } catch { agent = null; }
    if (!agent) return json({ error: "unknown_key" }, 401);
    const v = await verifySignature(agent.public_key, sig, req.method, path, body, now);
    if (!v.ok) return json({ error: "invalid_signature", reason: v.reason }, 401);
    const replay = await real.hit([{ key: `nonce:${sig.keyId}:${sig.nonce}`, windowSec: POLICY.nonceWindowSec, max: 1 }]);
    if (!replay.allowed) return json({ error: "replayed_nonce" }, 401);
    principal = { kind: "registered", id: agent.id, label: agent.name };
  }

  const ctx: Ctx = { slug, principal, ipHash, now, store, secret, urls: { statusBase: `${api}/v1/requests` } };

  // ---- GET documents ----
  if (req.method === "GET") {
    if (await store.isBlocked([principal.id, ipHash])) return json({ error: "blocked" }, 403);
    const rl = await store.hit(limitsFor(principal, slug, false, ipHash));
    if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfter) });
    let profile;
    try { profile = parseProfile(await store.profile(slug)); } catch (e) {
      console.error(JSON.stringify({ event: "consumer_agent_profile_failed", error: String((e as Error).message) }));
      return json({ error: "unavailable" }, 503);
    }
    if (!profile) return notFound();
    const cache = { "Cache-Control": "public, max-age=60, s-maxage=120" };
    switch (leaf) {
      case "profile.json": return respond(JSON.stringify(profile), 200, "application/json; charset=utf-8", cache);
      case "llms.txt": return respond(buildLlmsTxt(profile, urls), 200, "text/plain; charset=utf-8", cache);
      case "jsonld": return respond(JSON.stringify(buildJsonLd(profile, urls)), 200, "application/ld+json; charset=utf-8", cache);
      case "agent-card.json": return respond(JSON.stringify(buildBusinessAgentCard(profile, urls)), 200, "application/json; charset=utf-8", cache);
      default: return json({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });
    }
  }

  if (req.method !== "POST" || (leaf !== "mcp" && leaf !== "a2a")) return json({ error: "method_not_allowed" }, 405);

  const parsed = parseRpcBody(body);
  if (parsed.kind === "invalid") return json(rpcError(null, parsed.error.code, parsed.error.message), 400);
  if (parsed.items.length > 5) return json(rpcError(null, RPC.INVALID_REQUEST, "Batch too large (max 5)"), 400);

  const out: Record<string, unknown>[] = [];
  let httpStatus = 200;
  let retryAfter: string | undefined;

  for (const item of parsed.items) {
    if ("invalid" in item) { out.push(rpcError(item.id, RPC.INVALID_REQUEST, "Invalid Request")); continue; }
    if (item.id === undefined) continue; // notification
    const id = item.id;
    const params = (item.params ?? {}) as Record<string, unknown>;
    const gate = (o: Outcome): Record<string, unknown> | null => {
      if (!o.ok && (o.code === "rate_limited" || o.code === "blocked")) {
        httpStatus = o.httpStatus; if (o.retryAfter) retryAfter = String(o.retryAfter);
        return rpcError(id, -32000, o.message);
      }
      return null;
    };
    try {
      if (leaf === "mcp") {
        switch (item.method) {
          case "initialize":
            out.push(rpcResult(id, {
              protocolVersion: negotiateMcpVersion(params.protocolVersion), capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "vireek-consumer-agent", title: "Vireek Consumer Agent", version: CONSUMER_API_VERSION },
              instructions: "Public tools for ONE home-service business. Read tools return only what the owner published. request_booking sends a pending request (never a confirmed appointment, never a payment) and needs the homeowner's consent to share contact details.",
            })); break;
          case "ping": out.push(rpcResult(id, {})); break;
          case "tools/list": out.push(rpcResult(id, { tools: CONSUMER_TOOLS.map(mcpConsumerToolDescriptor) })); break;
          case "tools/call": {
            if (typeof params.name !== "string") { out.push(rpcError(id, RPC.INVALID_PARAMS, "params.name is required")); break; }
            const r = await runTool(ctx, params.name, params.arguments);
            if ("unknownTool" in r) { out.push(rpcError(id, RPC.INVALID_PARAMS, `Unknown tool: ${params.name.slice(0, 64)}`)); break; }
            out.push(gate(r) ?? rpcResult(id, toolResult(r)));
            break;
          }
          default: out.push(rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${item.method.slice(0, 64)}`));
        }
      } else {
        switch (item.method) {
          case "message/send": {
            const message = params.message as Record<string, unknown> | undefined;
            if (!message || typeof message !== "object") { out.push(rpcError(id, RPC.INVALID_PARAMS, "params.message is required")); break; }
            const contextId = typeof message.contextId === "string" && message.contextId.length <= 100 ? message.contextId : crypto.randomUUID();
            const inv = extractA2aInvocation(message);
            if (!inv) {
              out.push(rpcResult(id, { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: `Send a data part {"skill": <id>, "arguments": {...}}. Skills: ${CONSUMER_TOOLS.map((t) => t.name).join(", ")}.` }] }));
              break;
            }
            const r = await runTool(ctx, inv.skill, inv.args);
            if ("unknownTool" in r) { out.push(rpcError(id, RPC.INVALID_PARAMS, `Unknown skill: ${inv.skill.slice(0, 64)}`)); break; }
            const g = gate(r); if (g) { out.push(g); break; }
            const data = r.ok ? r.data : { error: r.code, message: r.message, ...(r.extra ?? {}) };
            const taskId = r.ok && typeof r.data.task_id === "string" ? r.data.task_id : crypto.randomUUID();
            out.push(rpcResult(id, a2aTask({ id: taskId, contextId, status: r.ok ? (r.status ? A2A_STATE[r.status] ?? "ok" : "ok") : "error", data, statusText: r.ok ? undefined : r.message })));
            break;
          }
          case "tasks/get": {
            if (typeof params.id !== "string") { out.push(rpcError(id, RPC.INVALID_PARAMS, "params.id is required")); break; }
            const rl = await store.hit(limitsFor(principal, slug, false, ipHash));
            if (!rl.allowed) { httpStatus = 429; retryAfter = String(rl.retryAfter); out.push(rpcError(id, -32000, "Too many requests")); break; }
            const r = await getRequestStatus({ store, secret }, params.id);
            if (!r.ok) { out.push(rpcError(id, RPC.TASK_NOT_FOUND, "Task not found")); break; }
            out.push(rpcResult(id, a2aTask({ id: params.id, contextId: crypto.randomUUID(), status: A2A_STATE[String(r.data.status)] ?? "error", data: r.data })));
            break;
          }
          case "tasks/cancel": out.push(rpcError(id, RPC.UNSUPPORTED_OPERATION, "Agents cannot cancel requests. Contact the business directly.")); break;
          case "message/stream": case "tasks/resubscribe": case "tasks/pushNotificationConfig/set": case "tasks/pushNotificationConfig/get":
            out.push(rpcError(id, RPC.UNSUPPORTED_OPERATION, "Streaming and push notifications are not supported; poll tasks/get.")); break;
          default: out.push(rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${item.method.slice(0, 64)}`));
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "consumer_agent_unhandled", method: item.method, error: String((e as Error)?.message ?? e) }));
      out.push(rpcError(id, RPC.INTERNAL_ERROR, "Internal error"));
    }
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: { ...cors, ...secHeaders } });
  return json(parsed.batch ? out : out[0], httpStatus, retryAfter ? { "Retry-After": retryAfter } : {});
});
