// supabase/functions/cost-index-build/index.ts  (item 140) — staff-only release pipeline for the Vireek Cost Index.
//   POST { action: "build",    period_key: "2026" | "2026-Q3", changelog? }   -> new draft release (replaces an unpublished draft)
//   POST { action: "preview",  release_id }                                    -> re-derives and compares the hash
//   POST { action: "review",   release_id, reviewer, second_reviewer, items: { <REVIEW_ITEMS>: true } }
//   POST { action: "publish",  release_id }   re-derives from live consent data; refuses if the numbers changed since review
//   POST { action: "withdraw", release_id, reason }
// Auth: header X-Report-Admin-Secret == env REPORT_ADMIN_SECRET (>= 32 chars). Deploy with --no-verify-jwt.
import { adminClient, json, corsHeaders, type Admin } from "../_shared/data-platform/http.ts";
import { safeEqual } from "../_shared/data-platform/secrets.ts";
import { applyCostIndexDisclosure, assertCostIndexPublishable, costCellsHash, DisclosureError } from "../_shared/cost-index/disclosure.ts";
import { REVIEW_ITEMS, buildCostIndexDocument, reviewComplete, type ReviewState } from "../_shared/cost-index/release.ts";
import { K_MIN_PUBLIC, METHOD_VERSION, PARAMS, DOMINANCE_MAX_SHARE, MIN_EVENTS_PER_CELL, type PublishedCell } from "../_shared/cost-index/schema.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^(\d{4})(?:-Q([1-4]))?$/;
const MAX_BODY = 8 * 1024;
const ACTOR = "staff";

function periodBounds(key: string) {
  const m = PERIOD_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 2024 || y > 2100) return null;
  if (!m[2]) return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  const q = Number(m[2]);
  return { start: new Date(Date.UTC(y, (q - 1) * 3, 1)), end: new Date(Date.UTC(y, q * 3, 1)) };
}
const day = (d: Date) => d.toISOString().slice(0, 10);

