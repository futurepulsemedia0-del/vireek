// supabase/functions/flywheel-engine/index.ts
//
// Compounding Intelligence Flywheel — Harvest, Promote, Measure.
//
// HARVEST: reads org_memory_entries and business_immune_signals — no
//          new capture tables, everything already exists.
// PROMOTE: turns a confidence-cleared lesson, or a repeatedly-confirmed
//          threat detector, into a real next_best_actions row exactly
//          once (guarded by flywheel_promotions' unique indexes).
// MEASURE: writes one flywheel_snapshots row per account per day,
//          deterministically scored against the previous snapshot.
//
// Optional body: { "single_user_id": "<uuid>" } — used by the
// dashboard's "Run flywheel now" button to process just that account
// instead of the full cron sweep.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MIN_LESSON_CONFIDENCE = 75;
const MIN_LESSON_SAMPLE_SIZE = 5;
const MIN_THREAT_TRUE_POSITIVES = 3;

// ---------------------------------------------------------------
// PROMOTE — org_memory_entries -> next_best_actions
// ---------------------------------------------------------------
async function promoteMemoryEntries(admin: SupabaseClient, userId: string): Promise<{ created: number }> {
  const { data: entries } = await admin
    .from("org_memory_entries")
    .select("id, entry_type, title, situation, action_taken, outcome_summary, confidence_score, sample_size")
    .eq("user_id", userId)
    .eq("status", "active")
    .is("promoted_at", null)
    .gte("confidence_score", MIN_LESSON_CONFIDENCE);

  let created = 0;
  for (const entry of entries ?? []) {
    if ((entry.sample_size ?? 0) < MIN_LESSON_SAMPLE_SIZE) continue;

    const verb = entry.entry_type === "failure_pattern" ? "Avoid repeating" : "Turn into a standing rule";
    const { data: nba, error: nbaError } = await admin
      .from("next_best_actions")
      .insert({
        user_id: userId,
        category: "compounding_insight",
        title: `${verb}: ${entry.title}`,
        reasoning: `Confidence ${entry.confidence_score}/100 across ${entry.sample_size} sample(s). ${entry.outcome_summary ?? entry.situation ?? ""}`.trim(),
        recommended_action: entry.action_taken ?? "Review this pattern and decide whether to formalize it as policy or an automation.",
        priority_score: entry.confidence_score,
        entity_type: "org_memory_entry",
        entity_id: entry.id,
        entity_label: entry.title,
        cta_href: "/dashboard/organizational-memory",
      })
      .select("id")
      .single();
    if (nbaError || !nba) continue;

    await admin.from("org_memory_entries").update({ promoted_at: new Date().toISOString() }).eq("id", entry.id);
    const { error: promoError } = await admin.from("flywheel_promotions").insert({
      user_id: userId,
      source_type: "org_memory_entry",
      source_id: entry.id,
      next_best_action_id: nba.id,
      detail: `Promoted at confidence ${entry.confidence_score}`,
    });
    if (!promoError) created++;
  }
  return { created };
}

