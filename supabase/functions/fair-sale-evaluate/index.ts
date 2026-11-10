// supabase/functions/fair-sale-evaluate/index.ts
//
// Dashboard / staff entry point for the Fair Sale Protocol. Evaluates a quote, contract, chat or call
// and returns the protections to offer, approvals needed and applicable counsel-approved rules.
// NOT LEGAL ADVICE.
//
// POST { subjectType, subjectId, customerId?, totalCents?, depositCents?, financingOfferedAtFirstContact?,
//        scopeEscalationPercent?, thirdPartyOrCashPaymentRequested?, optIns?, conversationSignals?,
//        customerTurns?, emergency?, customerEligibility?, truthVerdict?, counterpartyState?, address?, phone? }
//   or { action: "choice", sessionId, protection, choice }
//   or { action: "notify_trusted_contact", trustedContactId }
// Auth: the signed-in user's JWT (team members act on the account owner's data).
// Deploy: supabase functions deploy fair-sale-evaluate --no-verify-jwt   (auth is enforced in-code)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { recordCustomerChoice, runFairSale, type FairSaleRequest } from "../_shared/fair-sale/load.ts";
import { notifyTrustedContact } from "../_shared/fair-sale/trustedContact.ts";
import { CONVERSATION_SIGNAL_CODES, OPT_IN_CODES, PROTECTION_IDS, type ProtectionId } from "../_shared/fair-sale/types.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (v: unknown, n: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000_000 ? v : undefined);
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T[] => (Array.isArray(v) ? v.filter((x): x is T => (allowed as readonly string[]).includes(x as string)) : []);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "Invalid or expired session." }, 401);
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: ownerId, error: oErr } = await asUser.rpc("get_account_owner_id");
    if (oErr || !ownerId) return json({ error: "No account found for this user." }, 403);

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);

    if (body.action === "choice") {
      const protection = String(body.protection) as ProtectionId;
      const choice = String(body.choice);
      if (!(PROTECTION_IDS as readonly string[]).includes(protection) || !["accepted", "declined", "deferred"].includes(choice)) return json({ error: "Invalid protection or choice." }, 400);
      const r = await recordCustomerChoice(admin, ownerId as string, String(body.sessionId ?? ""), protection, choice as "accepted" | "declined" | "deferred", "staff", u.user.id);
      return json(r, r.ok ? 200 : 400);
    }
    if (body.action === "notify_trusted_contact") {
      // Notifying a third party is a manager action.
      const { data: can } = await asUser.rpc("compliance_can_manage");
      if (can !== true) return json({ error: "Only a manager can send this notice." }, 403);
      return json(await notifyTrustedContact(admin, ownerId as string, String(body.trustedContactId ?? "")));
    }

    const subjectType = String(body.subjectType);
    if (!["call", "chat", "quote", "contract"].includes(subjectType)) return json({ error: "subjectType must be call | chat | quote | contract." }, 400);
    const subjectId = clip(body.subjectId, 120);
    if (!subjectId) return json({ error: "subjectId is required." }, 400);
    const turns = Array.isArray(body.customerTurns) ? body.customerTurns.filter((t): t is string => typeof t === "string").slice(0, 60) : undefined;

    const request: FairSaleRequest = {
      subjectType: subjectType as FairSaleRequest["subjectType"], subjectId, customerId: clip(body.customerId, 64) ?? null,
      totalCents: int(body.totalCents), depositCents: int(body.depositCents),
      financingOfferedAtFirstContact: body.financingOfferedAtFirstContact === true ? true : undefined,
      scopeEscalationPercent: typeof body.scopeEscalationPercent === "number" && body.scopeEscalationPercent >= 0 && body.scopeEscalationPercent <= 1000 ? body.scopeEscalationPercent : undefined,
      thirdPartyOrCashPaymentRequested: body.thirdPartyOrCashPaymentRequested === true ? true : undefined,
      optIns: pick(body.optIns, OPT_IN_CODES), conversationSignals: pick(body.conversationSignals, CONVERSATION_SIGNAL_CODES), customerTurns: turns,
      emergency: body.emergency === "safety" || body.emergency === "active_damage" ? body.emergency : null,
      customerEligibility: Array.isArray(body.customerEligibility) ? body.customerEligibility.filter((x): x is string => typeof x === "string").slice(0, 5) : [],
      truthVerdict: body.truthVerdict === undefined ? undefined : clip(body.truthVerdict, 40) ?? null,
      counterpartyState: clip(body.counterpartyState, 5) ?? null, address: clip(body.address, 300) ?? null, phone: clip(body.phone, 32) ?? null,
      actor: { type: "staff", id: u.user.id },
    };
    return json({ result: await runFairSale(admin, ownerId as string, request) });
  } catch (e) {
    console.error(JSON.stringify({ event: "fair_sale_evaluate_failed", error: String(e) }));
    return json({ error: "Could not evaluate the Fair Sale Protocol." }, 500);
  }
});
