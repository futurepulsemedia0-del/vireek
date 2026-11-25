// supabase/functions/ai-call-qa-sample/index.ts
//
// Cron entry point for human review of AI calls. Body: { action?: "sample" | "monthly" | "purge" } (default "sample").
//   sample  : every ~hour. Picks calls (random + risk-weighted) into ai_call_qa_items for opted-in accounts.
//   monthly : on the 1st. Builds last month's owner-visible report for opted-in accounts.
//   purge   : daily. Deletes items/reviews older than each account's retention_days.
// Auth: X-Cron-Secret == CRON_SECRET, or Bearer == service role key. Nothing else is accepted.
// This function uses the service role (RLS bypassed): EVERY query is explicitly scoped by the account owner id.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  DEFAULT_RISK_RATES, RISK_FLAGS, SAMPLING_VERSION, sampleCalls, type CandidateCall, type RiskRates,
} from "../_shared/ai-call-qa/sampling.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const LOOKBACK_HOURS = 36;
const MAX_CANDIDATES = 2000;
const MAX_ACCOUNTS = 500;
const BUDGET_MS = 100_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function parseRates(raw: unknown): Partial<RiskRates> {
  const out: Partial<RiskRates> = {};
  if (raw && typeof raw === "object") {
    for (const f of RISK_FLAGS) {
      const v = Number((raw as Record<string, unknown>)[f]);
      if (Number.isFinite(v)) out[f] = Math.min(1, Math.max(0, v));
    }
  }
  return { ...DEFAULT_RISK_RATES, ...out };
}

async function sampleAccount(db: SupabaseClient, s: Record<string, unknown>, now: Date): Promise<number> {
  const owner = String(s.account_owner_id);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const { count: today, error: cErr } = await db.from("ai_call_qa_items")
    .select("id", { count: "exact", head: true }).eq("account_owner_id", owner).gte("sampled_at", dayStart);
  if (cErr) throw new Error(`count: ${cErr.message}`);
  const remaining = Number(s.daily_cap) - (today ?? 0);
  if (remaining <= 0) return 0;

  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();
  const { data: calls, error: callErr } = await db.from("calls")
    .select("id, call_datetime, is_emergency, sentiment, tags, intent, price_lookups_performed, price_accuracy_status, human_transfer_requested")
    .eq("user_id", owner).not("vapi_call_id", "is", null).not("transcript", "is", null)
    .or("is_voicemail.is.null,is_voicemail.eq.false")
    .gte("call_datetime", since).order("call_datetime", { ascending: false }).limit(MAX_CANDIDATES);
  if (callErr) throw new Error(`calls: ${callErr.message}`);

  const { data: existing, error: exErr } = await db.from("ai_call_qa_items")
    .select("call_id").eq("account_owner_id", owner).gte("call_at", since).limit(5000);
  if (exErr) throw new Error(`existing: ${exErr.message}`);
  const seen = new Set((existing ?? []).map((r: { call_id: string }) => r.call_id));

  const candidates = ((calls ?? []) as CandidateCall[]).filter((c) => !seen.has(c.id));
  const picks = sampleCalls(candidates, {
    randomRate: Number(s.random_rate), riskRates: parseRates(s.risk_rates), remainingCap: remaining,
  });
  if (picks.length === 0) return 0;

  const rows = picks.map((p) => ({
    account_owner_id: owner, call_id: p.callId, call_at: p.callAt, stratum: p.stratum,
    risk_flags: p.riskFlags, priority: p.priority, sampling_version: SAMPLING_VERSION,
  }));
  const { error: insErr } = await db.from("ai_call_qa_items").upsert(rows, { onConflict: "call_id", ignoreDuplicates: true });
  if (insErr) throw new Error(`insert: ${insErr.message}`);
  return rows.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const cron = req.headers.get("X-Cron-Secret") ?? "";
  const authorized = (cronSecret !== "" && cron !== "" && safeEqual(cron, cronSecret)) || (serviceKey !== "" && bearer !== "" && safeEqual(bearer, serviceKey));
  if (!authorized) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!url || !serviceKey) return json({ error: "misconfigured" }, 500);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let action = "sample";
  try { const b = await req.json(); if (b && typeof b.action === "string") action = b.action; } catch { /* default */ }
  const started = Date.now();
  const now = new Date();

  try {
    if (action === "purge") {
      const { data, error } = await db.rpc("ai_call_qa_purge_expired");
      if (error) throw new Error(error.message);
      return json({ ok: true, purged: data });
    }
    if (action === "monthly") {
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      const { data, error } = await db.rpc("ai_call_qa_generate_reports", { p_month: prev });
      if (error) throw new Error(error.message);
      return json({ ok: true, month: prev, reports: data });
    }
    if (action !== "sample") return json({ error: "unknown_action" }, 400);

    const { data: accounts, error } = await db.from("ai_call_qa_settings")
      .select("account_owner_id, random_rate, daily_cap, risk_rates").eq("enabled", true).limit(MAX_ACCOUNTS);
    if (error) throw new Error(error.message);

    let queued = 0, failed = 0, processed = 0;
    for (const s of accounts ?? []) {
      if (Date.now() - started > BUDGET_MS) break;
      processed++;
      try { queued += await sampleAccount(db, s as Record<string, unknown>, now); }
      catch (e) { failed++; console.error("ai-call-qa-sample account failed", (e as Error).message); }
    }
    return json({ ok: true, accounts: processed, queued, failed });
  } catch (e) {
    console.error("ai-call-qa-sample failed", (e as Error).message);
    return json({ error: "internal_error" }, 500);
  }
});
