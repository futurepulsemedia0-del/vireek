// supabase/functions/mine-organizational-memory/index.ts
//
// Organizational Memory Genome — mining half.
//
// Cron-driven, deterministic, same philosophy as estimate-recovery-agent /
// detect-service-recovery-signals: reads real, already-resolved outcome
// columns and turns them into durable "lessons," never invents anything
// and never calls an LLM. Unlike the alert-style agents (which fire once
// and never again), this one UPSERTs on every run — confidence and sample
// size are live rolling stats, not one-time alerts, so they should refresh
// as more claims/contracts resolve.
//
// DEPLOYMENT: supabase functions deploy mine-organizational-memory
// --no-verify-jwt, then point cron at it once a day (this data moves slowly
// — no need for the 15-30 min cadence used by the alert-style agents) with
// the same X-Cron-Secret / CRON_SECRET header.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MIN_SAMPLE = 3;   // don't surface a pattern until it's happened at least this many times
const HIGH_RATE = 0.65; // at or above this win rate -> best_practice
const LOW_RATE = 0.35;  // at or below this win rate -> failure_pattern
// Between LOW_RATE and HIGH_RATE: not a clear enough signal either way, skip it — noise, not memory.

function confidenceFor(winRate: number, sampleSize: number): number {
  return Math.round(winRate * Math.min(1, sampleSize / 10) * 100);
}

interface MemoryRow {
  user_id: string;
  entry_type: "best_practice" | "failure_pattern";
  title: string;
  situation: string;
  action_taken: string;
  outcome_summary: string;
  confidence_score: number;
  sample_size: number;
  source: "warranty_claims" | "commercial_contracts";
  dedupe_key: string;
}

async function upsertEntries(admin: SupabaseClient, rows: MemoryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await admin.from("org_memory_entries").upsert(rows, { onConflict: "user_id,dedupe_key" });
  if (error) {
    console.error("org_memory_entries upsert failed:", error.message);
    return 0;
  }
  return rows.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const rows: MemoryRow[] = [];

  // -----------------------------------------------------------------
  // 1. WARRANTY CLAIM APPROVAL PATTERNS, BY DISTRIBUTOR
  // -----------------------------------------------------------------
  {
    const { data: claims } = await admin
      .from("warranty_claims")
      .select("user_id, distributor, status")
      .in("status", ["approved", "denied", "credit_received"])
      .not("distributor", "is", null);

    const groups = new Map<string, { userId: string; distributor: string; approved: number; total: number }>();
    for (const c of claims ?? []) {
      const key = `${c.user_id}::${c.distributor}`;
      const g = groups.get(key) ?? { userId: c.user_id, distributor: c.distributor as string, approved: 0, total: 0 };
      g.total++;
      if (c.status === "approved" || c.status === "credit_received") g.approved++;
      groups.set(key, g);
    }

    for (const g of groups.values()) {
      if (g.total < MIN_SAMPLE) continue;
      const rate = g.approved / g.total;
      if (rate > LOW_RATE && rate < HIGH_RATE) continue;
      const isGood = rate >= HIGH_RATE;

      rows.push({
        user_id: g.userId,
        entry_type: isGood ? "best_practice" : "failure_pattern",
        title: isGood ? `${g.distributor} approves warranty claims reliably` : `${g.distributor} rarely approves warranty claims`,
        situation: `Filing a manufacturer warranty claim with distributor "${g.distributor}".`,
        action_taken: isGood
          ? `Keep filing eligible claims with ${g.distributor} first — keep the packet checklist complete before submitting.`
          : `Before filing with ${g.distributor}, double-check eligibility and packet completeness, or escalate/call ahead — historical approval rate is low.`,
        outcome_summary: `${g.approved}/${g.total} claims approved or credited (${Math.round(rate * 100)}%).`,
        confidence_score: confidenceFor(rate, g.total),
        sample_size: g.total,
        source: "warranty_claims",
        dedupe_key: `warranty_claims:${g.distributor}`,
      });
    }
  }

  // -----------------------------------------------------------------
  // 2. CONTRACT RENEWAL PATTERNS, BY CONTRACT TYPE
  // -----------------------------------------------------------------
  {
    const { data: contracts } = await admin
      .from("commercial_contracts")
      .select("user_id, contract_type, status")
      .in("status", ["renewed", "terminated"]);

    const groups = new Map<string, { userId: string; type: string; renewed: number; total: number }>();
    for (const c of contracts ?? []) {
      const key = `${c.user_id}::${c.contract_type}`;
      const g = groups.get(key) ?? { userId: c.user_id, type: c.contract_type as string, renewed: 0, total: 0 };
      g.total++;
      if (c.status === "renewed") g.renewed++;
      groups.set(key, g);
    }

    for (const g of groups.values()) {
      if (g.total < MIN_SAMPLE) continue;
      const rate = g.renewed / g.total;
      if (rate > LOW_RATE && rate < HIGH_RATE) continue;
      const isGood = rate >= HIGH_RATE;
      const typeLabel = g.type.replace(/_/g, " ");

      rows.push({
        user_id: g.userId,
        entry_type: isGood ? "best_practice" : "failure_pattern",
        title: isGood ? `${typeLabel} contracts renew well` : `${typeLabel} contracts often don't renew`,
        situation: `A commercial ${typeLabel} contract nearing its end date.`,
        action_taken: isGood
          ? `Keep the current renewal outreach timing and terms for ${typeLabel} contracts — they're working.`
          : `Review pricing/terms and start renewal conversations earlier for ${typeLabel} contracts — historical renewal rate is low.`,
        outcome_summary: `${g.renewed}/${g.total} contracts renewed (${Math.round(rate * 100)}%).`,
        confidence_score: confidenceFor(rate, g.total),
        sample_size: g.total,
        source: "commercial_contracts",
        dedupe_key: `commercial_contracts:${g.type}`,
      });
    }
  }

  const written = await upsertEntries(admin, rows);
  return json({ ok: true, entries_written: written });
});
