// google-booking-feed
//   GET  ?slug=<booking_slug>&format=bundle|availability|services   PUBLIC, no JWT (verify_jwt = false)
//   POST { preview: true }                                           owner dashboard preview (user JWT)
//
// Publishes ONLY verified availability: computed from one atomic DB snapshot by the same rules as the
// public booking engine (+ capacity caps). Anything unverifiable (feed off, booking off, no/invalid
// timezone, no hours, no services) returns 404 and publishes nothing.
// Real-time BOOKING through Google is NOT exposed here: it requires Google partner approval (see
// docs/integrations/google-agentic-booking.md). Bookings stay on /book/:slug.
//
// Secrets: SITE_URL (optional, default https://app.vireek.com). Deploy: supabase functions deploy google-booking-feed

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { computeFeedAvailability, sha256Hex, type FeedSnapshot } from "../_shared/google-booking/availability.ts";

const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const TTL_SECONDS = 120;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

const serviceId = (name: string) =>
  "svc_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  try {
    // ---------------- owner preview (shows block reasons; never public) ----------------
    if (req.method === "POST") {
      const auth = req.headers.get("Authorization") ?? "";
      if (!auth) return json({ error: "unauthorized" }, 401);
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false },
      });
      const { data, error } = await userClient.rpc("get_google_feed_snapshot_for_owner");
      if (error || !data) return json({ error: "unauthorized" }, 401);
      const snap = data as FeedSnapshot;
      const result = computeFeedAvailability(snap, new Date(), { requirePublished: false });
      return json({
        preview: true,
        blocked: result.blocked,
        timezone: result.timezone,
        capacity_mode: result.capacity_mode,
        published_slots: result.slots.length,
        next_slots: result.slots.slice(0, 12),
        days: result.days,
        services: snap.business.services,
        slug: snap.slug,
        google: snap.google,
      });
    }

    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    // ---------------- public feed ----------------
    const url = new URL(req.url);
    const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
    const format = url.searchParams.get("format") ?? "bundle";
    if (!SLUG_RE.test(slug) || !["bundle", "availability", "services"].includes(format)) {
      return json({ status: "not_published" }, 404);
    }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data, error } = await admin.rpc("get_google_feed_snapshot", { p_slug: slug });
    if (error) {
      console.error(JSON.stringify({ event: "google_feed_snapshot_failed", message: error.message }));
      return json({ status: "unavailable" }, 503);
    }
    if (!data) return json({ status: "not_published" }, 404);

    const snap = data as FeedSnapshot;
    const result = computeFeedAvailability(snap, new Date(), { requirePublished: true });
    if (result.blocked) return json({ status: "not_published" }, 404);

    const generatedAt = new Date();
    const bookingUrl = `${siteUrl}/book/${slug}`;
    const merchant = {
      merchant_id: slug,
      name: snap.business.name,
      timezone: result.timezone,
      booking_url: bookingUrl,
    };
    const duration = snap.settings.duration_minutes > 0 ? snap.settings.duration_minutes : 60;
    const services = snap.business.services.map((name) => ({
      service_id: serviceId(name),
      name,
      duration_minutes: duration,
    }));
    const availability = {
      slot_duration_minutes: duration,
      capacity_mode: result.capacity_mode,
      slots: result.slots.map((s) => ({
        merchant_id: slug,
        start: s.start,
        start_sec: s.start_sec,
        duration_sec: s.duration_sec,
        spots_open: 1,
        spots_total: 1,
        service_ids: services.map((x) => x.service_id),
      })),
    };
    const snapshotId = await sha256Hex(JSON.stringify([slug, availability.slots.map((s) => s.start_sec)]));
    const envelope = {
      schema: "vireek.google-booking-feed.v1",
      generated_at: generatedAt.toISOString(),
      valid_until: new Date(generatedAt.getTime() + TTL_SECONDS * 1000).toISOString(),
      snapshot_id: snapshotId,
    };
    const cache = "public, max-age=15, s-maxage=30";

    if (format === "services") return json({ ...envelope, merchant, services }, 200, cache);
    if (format === "availability") return json({ ...envelope, merchant_id: slug, availability }, 200, cache);

    return json(
      {
        ...envelope,
        merchant,
        services,
        availability,
        booking: {
          mode: "redirect",
          url: bookingUrl,
          real_time_booking: false,
          partner_status: snap.google.partner_status,
        },
      },
      200,
      cache,
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "google_booking_feed_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ status: "unavailable" }, 503);
  }
});
