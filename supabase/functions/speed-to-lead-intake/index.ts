// supabase/functions/speed-to-lead-intake/index.ts
//
// Public webhook for web-form / ad leads that carry captured consent.
//
//   POST <functions-url>/speed-to-lead-intake            (JSON or form-urlencoded)
//        Header  X-Vireek-Token: <source token>   (or Authorization: Bearer <token>)
//   POST ...?action=sweep   Header X-Cron-Secret: $CRON_SECRET   (every minute)
//
// SERVER-TO-SERVER ONLY (your form backend, Zapier/Make, Meta/Google lead webhooks). There is
// deliberately no CORS: a token embedded in browser JavaScript would let anyone make the AI call
// any phone number they type in. See docs/compliance/speed-to-lead-assumptions.md.
//
// Flow: validate -> save lead + append-only consent proof + request -> respond 200 immediately ->
// the first call is placed in EdgeRuntime.waitUntil (target: well inside 60 s).
//
// Deploy: supabase functions deploy speed-to-lead-intake --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { assessIntake } from "../_shared/speed-to-lead/core.ts";
import { dialNow, findSourceByToken, loadSettings, recordIntake, sweep, type Deps } from "../_shared/speed-to-lead/runtime.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LEADS_PER_MINUTE_PER_SOURCE = 30;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractToken(req: Request): string {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return (req.headers.get("x-vireek-token") ?? "").trim() || bearer;
}

function clientIp(req: Request): string | null {
  const raw = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  const ip = raw?.trim() ?? "";
  return ip && ip.length <= 64 ? ip : null;
}

/** End-user evidence forwarded by the form backend wins over the sender's own IP / user agent. */
function evidence(req: Request, body: unknown): { ip: string | null; userAgent: string | null } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fwdIp = typeof o.ip_address === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(o.ip_address.trim()) ? o.ip_address.trim() : null;
  const fwdUa = typeof o.user_agent === "string" && o.user_agent.trim() ? o.user_agent.trim().slice(0, 400) : null;
  return { ip: fwdIp ?? clientIp(req), userAgent: fwdUa ?? req.headers.get("user-agent") };
}

async function readBody(req: Request): Promise<unknown | "too_large"> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return "too_large";
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return "too_large";
  if ((req.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const deps: Deps = { admin, vapiKey: Deno.env.get("VAPI_PRIVATE_KEY") ?? null };

  if (url.searchParams.get("action") === "sweep") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || !timingSafeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) return json({ error: "Unauthorized" }, 401);
    try {
      return json({ ok: true, ...(await sweep(deps)) });
    } catch (e) {
      console.error(JSON.stringify({ event: "stl_sweep_failed", error: String(e) }));
      return json({ error: "Sweep failed" }, 500);
    }
  }

  const token = extractToken(req);
  if (token.length < 32) return json({ error: "Unauthorized" }, 401);

  try {
    const source = await findSourceByToken(admin, token);
    if (!source) return json({ error: "Unauthorized" }, 401);

    const body = await readBody(req);
    if (body === "too_large") return json({ error: "Payload too large" }, 413);

    // Abuse guard: a leaked token must not become an unlimited robocall cannon.
    const { count } = await admin
      .from("speed_to_lead_requests")
      .select("id", { count: "exact", head: true })
      .eq("source_id", source.id)
      .gte("received_at", new Date(Date.now() - 60_000).toISOString());
    if ((count ?? 0) >= MAX_LEADS_PER_MINUTE_PER_SOURCE) return json({ error: "Rate limit exceeded" }, 429);

    const settings = await loadSettings(admin, source.account_owner_id);
    const assessment = assessIntake(
      body,
      { id: source.id, disclosureText: source.disclosure_text, disclosureVersion: source.disclosure_version },
      Date.now(),
      settings.leadTtlHours,
    );
    if (!assessment.ok) return json({ error: assessment.reason, detail: assessment.detail }, 422);

    const result = await recordIntake(
      admin,
      source,
      assessment,
      evidence(req, body),
      settings,
    );

    // Immediate dial AFTER the response so the sender never waits on telephony.
    if (result.willCall && result.requestId && !result.duplicate) {
      const task = dialNow(deps, result.requestId).catch((e) =>
        console.error(JSON.stringify({ event: "stl_dial_now_failed", error: String(e) })),
      );
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
      else await task;
    }

    return json({
      received: true,
      duplicate: result.duplicate,
      lead_id: result.leadId,
      will_call: result.willCall,
      hold_reason: result.holdReason,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "stl_intake_failed", error: String(e) }));
    return json({ error: "Temporary failure, please retry" }, 500); // safe to retry: intake is idempotent
  }
});
