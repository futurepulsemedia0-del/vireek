// supabase/functions/state-of-calls-build/index.ts
//
// Staff-only pipeline for the "State of Home Service Calls" report. NOT callable by customers.
//   POST { action: "build",    period_key: "2026" | "2026-Q3", slug?, title? }  -> draft edition (replaces an unpublished draft)
//   POST { action: "preview",  edition_id }
//   POST { action: "review",   edition_id, legal_reviewer, fact_checker, legal_review_complete: true, fact_check_complete: true }
//   POST { action: "publish",  edition_id }   re-derives the numbers; refuses if they changed since review
//   POST { action: "withdraw", edition_id, reason }
// Auth: header X-Report-Admin-Secret must equal env REPORT_ADMIN_SECRET (min 32 chars). Deploy with --no-verify-jwt.
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REPORT_ADMIN_SECRET.

import { adminClient, json, corsHeaders, type Admin } from "../_shared/data-platform/http.ts";
import { safeEqual } from "../_shared/data-platform/secrets.ts";
import { DisclosureError, applyDisclosureControl, assertPublishable, cellsHash } from "../_shared/state-of-calls/disclosure.ts";
import { buildEditionDocument, type EditionDocument } from "../_shared/state-of-calls/edition.ts";
import { K_MIN_PUBLIC, type PublishedCell } from "../_shared/state-of-calls/schema.ts";
import { verifyNarrative } from "../_shared/state-of-calls/narrative.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^(\d{4})(?:-Q([1-4]))?$/;
const MAX_BODY = 8 * 1024;
const ACTOR = "staff";

function periodBounds(key: string): { kind: "annual" | "quarterly"; start: Date; end: Date } | null {
  const m = PERIOD_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 2024 || y > 2100) return null;
  if (!m[2]) return { kind: "annual", start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  const q = Number(m[2]);
  return { kind: "quarterly", start: new Date(Date.UTC(y, (q - 1) * 3, 1)), end: new Date(Date.UTC(y, q * 3, 1)) };
}
const day = (d: Date) => d.toISOString().slice(0, 10);

async function derive(admin: Admin, periodKey: string, start: Date, end: Date) {
  const { data, error } = await admin.rpc("report_build_raw_cells", {
    p_period_key: periodKey, p_start: start.toISOString(), p_end: end.toISOString(), p_k_min: K_MIN_PUBLIC,
  });
  if (error) throw new Error(`aggregation failed: ${error.message}`);
  return applyDisclosureControl((data ?? []) as unknown[]);
}

