// supabase/functions/billing-invoices/index.ts
//
// Read-only feed for /dashboard/billing/invoices: the account's Vireek
// subscription invoices (with Stripe's own PDF + hosted-invoice links) and the
// cards on file. Data is read live from Stripe, so it is always the legal
// record — nothing is mirrored into our database.
//
// Access: the account owner, or an active team member whose permissions grant
// can_view_billing. Members read the OWNER's Stripe customer, so the owner's
// profile — never the caller's — decides which customer is queried.
//
// Required secrets (already set for the other billing functions):
//   STRIPE_SECRET_KEY
//
// Deploy:
//   supabase functions deploy billing-invoices

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  canViewBilling,
  normalizeCard,
  normalizeInvoice,
  sortCards,
  type CardDto,
  type InvoiceDto,
  type StripeInvoiceLike,
} from "../_shared/billing/subscriptionInvoices.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const PAGE_SIZE = 20;
const CURSOR_PATTERN = /^in_[A-Za-z0-9_]{6,100}$/;

interface InvoicesResponse {
  hasBillingAccount: boolean;
  invoices: InvoiceDto[];
  cards: CardDto[];
  hasMore: boolean;
  nextCursor: string | null;
  canManagePaymentMethods: boolean;
}

const first = <T>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const cursor: string | null = typeof body?.cursor === "string" ? body.cursor : null;
    if (cursor !== null && !CURSOR_PATTERN.test(cursor)) return jsonResponse({ error: "Invalid cursor." }, 400);

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

    const { data: profile } = await admin
      .from("profiles")
      .select("id, email, role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!profile) return jsonResponse({ error: "Account not found." }, 403);

    // Resolve whose billing this is, and whether the caller may see it.
    const isOwner = profile.role === "owner";
    let billingOwnerId: string = profile.id;
    let member: Parameters<typeof canViewBilling>[0]["member"] = null;

    if (!isOwner) {
      const { data: tm } = await admin
        .from("team_members")
        .select("account_owner_id, invite_status, permissions, custom_role:custom_roles(permissions)")
        .eq("member_email", profile.email)
        .maybeSingle();
      if (tm) {
        billingOwnerId = tm.account_owner_id as string;
        const customRole = first(tm.custom_role as { permissions?: Record<string, boolean> } | { permissions?: Record<string, boolean> }[] | null);
        member = {
          inviteStatus: tm.invite_status as string,
          permissions: tm.permissions as Record<string, boolean> | null,
          customRolePermissions: customRole?.permissions ?? null,
        };
      }
    }

    if (!canViewBilling({ profileRole: profile.role, member })) {
      return jsonResponse({ error: "You don't have permission to view billing." }, 403);
    }

    const { data: ownerProfile } = await admin
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("id", billingOwnerId)
      .maybeSingle();

    const empty: InvoicesResponse = {
      hasBillingAccount: false,
      invoices: [],
      cards: [],
      hasMore: false,
      nextCursor: null,
      canManagePaymentMethods: isOwner,
    };
    const customerId = ownerProfile?.stripe_customer_id as string | undefined;
    if (!customerId) return jsonResponse(empty);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) return jsonResponse({ error: "Billing is not configured yet (missing STRIPE_SECRET_KEY)." }, 500);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });

    const wantCards = cursor === null; // cards only travel with the first page
    const [invoicePage, customer, paymentMethods] = await Promise.all([
      stripe.invoices.list({ customer: customerId, limit: PAGE_SIZE, ...(cursor ? { starting_after: cursor } : {}) }),
      wantCards ? stripe.customers.retrieve(customerId) : Promise.resolve(null),
      wantCards ? stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 10 }) : Promise.resolve(null),
    ]);

    if (customer && "deleted" in customer && customer.deleted) return jsonResponse(empty);

    const invoices = invoicePage.data
      .map((inv) => normalizeInvoice(inv as unknown as StripeInvoiceLike))
      .filter((inv): inv is InvoiceDto => inv !== null);
    const lastRaw = invoicePage.data[invoicePage.data.length - 1];

    let cards: CardDto[] = [];
    if (paymentMethods) {
      let defaultId: string | null = null;
      if (customer && !("deleted" in customer && customer.deleted)) {
        const dpm = customer.invoice_settings?.default_payment_method;
        defaultId = typeof dpm === "string" ? dpm : (dpm?.id ?? null);
      }
      const subscriptionId = ownerProfile?.stripe_subscription_id as string | undefined;
      if (!defaultId && subscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const spm = sub.default_payment_method;
          defaultId = typeof spm === "string" ? spm : (spm?.id ?? null);
        } catch {
          // A missing/cancelled subscription just means no default can be inferred.
        }
      }
      cards = sortCards(
        paymentMethods.data
          .map((pm) => normalizeCard(pm, defaultId))
          .filter((c): c is CardDto => c !== null),
      );
    }

    const payload: InvoicesResponse = {
      hasBillingAccount: true,
      invoices,
      cards,
      hasMore: invoicePage.has_more,
      nextCursor: invoicePage.has_more && lastRaw ? lastRaw.id : null,
      canManagePaymentMethods: isOwner,
    };
    return jsonResponse(payload);
  } catch (error) {
    console.error(JSON.stringify({ event: "billing_invoices_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "We couldn't load your invoices right now. Please try again." }, 500);
  }
});
