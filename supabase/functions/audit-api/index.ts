// supabase/functions/audit-api/index.ts
// Public JSON API for the Missed-Call Audit. verify_jwt = false (public); every action is gated inside the service
// (Turnstile, rate limits, OTP, derived tokens). POST {action, ...body}. GET/POST ?action=unsubscribe&t=... for
// RFC 8058 one-click unsubscribe. Origin allow-list; no cookies; responses are never cached.

import { buildAuditDeps } from "../_shared/audit/deps.ts";
import { handleAction } from "../_shared/audit/service.ts";

const ALLOWED = (Deno.env.get("AUDIT_ALLOWED_ORIGINS") ?? Deno.env.get("AUDIT_BASE_URL") ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const ACTIONS = new Set(["config", "start", "verify", "plan", "schedule", "report", "assumptions", "share", "cancel", "delete", "unsubscribe"]);
const MAX_BODY = 16_000;

function headersFor(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", Vary: "Origin" };
  if (origin && ALLOWED.includes(origin)) { h["Access-Control-Allow-Origin"] = origin; h["Access-Control-Allow-Headers"] = "content-type"; h["Access-Control-Allow-Methods"] = "POST, OPTIONS"; }
  return h;
}
const send = (status: number, body: unknown, origin: string | null) => new Response(JSON.stringify(body), { status, headers: headersFor(origin) });

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: origin && ALLOWED.includes(origin) ? 204 : 403, headers: headersFor(origin) });
  const url = new URL(req.url);
  let action = url.searchParams.get("action") ?? "";
  let body: unknown = {};
  try {
    if (req.method === "POST") {
      if (origin && !ALLOWED.includes(origin)) return send(403, { error: "forbidden" }, origin); // browsers only; mail clients send no Origin
      const raw = await req.text();
      if (raw.length > MAX_BODY) return send(413, { error: "too_large" }, origin);
      if (raw) {
        const ct = req.headers.get("content-type") ?? "";
        if (ct.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
        else { body = JSON.parse(raw); }
      }
      if (!action && body && typeof body === "object") action = String((body as Record<string, unknown>).action ?? "");
    } else if (req.method === "GET" && action === "unsubscribe") {
      body = { t: url.searchParams.get("t") };
    } else return send(405, { error: "method_not_allowed" }, origin);
    if (action === "unsubscribe" && req.method === "POST" && url.searchParams.get("t")) body = { t: url.searchParams.get("t") };
    if (!ACTIONS.has(action)) return send(400, { error: "unknown_action" }, origin);

    const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const deps = buildAuditDeps();
    const r = await handleAction(deps, action, body, { ip, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null, pageUrl: origin });
    return send(r.status, r.body, origin);
  } catch (e) {
    console.error(JSON.stringify({ scope: "audit", event: "api_error", message: String((e as Error)?.message ?? e).slice(0, 200) }));
    const cfg = String((e as Error)?.message ?? "").startsWith("missing_env_") || String((e as Error)?.message ?? "").startsWith("mock_providers");
    return send(cfg ? 503 : 400, { error: cfg ? "unavailable" : "bad_request", message: cfg ? "This tool is temporarily unavailable." : "Invalid request." }, origin);
  }
});
