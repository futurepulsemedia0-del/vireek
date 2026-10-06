import { adminClient, authenticate, corsHeaders, json } from "../_shared/bank/http.ts";
import { createLinkToken, exchangePublicToken, getItemInstitution, plaidConfigured, removeItem } from "../_shared/bank/plaid.ts";
import { decryptToken, encryptToken } from "../_shared/bank/crypto.ts";
import { syncConnection } from "../_shared/bank/engine.ts";

// POST { action: "link_token" | "exchange" | "reauth_token" | "disconnect", ... }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const db = adminClient();
    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;
    if (!caller.canManage) return json({ error: "Only the account owner or a billing admin can manage bank connections." }, 403);
    if (!plaidConfigured()) return json({ error: "Bank connectivity isn't configured on this server yet (missing PLAID_CLIENT_ID / PLAID_SECRET)." }, 503);

    const body = await req.json().catch(() => ({}));
    const webhook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-webhook`;

    if (body.action === "link_token") {
      const { link_token } = await createLinkToken(caller.ownerId, webhook);
      return json({ link_token });
    }

    if (body.action === "reauth_token") {
      const { data: conn } = await db.from("bank_connections").select("id").eq("id", String(body.connection_id)).eq("user_id", caller.ownerId).maybeSingle();
      if (!conn) return json({ error: "Connection not found." }, 404);
      const { data: sec } = await db.from("bank_connection_secrets").select("access_token_enc").eq("connection_id", conn.id).maybeSingle();
      if (!sec) return json({ error: "Connection secret missing." }, 404);
      const { link_token } = await createLinkToken(caller.ownerId, webhook, await decryptToken(sec.access_token_enc));
      return json({ link_token });
    }

    if (body.action === "reauth_done") {
      await db.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() })
        .eq("id", String(body.connection_id)).eq("user_id", caller.ownerId);
      return json({ ok: true });
    }

    if (body.action === "exchange") {
      const publicToken = typeof body.public_token === "string" ? body.public_token : "";
      if (!publicToken) return json({ error: "Missing public_token." }, 400);
      const { access_token, item_id } = await exchangePublicToken(publicToken);

      const { data: existing } = await db.from("bank_connections").select("id, user_id").eq("provider", "plaid").eq("provider_item_id", item_id).maybeSingle();
      if (existing && existing.user_id !== caller.ownerId) return json({ error: "This bank login is already connected to another account." }, 409);

      const inst = await getItemInstitution(access_token);
      const enc = await encryptToken(access_token);
      let connectionId = existing?.id as string | undefined;
      if (connectionId) {
        await db.from("bank_connections").update({ status: "active", institution_id: inst.id, institution_name: inst.name, updated_at: new Date().toISOString() }).eq("id", connectionId);
      } else {
        const { data: created, error } = await db.from("bank_connections").insert({
          user_id: caller.ownerId, provider: "plaid", provider_item_id: item_id, institution_id: inst.id, institution_name: inst.name, created_by: caller.userId,
        }).select("id").single();
        if (error || !created) throw error ?? new Error("Could not create connection");
        connectionId = created.id;
      }
      await db.from("bank_connection_secrets").upsert({ connection_id: connectionId, access_token_enc: enc, updated_at: new Date().toISOString() });

      // First page(s) of history inline so the user sees data immediately; webhooks continue the rest.
      let summary = null;
      try { summary = await syncConnection(db, connectionId!); } catch (e) {
        console.error(JSON.stringify({ event: "bank_first_sync_failed", error: e instanceof Error ? e.message : String(e) }));
      }
      return json({ connection_id: connectionId, institution_name: inst.name, summary });
    }

    if (body.action === "disconnect") {
      const { data: conn } = await db.from("bank_connections").select("id").eq("id", String(body.connection_id)).eq("user_id", caller.ownerId).maybeSingle();
      if (!conn) return json({ error: "Connection not found." }, 404);
      const { data: sec } = await db.from("bank_connection_secrets").select("access_token_enc").eq("connection_id", conn.id).maybeSingle();
      if (sec) { try { await removeItem(await decryptToken(sec.access_token_enc)); } catch { /* already revoked upstream */ } }
      await db.from("bank_connection_secrets").delete().eq("connection_id", conn.id);
      await db.from("bank_connections").update({ status: "disconnected", updated_at: new Date().toISOString() }).eq("id", conn.id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "bank_connect_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Something went wrong connecting to your bank. Please try again." }, 500);
  }
});
