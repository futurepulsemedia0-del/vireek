// Public (no-auth) ICS calendar subscription endpoint:
//   GET /functions/v1/calendar-feed/<64-hex-token>.ics
// Calendar apps (Google, Apple, Outlook) cannot send a JWT, so access is by the
// unguessable per-feed token alone (256-bit random, generated in Postgres, see
// 20271020000000_calendar_ics_feeds.sql). The token is rotated from the dashboard
// ("Regenerate link"), which instantly invalidates every existing subscription.
//
// Deploy: supabase functions deploy calendar-feed --no-verify-jwt
//
// Security notes
//  - Unknown, malformed, paused and rotated tokens ALL return the same 404, so the
//    endpoint never reveals whether a token ever existed.
//  - Every query is scoped to feed.user_id (account owner); technician feeds are
//    additionally scoped to the one assigned technician. The service role is used
//    only after the token has been resolved to a feed row.
//  - Tokens are never logged. Responses are `private`, `noindex`, `no-referrer`.
//  - "busy" detail level strips customer name, phone, address and notes.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  EXCLUDED_STATUSES,
  FEED_MAX_EVENTS,
  buildCalendar,
  calendarEtag,
  etagMatches,
  feedCalendarName,
  feedFileName,
  feedWindow,
  parseFeedPath,
  shouldRecordAccess,
  type DetailLevel,
  type FeedJob,
  type FeedScope,
} from "../_shared/calendar-feed/engine.ts";

const SECURITY_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function plain(status: number, body: string, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra },
  });
}

const notFound = () => plain(404, "Not found");

interface FeedRow {
  id: string;
  user_id: string;
  scope: FeedScope;
  team_member_id: string | null;
  enabled: boolean;
  detail_level: DetailLevel;
  last_accessed_at: string | null;
  access_count: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS", ...SECURITY_HEADERS } });
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed", { Allow: "GET, HEAD, OPTIONS" });

  const token = parseFeedPath(new URL(req.url).pathname);
  if (!token) return notFound();

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const { data: feed, error: feedError } = await admin
      .from("calendar_feeds")
      .select("id, user_id, scope, team_member_id, enabled, detail_level, last_accessed_at, access_count")
      .eq("token", token)
      .maybeSingle<FeedRow>();
    if (feedError) throw feedError;
    if (!feed || !feed.enabled) return notFound();

    const now = new Date();
    const { from, to } = feedWindow(now);

    let jobsQuery = admin
      .from("jobs")
      .select("id, customer_name, customer_phone, service_type, address, scheduled_datetime, duration_minutes, assigned_technician_id, job_status, notes")
      .eq("user_id", feed.user_id)
      .gte("scheduled_datetime", from.toISOString())
      .lte("scheduled_datetime", to.toISOString())
      .not("job_status", "in", `(${EXCLUDED_STATUSES.join(",")})`)
      .order("scheduled_datetime", { ascending: true })
      .limit(FEED_MAX_EVENTS);
    if (feed.scope === "technician") {
      if (!feed.team_member_id) return notFound();
      jobsQuery = jobsQuery.eq("assigned_technician_id", feed.team_member_id);
    }

    const [jobsRes, profileRes, membersRes] = await Promise.all([
      jobsQuery,
      admin.from("profiles").select("company_name").eq("id", feed.user_id).maybeSingle(),
      admin.from("team_members").select("id, member_name, member_email").eq("account_owner_id", feed.user_id),
    ]);
    if (jobsRes.error) throw jobsRes.error;

    const names = new Map<string, string>();
    for (const m of membersRes.data ?? []) names.set(m.id, (m.member_name ?? m.member_email ?? "").trim());
    const company = (profileRes.data?.company_name as string | null) ?? null;
    const calendarName = feedCalendarName(
      feed.scope,
      company,
      feed.team_member_id ? names.get(feed.team_member_id) ?? null : null,
    );

    const body = buildCalendar({
      name: calendarName,
      jobs: (jobsRes.data ?? []) as FeedJob[],
      event: {
        detail: feed.detail_level,
        scope: feed.scope,
        appOrigin: (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, ""),
        stamp: now,
      },
      technicianNames: feed.scope === "business" && feed.detail_level === "full" ? names : undefined,
    });

    // Best-effort, throttled usage tracking (powers "last synced" in the dashboard).
    if (shouldRecordAccess(feed.last_accessed_at, now)) {
      await admin
        .from("calendar_feeds")
        .update({ last_accessed_at: now.toISOString(), access_count: (feed.access_count ?? 0) + 1 })
        .eq("id", feed.id)
        .then(() => undefined, () => undefined);
    }

    const etag = await calendarEtag(body);
    const headers: Record<string, string> = {
      ETag: etag,
      "Cache-Control": "private, max-age=300, must-revalidate",
      ...SECURITY_HEADERS,
    };
    if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

    return new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="${feedFileName(calendarName)}"`,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "calendar_feed_failed", error: error instanceof Error ? error.message : String(error) }));
    return plain(500, "Calendar feed unavailable", { "Retry-After": "300" });
  }
});
