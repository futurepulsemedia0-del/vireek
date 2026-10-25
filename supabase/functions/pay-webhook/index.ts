// supabase/functions/pay-webhook/index.ts
//
// Provider webhooks for LIVE partners (and signed sandbox events). One endpoint, three kinds:
//   POST …/pay-webhook?kind=payouts   – transfer status updates
//   POST …/pay-webhook?kind=cards     – real-time card authorization requests (must answer fast)
//   POST …/pay-webhook?kind=capital   – lending status updates
// Deploy with --no-verify-jwt: authenticity = the adapter's signature check, never a JWT.
// With no configured live adapter, signature verification fails closed (HTTP 400).

import { adminClient, corsHeaders, json, logPay } from "../_shared/pay/http.ts";
import { getCardIssuer, getPayoutProvider } from "../_shared/pay/registry.ts";
import { CARD_COLUMNS, processCardAuthorization, type CardRow } from "../_shared/pay/cardAuth.ts";
import type { PayMode } from "../_shared/pay/types.ts";

const MODES: PayMode[] = ["live", "sandbox"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const kind = new URL(req.url).searchParams.get("kind");
  const payload = await req.text();
  if (payload.length > 256_000) return new Response("Payload too large", { status: 413 });
  const db = adminClient();

  try {
    if (kind === "payouts") {
      for (const mode of MODES) {
        const provider = getPayoutProvider(mode);
        if (!provider.isConfigured() || !(await provider.verifyWebhookSignature(payload, req.headers))) continue;
        const ev = provider.parseWebhookEvent(payload);
        if (!ev) return new Response("Unrecognized payload", { status: 400 });
        const { data: t } = await db.from("pay_transfers").select("id, sandbox").eq("provider", provider.id).eq("external_id", ev.externalId).maybeSingle();
        if (!t) return new Response("ok", { status: 200 });                      // ack: nothing to retry against
        if (t.sandbox !== (mode === "sandbox")) return new Response("mode mismatch", { status: 400 });
        const { data: res } = await db.rpc("pay_finalize_transfer", {
          p_transfer_id: t.id, p_status: ev.status, p_external_id: ev.externalId, p_failure_code: ev.failureCode ?? null, p_event: { source: "webhook" },
        });
        logPay("pay_webhook_payout", { transferId: t.id, status: ev.status, result: res?.status });
        return new Response("ok", { status: 200 });                              // invalid_transition is acked, not retried
      }
      return new Response("Invalid signature", { status: 400 });
    }

    if (kind === "cards") {
      for (const mode of MODES) {
        const issuer = getCardIssuer(mode);
        if (!issuer.isConfigured() || !(await issuer.verifyWebhookSignature(payload, req.headers))) continue;
        const ev = issuer.parseAuthorizationEvent(payload);
        if (!ev) return new Response("Unrecognized payload", { status: 400 });
        const { data: card } = await db.from("spend_cards").select(CARD_COLUMNS).eq("provider", issuer.id).eq("external_card_id", ev.externalCardId).maybeSingle();
        if (!card || card.sandbox !== (mode === "sandbox")) return json({ approved: false, decline_code: "card_not_active" });
        // The platform kill switch also stops card spend: a killed product declines everything.
        const { data: st } = await db.rpc("pay_product_state", { p_product: "spend_cards", p_tenant: card.user_id });
        if (!st?.available) return json({ approved: false, decline_code: "card_not_active" });
        const r = await processCardAuthorization(db, card as CardRow, {
          externalAuthId: ev.externalAuthId, amountCents: ev.amountCents, currency: ev.currency, merchantName: ev.merchantName, mcc: ev.mcc,
        }, Number(st.max_single_cents ?? 0));
        return json(r.decision.approved ? { approved: true } : { approved: false, decline_code: r.decision.declineCode });
      }
      return new Response("Invalid signature", { status: 400 });
    }

    // kind=capital: live lending status webhooks are partner-specific. Fail closed until an adapter parses them.
    return new Response("Unsupported kind", { status: 400 });
  } catch (error) {
    console.error(JSON.stringify({ event: "pay_webhook_failed", kind, error: error instanceof Error ? error.message : String(error) }));
    return new Response("error", { status: 500 });    // provider retries
  }
});
