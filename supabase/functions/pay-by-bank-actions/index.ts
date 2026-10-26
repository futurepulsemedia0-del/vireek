import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripe } from "../_shared/paymentPlans/stripe.ts";

// Authenticated owner/billing actions: { action: 'capability_status' } | { action: 'enable_capability' }
// ACH debits on a connected account need the `us_bank_account_ach_payments` capability (Stripe Connect).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const toStatus = (s: unknown): "inactive" | "pending" | "active" => (s === "active" ? "active" : s === "pending" ? "pending" : "inactive");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.");
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) throw new HttpError(401, "Invalid or expired session.");
    const caller = userData.user;

    const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
    let ownerId = profile?.id as string | undefined;
    if (!ownerId) {
      const { data: member } = await admin.from("team_members").select("account_owner_id, permissions").eq("member_email", caller.email ?? "").maybeSingle();
      if (!member?.account_owner_id || !member.permissions?.can_view_billing) throw new HttpError(403, "You don't have permission to manage bank payments.");
      ownerId = member.account_owner_id;
    }

    const body = await req.json().catch(() => ({}));
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new HttpError(500, "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY).");
    if (Deno.env.get("STRIPE_ACH_DEBIT_ENABLED") !== "true") throw new HttpError(409, "ACH debits aren't switched on for this platform yet (STRIPE_ACH_DEBIT_ENABLED).");

    const { data: connect } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", ownerId).maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) throw new HttpError(400, "Connect and finish verifying your Stripe account first.");

    if (body.action === "enable_capability") {
      await stripe("POST", `accounts/${connect.stripe_account_id}`, secretKey, { capabilities: { us_bank_account_ach_payments: { requested: true } } }, `ach-cap-${connect.stripe_account_id}`);
    } else if (body.action !== "capability_status") {
      throw new HttpError(400, "Unknown action.");
    }

    const account = await stripe("GET", `accounts/${connect.stripe_account_id}`, secretKey);
    const status = toStatus(account?.capabilities?.us_bank_account_ach_payments);
    const { error } = await admin.from("bank_payment_settings").upsert(
      { user_id: ownerId, capability_status: status, capability_checked_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    return json({ ok: true, capability_status: status });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ event: "pay_by_bank_actions_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
