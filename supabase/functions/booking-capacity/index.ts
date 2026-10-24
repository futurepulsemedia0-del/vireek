// supabase/functions/booking-capacity/index.ts
//
// Capacity-based smart booking endpoint.
//   POST { action: "slots",   slug, service_type?, address?, lat?, lon? }       public (slug-scoped)
//   POST { action: "book",    slug, slot_start, customer_name, ... }            public (slug-scoped)
//   POST { action: "preview", service_type?, address?, lat?, lon?, days? }      authenticated owner/team
//
// Public responses never contain technician names, loads or internal reasons — only bookable
// start/end times. "preview" returns the full why-offered / why-hidden explanation for the dashboard.
// When capacity booking is switched off the public actions answer { capacity: false } / { mode: "legacy" }
// so the booking page transparently keeps using the original flow.
//
// Deploy with verify_jwt = false (public booking page); "preview" verifies the JWT itself.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { commitCapacityBooking, getAvailability, validateIntake } from "../_shared/booking/capacityBooking.ts";
import { toPublicSlots } from "../_shared/booking/capacityEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Best-effort per-isolate rate limit for the public actions (the DB constraints are the real protection).
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string, max = 40): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n += 1;
  return h.n > max;
}

const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const action = body.action;
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    // ---------------------------------------------------------------- authenticated preview
    if (action === "preview") {
      const authHeader = req.headers.get("Authorization") ?? "";
      const authClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        auth: { persistSession: false }, global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await authClient.auth.getUser();
      if (!user) return json({ error: "Not authenticated." }, 401);
      const { data: ownerId } = await authClient.rpc("get_account_owner_id");
      if (!ownerId) return json({ error: "No account." }, 403);

      const out = await getAvailability(admin, ownerId as string, {
        serviceType: str(body.service_type, 120), address: str(body.address, 300), lat: num(body.lat, -90, 90), lon: num(body.lon, -180, 180),
        isEmergency: body.emergency === true,
      }, { includeHidden: true, maxOffered: 200, force: true });
      if (!out.enabled) return json({ error: "Unavailable" }, 500);
      const days = Math.min(7, Math.max(1, Number(body.days) || 3));
      const keep = new Set(out.result.days.slice(0, days).map((d) => d.date));
      const tz = out.loaded.ctx.timezone;
      const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
      return json({
        timezone: tz,
        duration_minutes: out.result.duration_minutes,
        overbooking_allowance_per_tech: out.result.overbooking_allowance_per_tech,
        cancel_rate: out.loaded.ctx.cancelRate,
        days: out.result.days.slice(0, days),
        slots: out.result.slots.filter((s) => keep.has(dayOf(s.start))),
      });
    }

    // ---------------------------------------------------------------- public actions
    if (action !== "slots" && action !== "book") return json({ error: "Unknown action" }, 400);
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    if (limited(ip, action === "book" ? 10 : 40)) return json({ error: "Too many requests" }, 429);

    const slug = typeof body.slug === "string" && SLUG_RE.test(body.slug) ? body.slug : null;
    if (!slug) return json({ error: "Invalid slug" }, 400);
    const { data: bp } = await admin.from("business_profile").select("user_id, booking_enabled").eq("booking_slug", slug).maybeSingle();
    if (!bp || !bp.booking_enabled) return json({ capacity: false });
    const ownerId = bp.user_id as string;

    const common = {
      serviceType: str(body.service_type, 120), address: str(body.address, 300), lat: num(body.lat, -90, 90), lon: num(body.lon, -180, 180),
    };

    if (action === "slots") {
      const out = await getAvailability(admin, ownerId, common);
      if (!out.enabled) return json({ capacity: false });
      return json({ capacity: true, timezone: out.loaded.ctx.timezone, duration_minutes: out.result.duration_minutes, slots: toPublicSlots(out.result) });
    }

    // action === "book"
    const slotMs = typeof body.slot_start === "string" ? Date.parse(body.slot_start) : NaN;
    const name = str(body.customer_name, 120);
    if (!Number.isFinite(slotMs) || !name) return json({ ok: false, reason: "invalid_request" }, 400);

    const out = await getAvailability(admin, ownerId, common, { maxOffered: 1 });
    if (!out.enabled) return json({ mode: "legacy" });
    const loaded = out.loaded;
    if (common.serviceType && loaded.hiddenServices.includes(common.serviceType)) return json({ ok: false, reason: "service_unavailable" });
    const intake = validateIntake(loaded.intakeQuestions, body.intake_answers as Record<string, unknown> | undefined);
    if (!intake.ok) return json({ ok: false, reason: intake.reason });

    const result = await commitCapacityBooking(admin, ownerId, {
      ...common, startMs: slotMs, customerName: name,
      customerPhone: str(body.customer_phone, 40), customerEmail: str(body.customer_email, 200),
      notes: str(body.notes, 2000), channel: str(body.channel, 40) ?? "web_booking", refCode: str(body.ref_code, 60), intake: intake.intake,
    });
    if (result.status === "legacy") return json({ mode: "legacy" });
    if (result.status === "booked") return json({ mode: "capacity", ok: true, deposit_due_cents: result.depositDueCents });
    if (result.status === "unavailable") return json({ mode: "capacity", ok: false, reason: "slot_taken" });
    return json({ mode: "capacity", ok: false, reason: "unknown" });
  } catch (err) {
    console.error(JSON.stringify({ event: "booking_capacity_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Unexpected error" }, 500);
  }
});
