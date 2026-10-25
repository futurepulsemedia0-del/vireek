// supabase/functions/direct-mail-send/index.ts
//
// Sends (or resumes) a postcard campaign through the print API. Authenticated; the caller must be a manager.
// POST { campaign_id } -> { status, processed, submitted, failed, remaining }
//
// The function is RESUMABLE and SAFE TO RE-INVOKE: it works in time-boxed chunks (the dashboard keeps calling
// until remaining = 0). Pieces are claimed atomically (SKIP LOCKED) and every print request carries
// Idempotency-Key = piece id, so a crash/retry can never print a mailer twice.
// Required secrets: DIRECT_MAIL_KEY, SITE_URL. Optional: LOB_API_VERSION.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import QRCode from "npm:qrcode@1.5.4";
import { decryptSecret } from "../_shared/direct-mail/crypto.ts";
import {
  buildBackHtml, buildFrontHtml, buildLobPostcardPayload, campaignUtm, isRetryableHttpStatus, normalizeAddress,
  parseProviderPriceCents, scanUrl, validateAddress, type MailType, type PostcardSize,
} from "../_shared/direct-mail/engine.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TIME_BUDGET_MS = 90_000;
const BATCH = 10;
const MAX_ATTEMPTS = 3;
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://vireek.com").replace(/\/+$/, "");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function qrSvg(url: string): Promise<string> {
  return await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q", margin: 0 });
}

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
    const { data: campaign } = await admin.from("direct_mail_campaigns").select("*").eq("id", campaignId).eq("user_id", ownerId).maybeSingle<Row>();
    if (!campaign) return json({ error: "campaign_not_found" }, 404);
    if (!["draft", "sending", "paused"].includes(campaign.status)) return json({ error: "campaign_not_sendable" }, 409);

    const { data: settings } = await admin.from("direct_mail_settings").select("*").eq("user_id", ownerId).maybeSingle<Row>();
    if (!settings?.encrypted_api_key) return json({ error: "provider_not_configured" }, 409);
    const from = normalizeAddress({
      name: settings.return_name, line1: settings.return_line1, line2: settings.return_line2,
      city: settings.return_city, state: settings.return_state, zip: settings.return_zip,
    });
    if (validateAddress(from).length) return json({ error: "return_address_missing" }, 409);

    const { data: landing } = campaign.landing_page_id
      ? await admin.from("landing_pages").select("status").eq("id", campaign.landing_page_id).eq("user_id", ownerId).maybeSingle<Row>()
      : { data: null };
    if (!landing || landing.status !== "published") return json({ error: "landing_page_not_published" }, 409);
    if (!campaign.headline || !campaign.offer) return json({ error: "creative_incomplete" }, 409);

    const { count: queuedTotal } = await admin
      .from("direct_mail_pieces").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).in("status", ["queued", "submitting"]);
    if (!queuedTotal) return json({ error: "nothing_to_send" }, 409);

    if (campaign.status !== "sending") {
      await admin.from("direct_mail_campaigns").update({ status: "sending" }).eq("id", campaignId);
    }

    const apiKey = await decryptSecret(settings.encrypted_api_key);
    const auth = `Basic ${btoa(`${apiKey}:`)}`;
    const lobVersion = Deno.env.get("LOB_API_VERSION");
    const started = Date.now();
    let submitted = 0;
    let failed = 0;
    let processed = 0;
    let paused = false;

    outer: while (Date.now() - started < TIME_BUDGET_MS) {
      // Budget guard BEFORE each batch: never start a batch that could exceed the cap.
      if (campaign.budget_cap_cents) {
        const { data: spent } = await admin.rpc("direct_mail_campaign_spend", { p_campaign_id: campaignId });
        const projected = Number(spent ?? 0) + BATCH * Number(campaign.est_unit_cost_cents ?? 0);
        if (projected > campaign.budget_cap_cents) {
          await admin.from("direct_mail_campaigns").update({ status: "paused" }).eq("id", campaignId);
          paused = true;
          break;
        }
      }
      // Honour pause/cancel pressed in the dashboard while we are running.
      const { data: live } = await admin.from("direct_mail_campaigns").select("status").eq("id", campaignId).maybeSingle<Row>();
      if (!live || live.status !== "sending") { paused = true; break; }

      const { data: claimed, error: claimError } = await admin.rpc("direct_mail_claim_pieces", { p_campaign_id: campaignId, p_limit: BATCH });
      if (claimError) throw claimError;
      const pieces = (claimed ?? []) as Row[];
      if (pieces.length === 0) break;

      const results = await Promise.all(pieces.map(async (piece) => {
        const to = normalizeAddress({ name: piece.recipient_name, line1: piece.line1, line2: piece.line2, city: piece.city, state: piece.state, zip: piece.zip });
        const art = {
          size: campaign.size as PostcardSize, brand: settings.return_name as string, headline: campaign.headline, offer: campaign.offer,
          cta: campaign.cta, phone: campaign.phone, accent: campaign.accent_color, code: piece.tracking_code,
          scanUrl: scanUrl(SITE_URL, piece.tracking_code), qrSvg: await qrSvg(scanUrl(SITE_URL, piece.tracking_code)),
        };
        const payload = buildLobPostcardPayload({
          size: campaign.size, mailType: campaign.mail_type as MailType,
          front: buildFrontHtml(art), back: buildBackHtml(art), to, from,
          description: `${campaign.name} - ${piece.tracking_code}`,
          metadata: { piece_id: piece.id, campaign_id: campaignId, tracking_code: piece.tracking_code, utm_campaign: campaignUtm(campaignId) },
        });

        try {
          const res = await fetch("https://api.lob.com/v1/postcards", {
            method: "POST",
            headers: {
              Authorization: auth, "Content-Type": "application/json", "Idempotency-Key": piece.id,
              ...(lobVersion ? { "Lob-Version": lobVersion } : {}),
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data?.id) {
            const providerCost = parseProviderPriceCents(data.price);
            await admin.from("direct_mail_pieces").update({
              status: "submitted", provider_id: data.id, provider_url: typeof data.url === "string" ? data.url : null,
              expected_delivery: data.expected_delivery_date ?? null,
              cost_cents: providerCost ?? Number(campaign.est_unit_cost_cents ?? 0), cost_estimated: providerCost === null,
              submitted_at: new Date().toISOString(), last_error: null,
            }).eq("id", piece.id).eq("status", "submitting");
            return "submitted" as const;
          }
          const message = String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
          const retry = isRetryableHttpStatus(res.status) && piece.attempts < MAX_ATTEMPTS;
          await admin.from("direct_mail_pieces").update({ status: retry ? "queued" : "failed", last_error: message }).eq("id", piece.id).eq("status", "submitting");
          if (res.status === 401 || res.status === 403) return "auth" as const;
          return retry ? ("retry" as const) : ("failed" as const);
        } catch (e) {
          const retry = piece.attempts < MAX_ATTEMPTS;
          await admin.from("direct_mail_pieces").update({
            status: retry ? "queued" : "failed", last_error: (e instanceof Error ? e.message : "network_error").slice(0, 300),
          }).eq("id", piece.id).eq("status", "submitting");
          return retry ? ("retry" as const) : ("failed" as const);
        }
      }));

      processed += pieces.length;
      submitted += results.filter((r) => r === "submitted").length;
      failed += results.filter((r) => r === "failed").length;

      if (results.includes("auth")) {
        // Provider rejected the key: stop immediately and let the owner fix the credentials.
        await admin.from("direct_mail_campaigns").update({ status: "paused" }).eq("id", campaignId);
        return json({ status: "paused", reason: "provider_auth_failed", processed, submitted, failed, remaining: queuedTotal - submitted - failed });
      }
      if (results.includes("retry")) await sleep(1500);
      if (Date.now() - started >= TIME_BUDGET_MS) break outer;
    }

    const { count: remaining } = await admin
      .from("direct_mail_pieces").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).in("status", ["queued", "submitting"]);

    let status = paused ? "paused" : "sending";
    if (!remaining && !paused) {
      status = "completed";
      await admin.from("direct_mail_campaigns").update({ status: "completed", sent_at: new Date().toISOString() }).eq("id", campaignId);
    }
    return json({ status, processed, submitted, failed, remaining: remaining ?? 0 });
  } catch (e) {
    console.error(JSON.stringify({ event: "direct_mail_send_failed", message: e instanceof Error ? e.message : String(e) }));
    return json({ error: "server_error" }, 500);
  }
});
