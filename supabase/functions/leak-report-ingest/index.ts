// supabase/functions/leak-report-ingest/index.ts
//
// Server-to-server webhook for call events (call-tracking providers, Twilio status callbacks,
// Zapier/Make "forwarded copies"). No CORS on purpose: the token must never live in browser JS.
//
//   POST <functions-url>/leak-report-ingest
//        Header X-Vireek-Token: <token>   (or Authorization: Bearer <token>, or ?token=<token>)
//        Body: one event object, an array, or { "events": [...] }  (JSON or form-urlencoded)
//
// Deploy: supabase functions deploy leak-report-ingest --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizeEvent } from "../_shared/leak-report/core.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_EVENTS_PER_MINUTE_PER_SOURCE = 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractToken(req: Request, url: URL): string {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return (req.headers.get("x-vireek-token") ?? "").trim() || bearer || (url.searchParams.get("token") ?? "").trim();
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

  const token = extractToken(req, url);
  if (token.length < 32 || token.length > 200) return json({ error: "Unauthorized" }, 401);

  const body = await readBody(req);
  if (body === "too_large") return json({ error: "Payload too large" }, 413);
  if (body === null) return json({ error: "Invalid body" }, 400);

  const o = body as Record<string, unknown>;
  const list: unknown[] = Array.isArray(body) ? body : Array.isArray(o?.events) ? (o.events as unknown[]) : [body];
  if (list.length === 0 || list.length > MAX_EVENTS_PER_REQUEST) {
    return json({ error: `Send between 1 and ${MAX_EVENTS_PER_REQUEST} events per request` }, 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const { data: source, error: srcErr } = await admin
      .from("leak_report_sources")
      .select("id, account_owner_id")
      .eq("token_hash", await sha256Hex(token))
      .eq("enabled", true)
      .maybeSingle();
    if (srcErr) throw new Error(`source_lookup_failed: ${srcErr.message}`);
    if (!source) return json({ error: "Unauthorized" }, 401);

    const { data: settings, error: setErr } = await admin
      .from("leak_report_settings")
      .select("enabled")
      .eq("account_owner_id", source.account_owner_id)
      .maybeSingle();
    if (setErr) throw new Error(`settings_lookup_failed: ${setErr.message}`);
    if (!settings?.enabled) return json({ ok: true, ignored: "leak_report_not_active" }, 202);

    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin
      .from("leak_report_call_events")
      .select("id", { count: "exact", head: true })
      .eq("source_id", source.id)
      .gte("received_at", since);
    if ((count ?? 0) + list.length > MAX_EVENTS_PER_MINUTE_PER_SOURCE) return json({ error: "Rate limit exceeded" }, 429);

    const rows: Record<string, unknown>[] = [];
    const rejected: { index: number; reason: string }[] = [];
    list.forEach((raw, index) => {
      const r = normalizeEvent(raw, source.id);
      if (!r.ok) { rejected.push({ index, reason: r.reason }); return; }
      const e = r.event;
      rows.push({
        account_owner_id: source.account_owner_id,
        source_id: source.id,
        dedupe_key: e.dedupeKey,
        direction: e.direction,
        started_at: e.startedAt,
        answered: e.answered,
        is_voicemail: e.isVoicemail,
        ring_seconds: e.ringSeconds,
        duration_seconds: e.durationSeconds,
        phone_key: e.phoneKey,
      });
    });

    let accepted = 0;
    if (rows.length > 0) {
      const { data, error } = await admin
        .from("leak_report_call_events")
        .upsert(rows, { onConflict: "account_owner_id,dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`insert_failed: ${error.message}`);
      accepted = data?.length ?? 0;
      await admin.from("leak_report_sources").update({ last_event_at: new Date().toISOString() }).eq("id", source.id);
    }

    return json({ ok: true, received: list.length, accepted, duplicates: rows.length - accepted, rejected });
  } catch (e) {
    console.error(JSON.stringify({ event: "leak_report_ingest_failed", error: String(e) }));
    return json({ error: "Ingest failed" }, 500);
  }
});