async function derive(admin: Admin, periodKey: string, start: Date, end: Date) {
  const { data, error } = await admin.rpc("cost_index_build_raw_cells", {
    p_period_key: periodKey, p_start: start.toISOString(), p_end: end.toISOString(), p_k_min: K_MIN_PUBLIC,
    p_floor_cents: PARAMS.priceFloorCents, p_ceiling_cents: PARAMS.priceCeilingCents, p_min_jobs_per_org: PARAMS.minJobsPerOrg,
  });
  if (error) throw new Error(`aggregation failed: ${error.message}`);
  const res = applyCostIndexDisclosure((data ?? []) as unknown[]);
  return { ...res, hash: await costCellsHash(res.cells) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const secret = Deno.env.get("REPORT_ADMIN_SECRET") ?? "";
  if (secret.length < 32 || !safeEqual(req.headers.get("X-Report-Admin-Secret") ?? "", secret)) return json({ error: "Forbidden" }, 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "Body too large." }, 413);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
  const admin = adminClient();
  const id = typeof b.release_id === "string" && UUID_RE.test(b.release_id) ? b.release_id : null;

  try {
    if (b.action === "build") {
      const key = String(b.period_key ?? "");
      const pb = periodBounds(key);
      if (!pb) return json({ error: "period_key must look like 2026 or 2026-Q3." }, 400);
      if (pb.end.getTime() > Date.now()) return json({ error: "The period has not ended yet." }, 422);
      const d = await derive(admin, key, pb.start, pb.end);
      const asOf = new Date().toISOString();
      const title = `Vireek Cost Index — ${key}`;
      // Document is frozen at build with a provisional slug; the SQL function assigns the real sequence, so re-stamp it after.
      const { data: nextSeq } = await admin.from("cost_index_releases").select("release_seq").eq("period_key", key).neq("status", "draft").order("release_seq", { ascending: false }).limit(1);
      const seq = ((nextSeq?.[0]?.release_seq as number | undefined) ?? 0) + 1;
      const slug = `cost-index-${key.toLowerCase()}-r${seq}`;
      const doc = buildCostIndexDocument({ slug, title, releaseSeq: seq, periodKey: key, periodStart: day(pb.start), periodEnd: day(new Date(pb.end.getTime() - 86400000)), asOf, changelog: String(b.changelog ?? ""), cells: d.cells, report: d.report });
      const { data, error } = await admin.rpc("cost_index_create_release", {
        p_period_key: key, p_period_start: doc.period_start, p_period_end: doc.period_end, p_as_of: asOf, p_title: title, p_method_version: METHOD_VERSION,
        p_cells_hash: d.hash, p_thresholds: doc.thresholds, p_report: d.report, p_changelog: doc.changelog, p_document: doc, p_cells: d.cells, p_actor: ACTOR,
      });
      if (error) throw new Error(error.message);
      if (data?.slug !== slug) return json({ error: "Release sequence moved during build; run build again." }, 409);
      return json({ release: data, cells_hash: d.hash, report: d.report, thresholds: { K_MIN_PUBLIC, DOMINANCE_MAX_SHARE, MIN_EVENTS_PER_CELL } });
    }

    if (!id) return json({ error: "release_id is required." }, 400);
    const { data: rel, error: relErr } = await admin.from("cost_index_releases").select("id,slug,status,period_key,cells_hash,review").eq("id", id).maybeSingle();
    if (relErr) throw new Error(relErr.message);
    if (!rel) return json({ error: "Release not found." }, 404);

    if (b.action === "preview") {
      const pb = periodBounds(rel.period_key)!;
      const d = await derive(admin, rel.period_key, pb.start, pb.end);
      return json({ slug: rel.slug, status: rel.status, stored_hash: rel.cells_hash, current_hash: d.hash, unchanged: d.hash === rel.cells_hash, report: d.report, review: reviewComplete(rel.review as ReviewState) });
    }

    if (b.action === "review") {
      const items: Record<string, boolean> = {};
      for (const k of REVIEW_ITEMS) items[k] = (b.items as Record<string, unknown> | undefined)?.[k] === true;
      const review: ReviewState & { reviewed_at: string } = { items, reviewer: String(b.reviewer ?? "").slice(0, 80), second_reviewer: String(b.second_reviewer ?? "").slice(0, 80), reviewed_at: new Date().toISOString() };
      const { error } = await admin.rpc("cost_index_set_review", { p_release: id, p_review: review, p_actor: ACTOR });
      if (error) throw new Error(error.message);
      return json({ review: reviewComplete(review) });
    }

    if (b.action === "publish") {
      // Re-derive from LIVE consent data: a revocation after review changes the hash and blocks publication.
      const pb = periodBounds(rel.period_key)!;
      const d = await derive(admin, rel.period_key, pb.start, pb.end);
      if (d.hash !== rel.cells_hash) return json({ error: "The underlying data changed since this draft was built. Build a new release and review it again." }, 409);
      const { data: stored, error: cellsErr } = await admin.from("cost_index_cells").select("job_kind,trade,region,period_key,suppressed,suppression_reason,n_orgs,n_jobs,p25_cents,p50_cents,p75_cents").eq("release_id", id);
      if (cellsErr) throw new Error(cellsErr.message);
      assertCostIndexPublishable((stored ?? []) as PublishedCell[]); // gate on what is actually stored
      const { data, error } = await admin.rpc("cost_index_publish_release", { p_release: id, p_expected_hash: rel.cells_hash, p_actor: ACTOR });
      if (error) return json({ error: error.message }, 422);
      return json(data);
    }

    if (b.action === "withdraw") {
      const { data, error } = await admin.rpc("cost_index_withdraw_release", { p_release: id, p_reason: String(b.reason ?? ""), p_actor: ACTOR });
      if (error) return json({ error: error.message }, 422);
      return json(data);
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof DisclosureError) return json({ error: `Disclosure control refused the build: ${e.message}` }, 422);
    console.error("[cost-index-build]", e instanceof Error ? e.message : e);
    return json({ error: "Internal error." }, 500);
  }
});
