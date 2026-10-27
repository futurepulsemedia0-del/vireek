// supabase/functions/direct-mail-verify/index.ts
//
// Checks every unverified, still-queued recipient of a campaign against Lob's US address verification.
// Authenticated; the caller must be a manager. POST { campaign_id } ->
//   { processed, deliverable, review, undeliverable, errors, remaining, blocking }
//
// RESUMABLE and SAFE TO RE-INVOKE: time-boxed, keyset-paged by piece id; results are written one piece at a time and
// only for pieces that are still queued. The dashboard keeps calling until remaining = 0 (or no progress).
// Live key: an undeliverable address is removed from the send (status failed, never printed or charged).
// Test key: results are recorded but nothing is removed (the provider simulates test answers).
// Required secrets: DIRECT_MAIL_KEY. Optional: LOB_API_VERSION.
// NOT LIVE-VERIFIED against Lob (mock-tested only).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decryptSecret } from "../_shared/direct-mail/crypto.ts";
import { blocksSending, verifyAddressWithLob } from "../_shared/direct-mail/verify.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TIME_BUDGET_MS = 45_000;
const BATCH = 10;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "not_authenticated" }, 401);

  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: ctx, error: ctxError } = await userClient.rpc("direct_mail_ctx");
  const who = Array.isArray(ctx) ? ctx[0] : ctx;
  if (ctxError || !who?.owner_id) return json({ error: "not_authenticated" }, 401);
  if (!who.can_manage) return json({ error: "not_authorized" }, 403);
  const ownerId = who.owner_id as string;

  let campaignId = "";
  try {
    campaignId = String((await req.json()).campaign_id ?? "");
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return json({ error: "invalid_campaign" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const { data: campaign } = await admin.from("direct_mail_campaigns").select("id,status").eq("id", campaignId).eq("user_id", ownerId).maybeSingle<Row>();
    if (!campaign) return json({ error: "campaign_not_found" }, 404);
    if (!["draft", "paused"].includes(campaign.status)) return json({ error: "campaign_locked" }, 409);

    const { data: settings } = await admin.from("direct_mail_settings").select("encrypted_api_key,api_mode").eq("user_id", ownerId).maybeSingle<Row>();
    if (!settings?.encrypted_api_key) return json({ error: "provider_not_configured" }, 409);

    const apiKey = await decryptSecret(settings.encrypted_api_key);
    const block = blocksSending(settings.api_mode);
    const version = Deno.env.get("LOB_API_VERSION");

    const started = Date.now();
    const tally = { processed: 0, deliverable: 0, review: 0, undeliverable: 0, errors: 0 };
    let cursor = "";

    while (Date.now() - started < TIME_BUDGET_MS) {
      let q = admin.from("direct_mail_pieces").select("id,line1,line2,city,state,zip")
        .eq("campaign_id", campaignId).eq("user_id", ownerId).eq("status", "queued").eq("verification_status", "unverified");
      if (cursor) q = q.gt("id", cursor);
      const { data: pieces, error } = await q.order("id", { ascending: true }).limit(BATCH);
      if (error) throw error;
      if (!pieces || pieces.length === 0) break;
      cursor = pieces[pieces.length - 1].id as string;

      const results = await Promise.all(pieces.map(async (p: Row) => ({
        piece: p,
        result: await verifyAddressWithLob({ fetchImpl: fetch, apiKey, version, address: { line1: p.line1, line2: p.line2, city: p.city, state: p.state, zip: p.zip } }),
      })));

      if (results.some((r) => r.result.kind === "auth")) return json({ error: "key_rejected" }, 409);

      let throttled = false;
      for (const { piece, result } of results) {
        tally.processed++;
        if (result.kind !== "ok") {
          tally.errors++;
          if (result.kind === "retry") throttled = true;
          continue;
        }
        const { error: applyError } = await admin.rpc("direct_mail_apply_verification", {
          p_user_id: ownerId, p_piece_id: piece.id, p_status: result.outcome.status, p_note: result.outcome.note, p_block: block,
        });
        if (applyError) {
          tally.errors++;
          continue;
        }
        tally[result.outcome.status]++;
      }
      if (throttled) await sleep(1500);
    }

    const { count: remaining } = await admin.from("direct_mail_pieces").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).eq("user_id", ownerId).eq("status", "queued").eq("verification_status", "unverified");

    return json({ ...tally, remaining: remaining ?? 0, blocking: block });
  } catch (e) {
    console.error(JSON.stringify({ event: "direct_mail_verify_failed", message: e instanceof Error ? e.message : String(e) }));
    return json({ error: "server_error" }, 500);
  }
});
