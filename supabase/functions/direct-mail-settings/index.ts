// supabase/functions/direct-mail-settings/index.ts
//
// Stores the account's print-provider (Lob) credentials ENCRYPTED. The browser never receives them back.
// Authenticated (default verify-jwt = on). Actions (POST JSON):
//   { action: "save_key", api_key, webhook_secret? }   verifies the key against Lob, then stores it
//   { action: "save_webhook_secret", webhook_secret }   (paste from Lob dashboard -> Settings -> Webhooks)
//   { action: "rotate_webhook_token" }                   new webhook URL; the old one stops working
//   { action: "clear_key" }
// Required secrets: DIRECT_MAIL_KEY (base64 32 bytes). Platform: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { encryptSecret } from "../_shared/direct-mail/crypto.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const KEY_RE = /^(test|live)_[A-Za-z0-9]{16,64}$/;
const SECRET_RE = /^[\x21-\x7e]{8,200}$/;

async function verifyLobKey(apiKey: string): Promise<"ok" | "invalid" | "unreachable"> {
  try {
    const res = await fetch("https://api.lob.com/v1/addresses?limit=1", {
      headers: { Authorization: `Basic ${btoa(`${apiKey}:`)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "not_authenticated" }, 401);

  // 1) Who is calling? (RLS-style check through the caller's own JWT.)
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: ctx, error: ctxError } = await userClient.rpc("direct_mail_ctx");
  const owner = Array.isArray(ctx) ? ctx[0] : ctx;
  if (ctxError || !owner?.owner_id) return json({ error: "not_authenticated" }, 401);
  if (!owner.can_manage) return json({ error: "not_authorized" }, 403);
  const ownerId = owner.owner_id as string;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    switch (body.action) {
      case "save_key": {
        const apiKey = String(body.api_key ?? "").trim();
        if (!KEY_RE.test(apiKey)) return json({ error: "invalid_key_format" }, 400);
        const verdict = await verifyLobKey(apiKey);
        if (verdict === "invalid") return json({ error: "key_rejected" }, 400);
        if (verdict === "unreachable") return json({ error: "provider_unreachable" }, 502);

        const row: Record<string, unknown> = {
          user_id: ownerId,
          encrypted_api_key: await encryptSecret(apiKey),
          api_key_last4: apiKey.slice(-4),
          api_mode: apiKey.startsWith("live_") ? "live" : "test",
        };
        const secret = String(body.webhook_secret ?? "").trim();
        if (secret) {
          if (!SECRET_RE.test(secret)) return json({ error: "invalid_webhook_secret" }, 400);
          row.encrypted_webhook_secret = await encryptSecret(secret);
        }
        const { error } = await admin.from("direct_mail_settings").upsert(row, { onConflict: "user_id" });
        if (error) throw error;
        break;
      }
      case "save_webhook_secret": {
        const secret = String(body.webhook_secret ?? "").trim();
        if (!SECRET_RE.test(secret)) return json({ error: "invalid_webhook_secret" }, 400);
        const { error } = await admin
          .from("direct_mail_settings")
          .upsert({ user_id: ownerId, encrypted_webhook_secret: await encryptSecret(secret) }, { onConflict: "user_id" });
        if (error) throw error;
        break;
      }
      case "rotate_webhook_token": {
        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const { error } = await admin.from("direct_mail_settings").upsert({ user_id: ownerId, webhook_token: token }, { onConflict: "user_id" });
        if (error) throw error;
        break;
      }
      case "clear_key": {
        const { error } = await admin
          .from("direct_mail_settings")
          .update({ encrypted_api_key: null, api_key_last4: null, api_mode: null, encrypted_webhook_secret: null })
          .eq("user_id", ownerId);
        if (error) throw error;
        break;
      }
      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "direct_mail_settings_failed", message: e instanceof Error ? e.message : String(e) }));
    return json({ error: "server_error" }, 500);
  }

  // Never log or return key material. Return the safe settings view.
  const { data: settings, error } = await userClient.rpc("direct_mail_settings_get");
  if (error) return json({ ok: true });
  return json({ ok: true, settings });
});
