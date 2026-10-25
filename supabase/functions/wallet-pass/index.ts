// supabase/functions/wallet-pass/index.ts
//
// PUBLIC wallet endpoint (Apple's web service + customer downloads).
//
//   GET    /p/<share_token>.pkpass                                   signed Apple Wallet pass (download)
//   GET    /g/<share_token>                                          302 -> "Add to Google Wallet"
//   POST   /v1/devices/<dev>/registrations/<passTypeId>/<serial>     register a device   (ApplePass auth)
//   DELETE /v1/devices/<dev>/registrations/<passTypeId>/<serial>     unregister          (ApplePass auth)
//   GET    /v1/devices/<dev>/registrations/<passTypeId>?passesUpdatedSince=<tag>   changed serials
//   GET    /v1/passes/<passTypeId>/<serial>                          latest pass         (ApplePass auth)
//   POST   /v1/log                                                   device error log
//
// DEPLOY: supabase functions deploy wallet-pass --no-verify-jwt   (Apple devices cannot send a Supabase JWT;
//         every route is protected by an unguessable token instead.)
// SECRETS: see docs/WALLET_SETUP.md

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { readWalletEnv } from "../_shared/wallet/config.ts";
import { loadPayload, publishGoogle, renderApple, safeEqual } from "../_shared/wallet/service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIAL = /^[0-9a-f]{32}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE, ...extra } });