// ---------------------------------------------------------------
// PROMOTE — repeatedly-confirmed business_immune_signals detectors
// ---------------------------------------------------------------
async function promoteConfirmedThreats(admin: SupabaseClient, userId: string): Promise<{ created: number }> {
  const { data: rows } = await admin
    .from("business_immune_signals")
    .select("id, detector, category, title")
    .eq("user_id", userId)
    .eq("resolved_outcome", "true_positive")
    .is("flywheel_promoted_at", null);

  const byDetector = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const list = byDetector.get(r.detector as string) ?? [];
    list.push(r);
    byDetector.set(r.detector as string, list);
  }

  let created = 0;
  for (const [detector, group] of byDetector) {
    if (!group || group.length < MIN_THREAT_TRUE_POSITIVES) continue;
    const sample = group[0];

    const { data: nba, error: nbaError } = await admin
      .from("next_best_actions")
      .insert({
        user_id: userId,
        category: "compounding_insight",
        title: `Confirmed recurring threat: ${sample.title}`,
        reasoning: `The "${detector}" detector has been confirmed as a real problem ${group.length} time(s) — this is no longer a one-off.`,
        recommended_action: "Consider building a permanent automation or policy so this stops needing manual review each time it fires.",
        priority_score: 70,
        entity_type: "business_immune_detector",
        entity_label: detector,
        cta_href: "/dashboard/immune-system",
      })
      .select("id")
      .single();
    if (nbaError || !nba) continue;

    const ids = group.map((g) => g!.id as string);
    await admin.from("business_immune_signals").update({ flywheel_promoted_at: new Date().toISOString() }).in("id", ids);
    const { error: promoError } = await admin.from("flywheel_promotions").insert({
      user_id: userId,
      source_type: "business_immune_detector",
      source_key: detector,
      next_best_action_id: nba.id,
      detail: `${group.length} confirmed true-positive occurrences`,
    });
    if (!promoError) created++;
  }
  return { created };
}

// ---------------------------------------------------------------
// MEASURE — deterministic weekly-comparable snapshot
// ---------------------------------------------------------------
async function writeSnapshot(admin: SupabaseClient, userId: string, promotionsCreatedToday: number): Promise<void> {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ count: actionsLogged }, { data: activeLessons }, { count: promotionsActedOn }, { data: prevSnapshot }] = await Promise.all([
    admin.from("business_activity_events").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("occurred_at", since7d),
    admin.from("org_memory_entries").select("confidence_score").eq("user_id", userId).eq("status", "active"),
    admin
      .from("flywheel_promotions")
      .select("next_best_action_id, next_best_actions!inner(status)", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("next_best_actions.status", "done"),
    admin.from("flywheel_snapshots").select("*").eq("user_id", userId).order("snapshot_date", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const totalLessons = activeLessons?.length ?? 0;
  const avgConfidence = totalLessons > 0 ? activeLessons!.reduce((s, e) => s + (e.confidence_score as number), 0) / totalLessons : 0;

  const prevAvg = prevSnapshot ? Number(prevSnapshot.avg_lesson_confidence) : avgConfidence;
  const confidenceDelta = avgConfidence - prevAvg;
  const score = Math.max(0, Math.min(100, Math.round(50 + confidenceDelta * 2 + (promotionsActedOn ?? 0) * 5 + promotionsCreatedToday * 2)));

  await admin.from("flywheel_snapshots").upsert(
    {
      user_id: userId,
      snapshot_date: new Date().toISOString().slice(0, 10),
      total_actions_logged: actionsLogged ?? 0,
      total_active_lessons: totalLessons,
      avg_lesson_confidence: Number(avgConfidence.toFixed(1)),
      promotions_created: promotionsCreatedToday,
      promotions_acted_on: promotionsActedOn ?? 0,
      compounding_score: score,
    },
    { onConflict: "user_id,snapshot_date" },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    let singleUserId: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        singleUserId = body?.single_user_id ?? null;
      } catch {
        // no body / not JSON — full sweep
      }
    }

    const { data: profiles } = singleUserId
      ? { data: [{ id: singleUserId }] }
      : await admin.from("profiles").select("id");

    let accountsProcessed = 0;
    let totalPromotions = 0;

    for (const p of profiles ?? []) {
      const userId = p.id as string;
      accountsProcessed++;

      const [memoryResult, threatResult] = await Promise.all([
        promoteMemoryEntries(admin, userId),
        promoteConfirmedThreats(admin, userId),
      ]);
      const promotionsToday = memoryResult.created + threatResult.created;
      totalPromotions += promotionsToday;

      await writeSnapshot(admin, userId, promotionsToday);
    }

    return new Response(JSON.stringify({ accountsProcessed, totalPromotions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
