// supabase/functions/compliance-evaluate/index.ts
//
// Evaluates the account's applicable, counsel-approved rule packs for a call,
// text, email, quote or contract and returns findings + required actions.
// NOT LEGAL ADVICE — see the rule-review workflow in the dashboard.
//
// POST { surface, purpose?, customerId?, phone?, email?, address?, counterpartyState?,
//        aiVoice?, aiGenerated?, disclosureGiven?, outbound?, document?, subjectType?, subjectId?, log? }
// Auth: the signed-in user's JWT (team members evaluate against the account owner's data).
// Deploy: supabase functions deploy compliance-evaluate --no-verify-jwt   (auth is enforced in-code)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateForAccount, type EvaluateRequest } from "../_shared/compliance-rules/load.ts";
import { SURFACES } from "../_shared/compliance-rules/types.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PURPOSES = new Set(["marketing", "service", "emergency"]);
const clip = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

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

    // Resolve the account owner exactly as RLS does, as the caller.
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: ownerId, error: oErr } = await asUser.rpc("get_account_owner_id");
    if (oErr || !ownerId) return json({ error: "No account found for this user." }, 403);

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);

    if (!(SURFACES as readonly string[]).includes(String(body.surface))) return json({ error: "surface must be call | sms | email | quote | contract." }, 400);
    if (body.purpose !== undefined && !PURPOSES.has(String(body.purpose))) return json({ error: "purpose must be marketing | service | emergency." }, 400);
    const doc = body.document;
    if (doc !== undefined && (typeof doc !== "object" || doc === null || Array.isArray(doc))) return json({ error: "document must be an object." }, 400);

    const request: EvaluateRequest = {
      surface: body.surface as EvaluateRequest["surface"],
      purpose: body.purpose as EvaluateRequest["purpose"],
      customerId: clip(body.customerId, 64),
      phone: clip(body.phone, 32), email: clip(body.email, 254), address: clip(body.address, 300),
      counterpartyState: clip(body.counterpartyState, 5),
      aiVoice: body.aiVoice === true, aiGenerated: body.aiGenerated === true, disclosureGiven: body.disclosureGiven === true,
      outbound: body.outbound === false ? false : true,
      document: doc as EvaluateRequest["document"],
      subjectType: clip(body.subjectType, 40) ?? undefined, subjectId: clip(body.subjectId, 80) ?? undefined,
      source: "dashboard", log: body.log !== false,
    };
    const result = await evaluateForAccount(admin, ownerId as string, request);
    return json({ result });
  } catch (e) {
    console.error(JSON.stringify({ event: "compliance_evaluate_failed", error: String(e) }));
    return json({ error: "Could not evaluate compliance rules." }, 500);
  }
});
