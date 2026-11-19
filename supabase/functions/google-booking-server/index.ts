// google-booking-server — Google Actions Center Booking Server (REST v3). verify_jwt = false (Google authenticates with
// HTTP Basic). Routes:  /functions/v1/google-booking-server/{sandbox|production}/v3/{HealthCheck|BatchAvailabilityLookup|CreateBooking|UpdateBooking}
// Secrets (set per environment; rotate every 6 months — Google requirement):
//   GOOGLE_BOOKING_SANDBOX_USER / GOOGLE_BOOKING_SANDBOX_PASSWORD
//   GOOGLE_BOOKING_PRODUCTION_USER / GOOGLE_BOOKING_PRODUCTION_PASSWORD
//   SERVICETITAN_ENV=integration (optional, to read ServiceTitan's sandbox)
// Deploy: supabase functions deploy google-booking-server --no-verify-jwt
// Off by default: serves nothing until the owner enables the feed AND partner_status is 'sandbox' / 'approved'.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleBookingServer, type BookingServerDeps, type Merchant } from "../_shared/google-booking/bookingServer.ts";
import { sha256Hex, type FeedSnapshot } from "../_shared/google-booking/availability.ts";
import { dbRateLimiter } from "../_shared/http/rateLimit.ts";
import { resolveFsmGate } from "../_shared/fsm-availability/gate.ts";
import { supabaseGateDeps } from "../_shared/fsm-availability/gateDeps.ts";
import { syncJobToExternalProviders } from "../_shared/dispatch/externalJobSync.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false },
});
const limiter = dbRateLimiter(admin);
const gateDeps = supabaseGateDeps(admin);
const PER_MINUTE = 600;

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}_failed`);
  return data as T;
};

const deps: BookingServerDeps = {
  now: () => Date.now(),
  credentials(mode) {
    const p = mode === "sandbox" ? "GOOGLE_BOOKING_SANDBOX" : "GOOGLE_BOOKING_PRODUCTION";
    const user = Deno.env.get(`${p}_USER`);
    const password = Deno.env.get(`${p}_PASSWORD`);
    return user && password && password.length >= 24 ? { user, password } : null;
  },
  async allowRequest(bucket) {
    return (await limiter.hit(bucket, PER_MINUTE, 60)).allowed;
  },
  async ping() {
    const { error } = await admin.from("google_booking_settings").select("user_id", { head: true, count: "exact" }).limit(1);
    return !error;
  },
  async resolveMerchant(slug): Promise<Merchant | null> {
    const { data: bp, error } = await admin.from("business_profile").select("user_id").eq("booking_slug", slug).maybeSingle();
    if (error) throw new Error("merchant_lookup_failed");
    if (!bp?.user_id) return null;
    const snap = await rpc<FeedSnapshot | null>("get_google_feed_snapshot", { p_slug: slug });
    return snap ? { userId: bp.user_id as string, snapshot: snap } : null;
  },
  fsmGate: (userId, range) => resolveFsmGate({ ...gateDeps, capacity: { ...gateDeps.capacity, timeoutMs: 1200 } }, userId, range),
  async claim(a) {
    return await rpc("claim_google_booking_request", {
      p_user: a.userId, p_token: a.token, p_start_sec: a.startSec, p_service_id: a.serviceId, p_contact_hash: a.contactHash, p_sandbox: a.sandbox,
    });
  },
  async book(a) {
    const { data, error } = await admin.rpc("create_public_booking_with_settings", {
      p_slug: a.slug, p_customer_name: a.name, p_customer_phone: a.phone, p_customer_email: a.email,
      p_service_type: a.serviceName, p_scheduled_datetime: a.startIso, p_notes: "Booked via Google", p_channel: "google",
      p_ref_code: null, p_intake_answers: {},
    });
    if (!error && typeof (data as { job_id?: string })?.job_id === "string") return { ok: true, jobId: (data as { job_id: string }).job_id };
    const msg = error?.message ?? "";
    if (msg.includes("slot_taken")) return { ok: false, reason: "slot_taken" };
    if (/too_soon|booking_not_available|service_unavailable|intake_/.test(msg)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "error" };
  },
  async complete(a) {
    return await rpc<boolean>("complete_google_booking_request", { p_id: a.id, p_job_id: a.jobId, p_sandbox: a.sandbox });
  },
  async fail(id, cause) {
    await rpc("fail_google_booking_request", { p_id: id, p_cause: cause }).catch(() => undefined);
  },
  async cancel(a) {
    return await rpc("cancel_google_booking", { p_booking_id: a.bookingId, p_sandbox: a.sandbox });
  },
  afterBooking(a) {
    // FSM write-back (never throws). Must not delay Google's response (CreateBooking latency budget).
    const task = syncJobToExternalProviders(admin, a.userId, {
      id: a.jobId, customerName: a.name, customerPhone: a.phone, serviceType: a.serviceName, address: null, scheduledDatetime: a.startIso,
    }).catch(() => undefined);
    (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(task);
  },
  sha256Hex,
  log: (event, detail) => console.log(JSON.stringify({ event: `google_booking_server_${event}`, ...detail })),
};

Deno.serve((req) => handleBookingServer(req, deps));
