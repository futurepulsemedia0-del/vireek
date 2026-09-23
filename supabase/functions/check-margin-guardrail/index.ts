// supabase/functions/check-margin-guardrail/index.ts
//
// Dynamic Margin Guardrails + Discount Governance: called right before a
// quote is sent (and whenever a discount is applied). Estimates real cost
// against the Price Book, compares the resulting margin to the account's
// margin_floor_pct, and returns/logs one of three verdicts:
//   - within_floor  — margin is at or above the floor, safe to send.
//   - blocked        — margin is below the floor and no override reason
//                       was supplied. The caller (frontend) must not send.
//   - overridden      — margin is below the floor but an authorized user
//                       supplied a reason, which is logged.
//
// Deterministic on purpose (same idiom as underpriced_job_detection /
// analyze-equipment-lifecycle): a margin floor is a number the owner set,
// and the verdict has to be reproducible and explainable, not an LLM
// guess. No external AI call is made here.
//
// Auth: caller's own Supabase JWT. The verdict is written with the
// service-role client so a team member can't forge a "within_floor"
// result via the REST API — this endpoint is the only writer of
// margin_guardrail_checks.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface LineItem { description: string; quantity: number; unit_price_cents: number }
interface PriceBookItem { service_name: string; keywords: string[]; estimated_cost_cents: number | null }

function matchPriceBookItem(description: string, items: PriceBookItem[]): PriceBookItem | null {
  const desc = description.toLowerCase().trim();
  if (!desc) return null;
  const exact = items.find((i) => i.service_name.toLowerCase() === desc);
  if (exact) return exact;
  const byKeyword = items.find(
    (i) => desc.includes(i.service_name.toLowerCase()) || (i.keywords ?? []).some((kw) => desc.includes(kw.toLowerCase())),
  );
  return byKeyword ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const body = await req.json();
    const quoteId: string | undefined = body.quoteId;
    const overrideReason: string | undefined = typeof body.overrideReason === "string" ? body.overrideReason.trim() : undefined;
    // Optional: check a not-yet-saved discount before it's written to the quote.
    const discountType: "percent" | "flat" | null = body.discountType === "percent" || body.discountType === "flat" ? body.discountType : null;
    const discountValue: number = Number(body.discountValue) || 0;

    if (!quoteId) return json({ error: "Missing quoteId." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // Quote + business profile read through the caller's own client —
    // RLS already scopes both to the account, so a stranger's quoteId 404s.
    const { data: quote, error: quoteError } = await callerClient
      .from("quotes")
      .select("id, user_id, line_items, tax_percent, discount_type, discount_value")
      .eq("id", quoteId)
      .maybeSingle();
    if (quoteError || !quote) return json({ error: "Quote not found." }, 404);

    const { data: profile } = await callerClient
      .from("business_profile")
      .select("margin_floor_pct, default_cost_ratio_pct")
      .eq("user_id", quote.user_id)
      .maybeSingle();

    const marginFloorPct = Number(profile?.margin_floor_pct ?? 20);
    const defaultCostRatioPct = Number(profile?.default_cost_ratio_pct ?? 55);

    const { data: priceBookItems } = await callerClient
      .from("price_book_items")
      .select("service_name, keywords, estimated_cost_cents")
      .eq("user_id", quote.user_id)
      .eq("active", true);

    const lineItems = (quote.line_items ?? []) as LineItem[];
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return json({ error: "This quote has no line items to check." }, 400);
    }

    const effectiveDiscountType = discountType ?? (quote.discount_type as "percent" | "flat" | null);
    const effectiveDiscountValue = discountType ? discountValue : Number(quote.discount_value ?? 0);

    let revenueCents = 0;
    let costCents = 0;
    const breakdown: { description: string; revenue_cents: number; cost_cents: number; matched: boolean }[] = [];

    for (const li of lineItems) {
      const lineRevenue = Math.round((Number(li.quantity) || 0) * (Number(li.unit_price_cents) || 0));
      const match = matchPriceBookItem(li.description ?? "", (priceBookItems as PriceBookItem[]) ?? []);
      const lineCost = match?.estimated_cost_cents != null
        ? Math.round(match.estimated_cost_cents * (Number(li.quantity) || 1))
        : Math.round(lineRevenue * (defaultCostRatioPct / 100));

      revenueCents += lineRevenue;
      costCents += lineCost;
      breakdown.push({ description: li.description, revenue_cents: lineRevenue, cost_cents: lineCost, matched: !!match });
    }

    if (effectiveDiscountType === "percent" && effectiveDiscountValue > 0) {
      revenueCents -= Math.round(revenueCents * (effectiveDiscountValue / 100));
    } else if (effectiveDiscountType === "flat" && effectiveDiscountValue > 0) {
      revenueCents -= Math.round(effectiveDiscountValue * 100);
    }
    revenueCents = Math.max(0, revenueCents);

    const marginPct = revenueCents > 0 ? Number((((revenueCents - costCents) / revenueCents) * 100).toFixed(1)) : null;
    const withinFloor = marginPct === null || marginPct >= marginFloorPct;

    let verdict: "within_floor" | "blocked" | "overridden";
    if (withinFloor) {
      verdict = "within_floor";
    } else if (overrideReason) {
      // Only the account owner, or a team member with can_view_billing,
      // may authorize an override — same permission the app already uses
      // to gate margin-sensitive pages like Profitability and Underpriced Jobs.
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

      let requestedBy: string | null = null;
      let authorized = user.id === quote.user_id; // account owner
      if (!authorized) {
        const { data: member } = await admin
          .from("team_members")
          .select("id, account_owner_id, permissions")
          .eq("member_email", (user.email ?? "").toLowerCase())
          .maybeSingle();
        if (member && member.account_owner_id === quote.user_id) {
          requestedBy = member.id;
          authorized = !!(member.permissions as Record<string, boolean> | null)?.can_view_billing;
        }
      }

      if (!authorized) {
        return json({ error: "Only an account owner or a team member with billing access can override the margin floor." }, 403);
      }

      verdict = "overridden";

      await admin.from("quotes").update({
        margin_override_reason: overrideReason,
        margin_override_by: requestedBy,
        margin_override_at: new Date().toISOString(),
      }).eq("id", quoteId);
    } else {
      verdict = "blocked";
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    await admin.from("margin_guardrail_checks").insert({
      user_id: quote.user_id,
      quote_id: quoteId,
      revenue_cents: revenueCents,
      estimated_cost_cents: costCents,
      margin_pct: marginPct,
      margin_floor_pct: marginFloorPct,
      verdict,
      override_reason: verdict === "overridden" ? overrideReason : null,
      line_item_breakdown: breakdown,
    });

    await admin.from("quotes").update({
      estimated_cost_cents: costCents,
      estimated_margin_pct: marginPct,
      margin_guardrail_status: verdict,
    }).eq("id", quoteId);

    return json({
      verdict,
      revenue_cents: revenueCents,
      estimated_cost_cents: costCents,
      margin_pct: marginPct,
      margin_floor_pct: marginFloorPct,
      breakdown,
      can_send: verdict !== "blocked",
    });
  } catch (err) {
    console.error("[check-margin-guardrail] unhandled error", err);
    return json({ error: "Something went wrong checking the margin guardrail." }, 500);
  }
});
