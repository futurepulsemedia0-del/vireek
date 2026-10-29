// Connects / disconnects a tenant's Telegram bot or Facebook Page for the Unified Inbox.
//
//   connect    telegram   { botToken }            verifies the token (getMe), registers the webhook (setWebhook + secret_token)
//   connect    messenger  { pageId, pageToken }   verifies the Page token, subscribes the Page to this Meta app (subscribed_apps)
//   disconnect telegram | messenger               removes the webhook / subscription and the stored secrets
//
// One bot / one Page per tenant per channel (enforced by uq_dm_connections_user_channel).
// Handled failures return HTTP 200 { ok:false, message } so supabase-js delivers the message to the UI
// (a non-2xx would surface only as a generic "Edge Function returned a non-2xx status code").

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { graphRequest, telegramApi } from "../_shared/dmChannels/api.ts";
import { isFacebookPageId, isPageAccessToken, isTelegramToken, toHex } from "../_shared/dmChannels/protocol.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (message: string) => json({ ok: false, message });

type Channel = "telegram" | "messenger";
interface Row { id: string; user_id: string; external_account_id: string; access_token: string; status: string }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = body.channel as Channel;
  if (body.action !== "connect" && body.action !== "disconnect") return json({ error: "Unknown action" }, 400);
  if (channel !== "telegram" && channel !== "messenger") return json({ error: "Unknown channel" }, 400);

  try {
    const { data: mine } = await admin.from("dm_channel_connections")
      .select("id, user_id, external_account_id, access_token, status").eq("user_id", userId).eq("channel", channel).maybeSingle();
    const current = mine as Row | null;

    // ------------------------------ disconnect ------------------------------
    if (body.action === "disconnect") {
      if (!current) return json({ ok: true });
      if (current.access_token) {
        if (channel === "telegram") await telegramApi(current.access_token, "deleteWebhook", {});
        else await graphRequest(current.access_token, `/${current.external_account_id}/subscribed_apps`, { method: "DELETE" });
      }
      const { error } = await admin.from("dm_channel_connections")
        .update({ status: "disconnected", access_token: "", webhook_secret: null, last_error: null }).eq("id", current.id);
      if (error) throw error;
      return json({ ok: true });
    }

    // ------------------------------- connect --------------------------------
    let externalId: string;
    let displayName: string;
    let token: string;
    let secret: string | null = null;

    if (channel === "telegram") {
      token = typeof body.botToken === "string" ? body.botToken.trim() : "";
      if (!isTelegramToken(token)) return fail("That doesn't look like a Telegram bot token (format 123456789:AA…). Copy it from @BotFather.");
      const me = await telegramApi<{ id: number; username?: string; first_name?: string; is_bot?: boolean }>(token, "getMe");
      if (!me.ok || !me.result?.is_bot) return fail("Telegram rejected this bot token. Check it in @BotFather and try again.");
      externalId = String(me.result.id);
      displayName = me.result.username ? `@${me.result.username}` : (me.result.first_name ?? "Telegram bot");
      secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
    } else {
      externalId = typeof body.pageId === "string" ? body.pageId.trim() : "";
      token = typeof body.pageToken === "string" ? body.pageToken.trim() : "";
      if (!isFacebookPageId(externalId)) return fail("Page ID must be the numeric ID of your Facebook Page.");
      if (!isPageAccessToken(token)) return fail("Paste the Page access token (a long string without spaces).");
      const page = await graphRequest<{ id?: string; name?: string }>(token, `/${externalId}?fields=id,name`);
      if (!page.ok || page.data.id !== externalId) return fail("Meta rejected this Page ID / token pair. Make sure the token was generated for this Page.");
      displayName = page.data.name ?? "Facebook Page";
    }

    // A bot / Page can belong to one account only (never let a second tenant take it over).
    const { data: owner } = await admin.from("dm_channel_connections")
      .select("id, user_id, external_account_id, access_token, status").eq("channel", channel).eq("external_account_id", externalId).maybeSingle();
    const taken = owner as Row | null;
    if (taken && taken.user_id !== userId) return fail("This account is already connected to another Vireek workspace.");

    if (current && current.external_account_id !== externalId) {
      if (current.status === "connected") return fail("Disconnect your current connection for this channel before connecting a different one.");
      await admin.from("dm_channel_connections").delete().eq("id", current.id); // stale (disconnected / errored) row
    }

    const id = taken?.id ?? crypto.randomUUID();
    const { error: saveError } = await admin.from("dm_channel_connections").upsert({
      id, user_id: userId, channel, external_account_id: externalId, access_token: token,
      webhook_secret: secret, display_name: displayName, status: "connected", last_error: null,
    }, { onConflict: "id" });
    if (saveError) throw saveError;

    let providerError: string | null = null;
    if (channel === "telegram") {
      const hook = await telegramApi(token, "setWebhook", {
        url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-webhook?c=${id}`,
        secret_token: secret, allowed_updates: ["message"], max_connections: 40,
      });
      if (!hook.ok) providerError = hook.description ?? "Telegram refused the webhook.";
    } else {
      const sub = await graphRequest<{ success?: boolean }>(token, `/${externalId}/subscribed_apps`, { form: { subscribed_fields: "messages" } });
      if (!sub.ok || sub.data.success !== true) providerError = sub.data.error?.message ?? "Meta refused the Page subscription.";
    }
    if (providerError) {
      await admin.from("dm_channel_connections").update({ status: "error", last_error: providerError.slice(0, 300) }).eq("id", id);
      return fail(`Connected, but the provider refused the webhook setup: ${providerError}`);
    }

    return json({ ok: true, displayName });
  } catch (error) {
    console.error(JSON.stringify({ event: "dm_connect_failed", channel, error: error instanceof Error ? error.message : String(error) }));
    return fail("Something went wrong. Please try again.");
  }
});