async function handle(req: Request): Promise<Response> {
  const env = readWalletEnv();
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^.*\/wallet-pass/, "");
  const seg = rest.split("/").filter(Boolean);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return text("Server misconfigured", 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const passRow = async (col: "serial" | "share_token", value: string) => {
    const { data } = await admin
      .from("wallet_passes")
      .select("id, serial, auth_token, status, last_changed_at")
      .eq(col, value)
      .maybeSingle();
    return data as { id: string; serial: string; auth_token: string; status: string; last_changed_at: string } | null;
  };
  const applePassAuthorized = (row: { auth_token: string }) => {
    const m = /^ApplePass\s+(\S+)$/.exec(req.headers.get("Authorization") ?? "");
    return !!m && safeEqual(m[1], row.auth_token);
  };

  try {
    // ---------- customer downloads ----------
    if (req.method === "GET" && seg[0] === "p" && seg.length === 2) {
      const token = seg[1].replace(/\.pkpass$/i, "");
      if (!UUID.test(token)) return text("Not found", 404);
      if (!env.apple) return text("Apple Wallet is not configured for this business yet.", 503);
      const row = await passRow("share_token", token);
      if (!row) return text("Not found", 404);
      if (row.status === "voided") return text("This pass is no longer active.", 410);
      const payload = await loadPayload(admin, row.id);
      if (!payload) return text("Not found", 404);
      const { bytes } = await renderApple(env, payload);
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.pkpass", "Content-Disposition": `attachment; filename="${payload.pass.kind}.pkpass"`, ...NO_STORE },
      });
    }

    if (req.method === "GET" && seg[0] === "g" && seg.length === 2) {
      if (!UUID.test(seg[1])) return text("Not found", 404);
      if (!env.google) return text("Google Wallet is not configured for this business yet.", 503);
      const row = await passRow("share_token", seg[1]);
      if (!row) return text("Not found", 404);
      if (row.status === "voided") return text("This pass is no longer active.", 410);
      const payload = await loadPayload(admin, row.id);
      if (!payload) return text("Not found", 404);
      const out = await publishGoogle(env, admin, payload);
      if ("error" in out) {
        console.error("wallet-pass google:", out.error);
        return text("Google Wallet is temporarily unavailable. Please try again.", 502);
      }
      return new Response(null, { status: 302, headers: { Location: out.url, ...NO_STORE } });
    }

    // ---------- Apple web service ----------
    if (seg[0] !== "v1") return text("Not found", 404);

    if (req.method === "POST" && seg[1] === "log") {
      const body = await req.json().catch(() => null);
      const logs = Array.isArray(body?.logs) ? (body.logs as unknown[]).slice(0, 20).map((l) => String(l).slice(0, 300)) : [];
      if (logs.length) console.warn("wallet apple device log:", JSON.stringify(logs));
      return new Response(null, { status: 200 });
    }

    const passTypeOk = (t: string) => !!env.apple && t === env.apple.passTypeIdentifier;

    // /v1/devices/<dev>/registrations/<passTypeId>[/<serial>]
    if (seg[1] === "devices" && seg[3] === "registrations" && seg[2] && seg[4]) {
      const device = decodeURIComponent(seg[2]);
      const passType = decodeURIComponent(seg[4]);
      if (!passTypeOk(passType)) return text("Not found", 404);

      if (seg.length === 6) {
        const serial = seg[5];
        if (!SERIAL.test(serial)) return text("Not found", 404);
        const row = await passRow("serial", serial);
        if (!row) return text("Not found", 404);
        if (!applePassAuthorized(row)) return text("Unauthorized", 401);

        if (req.method === "POST") {
          const body = await req.json().catch(() => null);
          const pushToken = typeof body?.pushToken === "string" ? body.pushToken.trim() : "";
          if (!pushToken || pushToken.length > 400) return text("Bad request", 400);
          const { data: existing } = await admin.from("wallet_registrations").select("id").eq("pass_id", row.id).eq("device_library_id", device).maybeSingle();
          const { error } = await admin.from("wallet_registrations").upsert(
            { pass_id: row.id, device_library_id: device, push_token: pushToken, updated_at: new Date().toISOString() },
            { onConflict: "pass_id,device_library_id" },
          );
          if (error) throw error;
          return new Response(null, { status: existing ? 200 : 201 });
        }
        if (req.method === "DELETE") {
          await admin.from("wallet_registrations").delete().eq("pass_id", row.id).eq("device_library_id", device);
          return new Response(null, { status: 200 });
        }
        return text("Method not allowed", 405);
      }

      if (seg.length === 5 && req.method === "GET") {
        const { data: regs } = await admin.from("wallet_registrations").select("pass_id").eq("device_library_id", device);
        const ids = (regs ?? []).map((r: { pass_id: string }) => r.pass_id);
        if (!ids.length) return new Response(null, { status: 204 });
        let q = admin.from("wallet_passes").select("serial, last_changed_at").in("id", ids);
        const since = Number(url.searchParams.get("passesUpdatedSince"));
        if (Number.isFinite(since) && since > 0) q = q.gt("last_changed_at", new Date(since).toISOString());
        const { data: changed } = await q;
        const rows = (changed ?? []) as { serial: string; last_changed_at: string }[];
        if (!rows.length) return new Response(null, { status: 204 });
        const lastUpdated = Math.max(...rows.map((r) => Date.parse(r.last_changed_at)));
        return new Response(JSON.stringify({ serialNumbers: rows.map((r) => r.serial), lastUpdated: String(lastUpdated) }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...NO_STORE },
        });
      }
      return text("Not found", 404);
    }

    // /v1/passes/<passTypeId>/<serial>
    if (seg[1] === "passes" && seg.length === 4 && req.method === "GET") {
      if (!passTypeOk(decodeURIComponent(seg[2])) || !SERIAL.test(seg[3])) return text("Not found", 404);
      const row = await passRow("serial", seg[3]);
      if (!row) return text("Not found", 404);
      if (!applePassAuthorized(row)) return text("Unauthorized", 401);

      const changedSec = Math.floor(Date.parse(row.last_changed_at) / 1000);
      const ims = req.headers.get("If-Modified-Since");
      if (ims && Number.isFinite(Date.parse(ims)) && Math.floor(Date.parse(ims) / 1000) >= changedSec) {
        return new Response(null, { status: 304 });
      }
      const payload = await loadPayload(admin, row.id);
      if (!payload) return text("Not found", 404);
      const { bytes } = await renderApple(env, payload);
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.pkpass", "Last-Modified": new Date(changedSec * 1000).toUTCString(), ...NO_STORE },
      });
    }

    return text("Not found", 404);
  } catch (e) {
    console.error("wallet-pass error:", e instanceof Error ? e.message : e);
    return text("Something went wrong", 500);
  }
}

Deno.serve(handle);
