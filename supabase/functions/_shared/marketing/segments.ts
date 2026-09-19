// supabase/functions/_shared/marketing/segments.ts
//
// Turns a marketing_segments.filter jsonb blob into the matching rows from
// `customers` or `leads`. Kept deliberately simple (a handful of supported
// keys) rather than a generic query builder — add keys here as you need them.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface SegmentFilter {
  entity?: "customer" | "lead";
  lifecycle_stage?: string[]; // customers only
  stage?: string[]; // leads only
  tags?: string[]; // customers only
  source?: string[];
  min_score?: number;
  max_score?: number;
  inactive_days?: number; // customers: last_contacted_at older than N days
}

export interface SegmentMember {
  customer_id?: string;
  lead_id?: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

export async function resolveSegmentMembers(
  admin: SupabaseClient,
  userId: string,
  filter: SegmentFilter,
): Promise<SegmentMember[]> {
  const entity = filter.entity ?? "customer";

  if (entity === "lead") {
    let q = admin.from("leads").select("id, name, email, phone, stage").eq("user_id", userId);
    if (filter.stage?.length) q = q.in("stage", filter.stage);
    const { data, error } = await q;
    if (error) throw error;
    let rows = (data ?? []) as { id: string; name: string; email: string | null; phone: string | null }[];

    if (filter.min_score !== undefined || filter.max_score !== undefined) {
      rows = await filterByScore(admin, userId, rows, "lead_id", filter.min_score, filter.max_score);
    }

    return rows.map((r) => ({ lead_id: r.id, email: r.email, phone: r.phone, name: r.name }));
  }

  let q = admin
    .from("customers")
    .select("id, name, email, phone, lifecycle_stage, tags, source, last_contacted_at")
    .eq("user_id", userId);
  if (filter.lifecycle_stage?.length) q = q.in("lifecycle_stage", filter.lifecycle_stage);
  if (filter.source?.length) q = q.in("source", filter.source);
  if (filter.tags?.length) q = q.overlaps("tags", filter.tags);
  if (filter.inactive_days !== undefined) {
    const cutoff = new Date(Date.now() - filter.inactive_days * 86_400_000).toISOString();
    q = q.or(`last_contacted_at.lt.${cutoff},last_contacted_at.is.null`);
  }
  const { data, error } = await q;
  if (error) throw error;
  let rows = (data ?? []) as { id: string; name: string; email: string | null; phone: string | null }[];

  if (filter.min_score !== undefined || filter.max_score !== undefined) {
    rows = await filterByScore(admin, userId, rows, "customer_id", filter.min_score, filter.max_score);
  }

  return rows.map((r) => ({ customer_id: r.id, email: r.email, phone: r.phone, name: r.name }));
}

async function filterByScore<T extends { id: string }>(
  admin: SupabaseClient,
  userId: string,
  rows: T[],
  column: "customer_id" | "lead_id",
  minScore?: number,
  maxScore?: number,
): Promise<T[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return rows;
  const { data } = await admin
    .from("lead_scores")
    .select(`${column}, score`)
    .eq("user_id", userId)
    .in(column, ids);
  const scoreById = new Map((data ?? []).map((s: Record<string, unknown>) => [s[column] as string, s.score as number]));
  return rows.filter((r) => {
    const score = scoreById.get(r.id) ?? 0;
    if (minScore !== undefined && score < minScore) return false;
    if (maxScore !== undefined && score > maxScore) return false;
    return true;
  });
}
