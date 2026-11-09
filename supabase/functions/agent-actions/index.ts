// supabase/functions/agent-actions/index.ts
//
// Human-facing endpoint of the Agent Action Framework (browser -> engine). Agents do NOT call this; they call the
// engine in-process (see _shared/agent-actions/index.ts).
//
// Actions (POST JSON):
//   tools   {}                                   registry metadata for the policy UI
//   approve { requestId, expectedInputHash }     approve + execute (re-validated server-side)
//   reject  { requestId, reason? }
//   undo    { requestId }
//
// Auth   : caller JWT. Account owner = get_account_owner_id() and permission = can_manage_ai_security(), both
//          evaluated under the CALLER's identity. The service-role client is used only by the engine's ports.
// Env    : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (standard), AGENT_ACTIONS_ALLOWED_ORIGINS
//          (comma separated; CORS allow-list, never "*").
// Flag   : returns 404-equivalent `module_disabled` while the flag / entitlement is off (no behaviour change).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, errorResponse, HttpError, makeLogger, newRequestId, readJsonBody } from "../_shared/http/core.ts";
import { dbRateLimiter, rateLimitedError } from "../_shared/http/rateLimit.ts";
import { getKillSwitchGuard } from "../_shared/flags/killSwitch.ts";
import { ActionError, createActionEngine, type ProposeOutcome } from "../_shared/agent-actions/index.ts";
import { supabaseKill, supabaseOwnsResource, supabasePolicyState, supabaseStore, supabaseUsage } from "../_shared/agent-actions/supabasePorts.ts";
import { buildDefaultRegistry, resourceTables } from "../_shared/agent-actions/registry.default.ts";

const ORIGINS = (Deno.env.get("AGENT_ACTIONS_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function summarize(r: ProposeOutcome) {
  if (r.outcome === "module_disabled") return { outcome: r.outcome };
  if (r.outcome === "dry_run") return { outcome: r.outcome, decision: r.decision, code: r.code };
  const rec = "record" in r ? r.record : null;
  return { outcome: r.outcome, code: "code" in r ? r.code : null, reasons: "reasons" in r ? r.reasons : [], status: rec?.status ?? null, requestId: rec?.id ?? null };
}

Deno.serve(async (req) => {
  const requestId = newRequestId(req);
  const cors = corsHeadersFor(req, { allowedOrigins: ORIGINS });
  const log = makeLogger("agent-actions", requestId);
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method !== "POST") throw new HttpError("method_not_allowed", "POST only.");
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError("unauthorized", "Missing token.");

    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: userData, error: userErr } = await caller.auth.getUser(jwt);
    if (userErr || !userData?.user) throw new HttpError("unauthorized", "Invalid token.");
    const userId = userData.user.id;

    const { data: ownerId, error: ownerErr } = await caller.rpc("get_account_owner_id");
    if (ownerErr || typeof ownerId !== "string" || !UUID_RE.test(ownerId)) throw new HttpError("forbidden", "No account.");
    const { data: canManage, error: permErr } = await caller.rpc("can_manage_ai_security");
    if (permErr || canManage !== true) throw new HttpError("forbidden", "You are not allowed to manage agent actions.");

    const limiter = dbRateLimiter(admin);
    const hit = await limiter.hit(`agent-actions:${ownerId}`, 120, 60);
    if (!hit.allowed) throw rateLimitedError(hit.retryAfter);

    const registry = buildDefaultRegistry();
    const engine = createActionEngine({
      registry, store: supabaseStore(admin), state: supabasePolicyState(admin), usage: supabaseUsage(admin),
      kill: supabaseKill(getKillSwitchGuard(admin)), ownsResource: supabaseOwnsResource(admin, resourceTables),
      log: (e, f) => log(e, f),
    });
    const approver = { userId, verified: true } as const;

    const { json } = await readJsonBody(req, 8 * 1024);
    const body = (json ?? {}) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const rid = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : null;

    switch (action) {
      case "tools":
        return respond({ tools: registry.list() });
      case "approve": {
        if (!rid || typeof body.expectedInputHash !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedInputHash)) throw new HttpError("bad_request", "requestId and expectedInputHash are required.");
        const r = await engine.approve({ accountOwnerId: ownerId, approver, requestId: rid, expectedInputHash: body.expectedInputHash });
        return respond(summarize(r));
      }
      case "reject": {
        if (!rid) throw new HttpError("bad_request", "requestId is required.");
        const r = await engine.reject({ accountOwnerId: ownerId, approver, requestId: rid, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined });
        return respond({ outcome: "rejected", requestId: r.id });
      }
      case "undo": {
        if (!rid) throw new HttpError("bad_request", "requestId is required.");
        const r = await engine.undo({ accountOwnerId: ownerId, approver, requestId: rid });
        return respond({ outcome: "undone", requestId: r.id });
      }
      default:
        throw new HttpError("bad_request", "Unknown action.");
    }
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e, requestId, cors);
    if (e instanceof ActionError) {
      const map = { not_found: "not_found", invalid_state: "conflict", input_changed: "conflict", forbidden: "forbidden", undo_unavailable: "conflict", bad_request: "bad_request" } as const;
      return errorResponse(new HttpError(map[e.code], e.message), requestId, cors);
    }
    log("agent_actions_error", { message: e instanceof Error ? e.message : "unknown" });
    return errorResponse(new HttpError("internal", "Unexpected error."), requestId, cors);
  }
});
