// supabase/functions/job-feeds/index.ts
//
// Public XML job feeds for Indeed, ZipRecruiter and LinkedIn, built from OPEN careers postings.
// Reached through vercel.json rewrites:  /feeds/indeed.xml  ->  /functions/v1/job-feeds?board=indeed
// A feed answers 404 until staff switch that board on in Dashboard -> Hiring.
//
// Deploy (public endpoint, no JWT; also add [functions.job-feeds] verify_jwt = false to supabase/config.toml):
//   supabase functions deploy job-feeds --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildFeed, isFeedBoard, type FeedPosting } from "../_shared/job-feeds/engine.ts";

const SITE = "https://vireek.com";
const COMPANY = "Vireek";
const COLUMNS =
  "id, slug, title, department, location, location_type, employment_type, summary, description, responsibilities, requirements, salary_min, salary_max, salary_currency, salary_period, status, published_at, created_at, updated_at, city, region, country, postal_code";

const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed", 405, { Allow: "GET, HEAD" });

  const url = new URL(req.url);
  const raw = (url.searchParams.get("board") ?? url.pathname.split("/").pop() ?? "").replace(/\.xml$/i, "").toLowerCase();
  if (!isFeedBoard(raw)) return text("Unknown feed", 404);
  const board = raw;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !service) return text("Feed not configured", 503, { "Retry-After": "300" });
  const admin = createClient(supabaseUrl, service, { auth: { persistSession: false } });

  const { data: cfg, error: cfgErr } = await admin
    .from("job_board_feeds")
    .select("enabled, linkedin_company_id, poster_email")
    .eq("board", board)
    .maybeSingle();
  if (cfgErr) return text("Feed temporarily unavailable", 503, { "Retry-After": "300" });
  if (!cfg || !cfg.enabled) return text("This feed is not enabled", 404);

  const { data, error } = await admin
    .from("job_postings")
    .select(COLUMNS)
    .eq("status", "open")
    .order("published_at", { ascending: false })
    .limit(1000);
  if (error) return text("Feed temporarily unavailable", 503, { "Retry-After": "300" });

  const rows = (data ?? []) as unknown as FeedPosting[];
  const latest = rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), "");
  const built = buildFeed(board, rows, {
    companyName: COMPANY,
    siteUrl: SITE,
    linkedinCompanyId: cfg.linkedin_company_id,
    posterEmail: cfg.poster_email,
    buildDate: latest ? new Date(latest) : new Date(0),
  });

  // Crawl bookkeeping must never break the feed.
  try {
    await admin.rpc("record_job_feed_fetch", { p_board: board, p_jobs: built.included, p_skipped: built.skipped.length });
  } catch {
    /* ignore */
  }

  const etag = `"${(await sha256Hex(built.xml)).slice(0, 32)}"`;
  const headers = {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=900",
    ETag: etag,
  };
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : built.xml, { headers });
});
