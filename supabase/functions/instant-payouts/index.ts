import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadPricing, parseRequestInput } from "../_shared/instantPayouts/logic.ts";
import {
  createExpressLoginLink,
  createInstantPayout,
  getInstantBalance,
  listExternalAccounts,
  type StripeCtx,
} from "../_shared/instantPayouts/stripeApi.ts";
import {
  ServiceError,
  getDashboardLink,
  getEligibility,
  requestPayout,
  resumePayout,
  type Actor,
  type ConnectRow,
  type Deps,
  type Gateway,
  type PayoutRow,
  type Store,
} from "../_shared/instantPayouts/service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/**
 * Same owner resolution as public.get_account_owner_id(): a team_members row (by user_id) wins,
 * otherwise the caller is the account owner. Owners and team members with role owner/admin may cash out.
 */
async function authorize(admin: SupabaseClient, req: Request): Promise<Actor | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const user = data.user;

  const { data: rows } = await admin.from("team_members").select("account_owner_id, role").eq("user_id", user.id).limit(1);
  const member = (rows as Row[] | null)?.[0];
  if (!member) return { userId: user.id, email: user.email ?? "", ownerId: user.id, canManage: true };
  return {
    userId: user.id,
    email: user.email ?? "",
    ownerId: member.account_owner_id,
    canManage: member.role === "owner" || member.role === "admin",
  };
}

const PAYOUT_COLUMNS =
  "id, user_id, stripe_account_id, idempotency_key, amount_cents, fee_cents, currency, destination_id, destination_label, status, stripe_payout_id, failure_code, failure_message, arrival_date, completed_at, created_at";

function makeStore(admin: SupabaseClient): Store {
  return {
    async getConnect(ownerId) {
      const { data } = await admin
        .from("stripe_connect_accounts")
        .select("stripe_account_id, details_submitted, payouts_enabled, created_at")
        .eq("user_id", ownerId)
        .maybeSingle();
      return (data as ConnectRow | null) ?? null;
    },
    async hasOpenDispute(ownerId) {
      const { data, error } = await admin.rpc("instant_payout_has_open_dispute", { p_user_id: ownerId });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async reserve({ ownerId, actor, stripeAccountId, idempotencyKey, amountCents, feeCents, destination }) {
      const { data, error } = await admin.rpc("instant_payout_reserve", {
        p_user_id: ownerId,
        p_actor_id: actor.userId,
        p_actor_email: actor.email,
        p_stripe_account_id: stripeAccountId,
        p_idempotency_key: idempotencyKey,
        p_amount_cents: amountCents,
        p_fee_cents: feeCents,
        p_currency: "usd",
        p_destination_id: destination.id,
        p_destination_label: destination.label,
      });
      if (error) {
        // P0001 = our own RAISE EXCEPTION messages (safe, user-fixable). Anything else stays generic.
        if (error.code === "P0001") throw new ServiceError(error.message, 409, "reserve_rejected");
        throw new Error(error.message);
      }
      return data as PayoutRow;
    },
    async getPayout(ownerId, id) {
      const { data } = await admin.from("instant_payouts").select(PAYOUT_COLUMNS).eq("id", id).eq("user_id", ownerId).maybeSingle();
      return (data as PayoutRow | null) ?? null;
    },
    async findByKey(ownerId, key) {
      const { data } = await admin.from("instant_payouts").select(PAYOUT_COLUMNS).eq("user_id", ownerId).eq("idempotency_key", key).maybeSingle();
      return (data as PayoutRow | null) ?? null;
    },
    async markSent({ id, stripePayoutId, status, feeCents, arrival }) {
      const { data, error } = await admin.rpc("instant_payout_mark_sent", {
        p_id: id,
        p_stripe_payout_id: stripePayoutId,
        p_status: status,
        p_fee_cents: feeCents,
        p_arrival: arrival,
      });
      if (error) throw new Error(error.message);
      return data as PayoutRow;
    },
    async markFailed({ id, code, message }) {
      const { data, error } = await admin.rpc("instant_payout_mark_failed", { p_id: id, p_failure_code: code, p_failure_message: message });
      if (error) throw new Error(error.message);
      return data as PayoutRow;
    },
    async listRecent(ownerId, limit) {
      const { data } = await admin
        .from("instant_payouts")
        .select(PAYOUT_COLUMNS)
        .eq("user_id", ownerId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return (data as PayoutRow[] | null) ?? [];
    },
  };
}

function makeGateway(ctx: StripeCtx): Gateway {
  return {
    getInstantBalance: (accountId) => getInstantBalance(ctx, accountId),
    listExternalAccounts: (accountId) => listExternalAccounts(ctx, accountId),
    createInstantPayout: (accountId, input) => createInstantPayout(ctx, accountId, input),
    createExpressLoginLink: (accountId) => createExpressLoginLink(ctx, accountId),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const actor = await authorize(admin, req);
    if (actor instanceof Response) return actor;

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY)." }, 500);

    const parsed = parseRequestInput(await req.json().catch(() => null));
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = parsed.value;

    const minAge = Number(Deno.env.get("INSTANT_PAYOUT_MIN_ACCOUNT_AGE_DAYS") ?? "0");
    const deps: Deps = {
      store: makeStore(admin),
      stripe: makeGateway({ secretKey }),
      pricing: loadPricing((k) => Deno.env.get(k)),
      minAccountAgeDays: Number.isInteger(minAge) && minAge >= 0 && minAge <= 365 ? minAge : 0,
      now: () => new Date(),
      log: (event, data) => console.log(JSON.stringify({ event, ...data })),
    };

    switch (input.action) {
      case "eligibility":
        return json(await getEligibility(deps, actor));
      case "dashboard_link":
        return json({ url: await getDashboardLink(deps, actor) });
      case "request": {
        const out = await requestPayout(deps, actor, input);
        return json({ payout: out.payout, warning: out.warning, message: out.message }, out.httpStatus);
      }
      case "resume": {
        const out = await resumePayout(deps, actor, input.payoutId);
        return json({ payout: out.payout, warning: out.warning, message: out.message }, out.httpStatus);
      }
    }
    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    if (error instanceof ServiceError) return json({ error: error.message, code: error.code, ...error.extra }, error.status);
    console.error(JSON.stringify({ event: "instant_payouts_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong with the instant payout." }, 500);
  }
});