async function audit(admin: Admin, row: Record<string, unknown>) {
  const { error } = await admin.from("report_export_audit").insert({ actor: ACTOR, ...row });
  if (error) throw new Error(`audit write failed: ${error.message}`); // no audit => no action
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
  const id = typeof b.edition_id === "string" && UUID_RE.test(b.edition_id) ? b.edition_id : null;

  try {
    if (b.action === "build") {
      const periodKey = String(b.period_key ?? "");
      const bounds = periodBounds(periodKey);
      if (!bounds) return json({ error: "period_key must look like 2026 or 2026-Q3." }, 400);
      if (bounds.end.getTime() > Date.now()) return json({ error: "The period has not finished; partial periods are never published." }, 400);
      const slug = typeof b.slug === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug) && b.slug.length <= 60 ? b.slug : `state-of-home-service-calls-${periodKey.toLowerCase()}`;
      const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 160) : `State of Home Service Calls ${periodKey.replace("-", " ")}`;

      const { data: existing } = await admin.from("report_editions").select("id,status").eq("slug", slug).maybeSingle();
      if (existing && existing.status !== "draft") return json({ error: `Edition ${slug} is ${existing.status}; choose another slug.` }, 409);

      const { cells, report } = await derive(admin, periodKey, bounds.start, bounds.end);
      const asOf = new Date().toISOString();
      const doc = await buildEditionDocument({
        slug, title, kind: bounds.kind, period_key: periodKey, period_start: day(bounds.start),
        period_end: day(new Date(bounds.end.getTime() - 86_400_000)), as_of: asOf, synthetic: false,
      }, cells, report);

      if (existing) await admin.from("report_cells").delete().eq("edition_id", existing.id);
      const row = {
        slug, title, kind: bounds.kind, period_key: periodKey, period_start: doc.period_start, period_end: doc.period_end, as_of: asOf,
        status: "draft", method_version: doc.method_version, cells_hash: doc.cells_hash, thresholds: doc.thresholds,
        disclosure_report: report, document: doc, review: {}, built_at: asOf,
      };
      const { data: ed, error } = existing
        ? await admin.from("report_editions").update(row).eq("id", existing.id).select("id").single()
        : await admin.from("report_editions").insert(row).select("id").single();
      if (error || !ed) throw new Error(`could not store edition: ${error?.message}`);
      const { error: cErr } = await admin.from("report_cells").insert(cells.map((c) => ({ ...c, edition_id: ed.id })));
      if (cErr) throw new Error(`cells rejected by database constraints: ${cErr.message}`);
      await audit(admin, { action: "build", edition_id: ed.id, edition_slug: slug, cell_count: cells.length, published_cell_count: report.published, cells_hash: doc.cells_hash });
      return json({ edition_id: ed.id, slug, mode: doc.mode, preview_reasons: doc.preview_reasons, cells_hash: doc.cells_hash, disclosure_report: report }, 201);
    }

    if (!id) return json({ error: "edition_id is required." }, 400);
    const { data: ed } = await admin.from("report_editions").select("*").eq("id", id).maybeSingle();
    if (!ed) return json({ error: "Edition not found." }, 404);

    if (b.action === "preview") {
      await audit(admin, { action: "preview", edition_id: id, edition_slug: ed.slug, cells_hash: ed.cells_hash });
      return json({ document: ed.document, status: ed.status, review: ed.review });
    }

    if (b.action === "review") {
      if (ed.status !== "draft") return json({ error: "Only drafts can be reviewed." }, 409);
      const legal = typeof b.legal_reviewer === "string" ? b.legal_reviewer.trim().slice(0, 120) : "";
      const fact = typeof b.fact_checker === "string" ? b.fact_checker.trim().slice(0, 120) : "";
      if (!legal || !fact || b.legal_review_complete !== true || b.fact_check_complete !== true) {
        return json({ error: "Reviewer names and both completion confirmations are required." }, 400);
      }
      const now = new Date().toISOString();
      const review = { legal_reviewer: legal, legal_review_at: now, fact_checker: fact, fact_check_at: now, reviewed_cells_hash: ed.cells_hash };
      await admin.from("report_editions").update({ review }).eq("id", id);
      await audit(admin, { action: "review_signoff", edition_id: id, edition_slug: ed.slug, cells_hash: ed.cells_hash });
      return json({ ok: true, review });
    }

    if (b.action === "publish") {
      if (ed.status === "published") return json({ ok: true, already: true });
      if (ed.status !== "draft") return json({ error: `Edition is ${ed.status}.` }, 409);
      if (ed.review?.reviewed_cells_hash !== ed.cells_hash) return json({ error: "The reviewed numbers differ from the draft; review again." }, 409);

      // 1) stored cells still satisfy every invariant and hash to what was reviewed
      const { data: stored, error: sErr } = await admin.from("report_cells").select("*").eq("edition_id", id);
      if (sErr) throw new Error(sErr.message);
      const cells: PublishedCell[] = (stored ?? []).map((r: Record<string, unknown>) => ({
        metric_key: r.metric_key, dim: r.dim, dim_value: r.dim_value, period_key: r.period_key, unit: r.unit, suppressed: r.suppressed,
        suppression_reason: r.suppression_reason, n_orgs: r.n_orgs, n_events: r.n_events,
        value: r.value === null ? null : Number(r.value), p25: r.p25 === null ? null : Number(r.p25),
        p50: r.p50 === null ? null : Number(r.p50), p75: r.p75 === null ? null : Number(r.p75),
      })) as PublishedCell[];
      cells.sort((a, b2) => `${a.metric_key}|${a.dim}|${a.dim_value}|${a.period_key}`.localeCompare(`${b2.metric_key}|${b2.dim}|${b2.dim_value}|${b2.period_key}`));
      assertPublishable(cells);
      if ((await cellsHash(cells)) !== ed.cells_hash) return json({ error: "Stored cells do not match the reviewed hash." }, 409);
      const doc = ed.document as EditionDocument;
      if (doc.cells_hash !== ed.cells_hash || !verifyNarrative(doc.narrative, cells).ok) return json({ error: "Narrative does not match the cells." }, 409);

      // 2) re-derive from live data: a consent withdrawal, deletion or late data since the build changes the hash => refuse
      const { cells: fresh } = await derive(admin, ed.period_key, new Date(`${ed.period_start}T00:00:00Z`), new Date(Date.parse(`${ed.period_end}T00:00:00Z`) + 86_400_000));
      if ((await cellsHash(fresh)) !== ed.cells_hash) {
        return json({ error: "Underlying data or consent changed since the build. Rebuild the edition and review it again." }, 409);
      }
      const { error: pErr } = await admin.rpc("report_publish_edition", { p_edition: id, p_expected_hash: ed.cells_hash, p_actor: ACTOR });
      if (pErr) return json({ error: `Publish refused: ${pErr.message}` }, 409);
      return json({ ok: true, slug: ed.slug });
    }

    if (b.action === "withdraw") {
      const reason = typeof b.reason === "string" ? b.reason.trim() : "";
      if (!reason) return json({ error: "A reason is required." }, 400);
      const { error: wErr } = await admin.rpc("report_withdraw_edition", { p_edition: id, p_reason: reason, p_actor: ACTOR });
      if (wErr) return json({ error: wErr.message }, 409);
      return json({ ok: true });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    if (err instanceof DisclosureError) return json({ error: `Disclosure control rejected the data: ${err.message}` }, 422);
    console.error("[state-of-calls-build]", err instanceof Error ? err.message : err);
    return json({ error: "Build failed. See function logs." }, 500);
  }
});
