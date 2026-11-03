// supabase/functions/_shared/consumer-agent/sandbox.ts
//
// Stateless sandbox business for agent developers: slug "vireek-sandbox". It exercises the real protocol path
// (validation, rate limits, proof-of-work, slot verification, idempotency hashing, status tokens) but its data are
// fixtures and request_booking NEVER writes a request, a lead, a job or a notification.
//
// Deterministic outcomes for testing the status flow (put the word in the idempotency_key):
//   "...accept..." -> the request later reads as accepted;   "...decline..." -> declined;   otherwise pending.

import type { FeedSnapshot } from "../google-booking/availability.ts";
import type { CreateInput, CreateResult, PublicStore } from "./handlers.ts";
import { sha256Hex } from "./security.ts";
import { SANDBOX_SLUG } from "./spec.ts";

const SANDBOX_ZIPS = ["60601", "60602", "60603"];
const SANDBOX_SERVICES = ["Drain Cleaning", "Water Heater Repair", "Leak Detection"];

export const sandboxProfile = (): Record<string, unknown> => ({
  schema: "vireek.consumer-agent.profile.v1",
  slug: SANDBOX_SLUG,
  name: "Vireek Sandbox Plumbing (not a real business)",
  timezone: "America/Chicago",
  booking_enabled: true,
  request_mode: "pending",
  published: ["services", "service_area", "hours", "prices", "reviews", "policies", "contact"],
  services: SANDBOX_SERVICES,
  service_area: { names: ["Sandbox Loop"], postal_codes: SANDBOX_ZIPS, postal_codes_truncated: false },
  hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { open: "08:00", close: "17:00" }])),
  prices: [
    { service: "Drain Cleaning", model: "range", min_cents: 15000, max_cents: 30000, unit: null, currency: "USD", description: "Kitchen or bathroom drain" },
    { service: "Water Heater Repair", model: "starting_at", min_cents: 18000, max_cents: null, unit: null, currency: "USD", description: null },
    { service: "Leak Detection", model: "hourly", min_cents: 12000, max_cents: null, unit: null, currency: "USD", description: null },
  ],
  reviews: { count: 42, average: 4.7, distribution: { "1": 1, "2": 1, "3": 2, "4": 8, "5": 30 }, last_12_months: 18, platforms: ["google"], as_of: "2026-01-01T00:00:00.000Z" },
  policies: {
    text: "Sandbox data only. Nothing you send here reaches a real business.", request_mode: "pending", hold_minutes: null, response_sla_minutes: 120,
    payment: "never_collected_through_agents", confirmation: "requests_are_not_appointments_until_the_business_confirms",
  },
  contact: { phone: null, email: null, website: null },
});

export const sandboxSnapshot = (now: Date): FeedSnapshot => ({
  generated_at: now.toISOString(),
  slug: SANDBOX_SLUG,
  business: { name: "Vireek Sandbox Plumbing", timezone: "America/Chicago", timezone_set: true, services: SANDBOX_SERVICES },
  settings: {
    enabled: true,
    hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { open: "08:00", close: "17:00" }])),
    holidays: [], duration_minutes: 60, lead_time_hours: 2, window_days: 14, buffer_before: 0, buffer_after: 0,
  },
  capacity: { technician_capacity: 0, emergency_reserve: 1, full_threshold_pct: 90 },
  google: { feed_enabled: false, structured_data_enabled: false, partner_status: "not_applied", horizon_days: 14 },
  busy: [], load_by_day: {},
});

async function sandboxRequestId(key: string): Promise<string> {
  const h = await sha256Hex(`sandbox|${key}`);
  const outcome = /accept/i.test(key) ? "a" : /decline/i.test(key) ? "d" : "0";
  // outcome nibble first; version 4 and variant 8 forced so it is a well-formed UUID.
  return `${outcome}${h.slice(1, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Wraps the real store for limits / blocking / logging, and replaces every business-data method with fixtures. */
export function sandboxStore(base: PublicStore, now: () => Date = () => new Date()): PublicStore {
  return {
    ...base,
    profile: async () => sandboxProfile(),
    snapshot: async () => sandboxSnapshot(now()),
    blockedStarts: async () => [],
    areaCheck: async (_slug, postal) => (SANDBOX_ZIPS.includes(postal.trim()) ? "inside" : "outside"),
    createRequest: async (i: CreateInput): Promise<CreateResult> => {
      if (!SANDBOX_SERVICES.some((s) => s.toLowerCase() === i.service_type.toLowerCase())) return { ok: false, error: "unknown_service" };
      if (!SANDBOX_ZIPS.includes(i.postal_code)) return { ok: false, error: "outside_service_area" };
      const t = now().getTime();
      return {
        ok: true, replayed: false, request_id: await sandboxRequestId(i.idempotency_key), status: "pending",
        sla_due_at: new Date(t + 2 * 3600_000).toISOString(), hold_expires_at: null, expires_at: new Date(t + 48 * 3600_000).toISOString(),
      };
    },
    requestStatus: async (id: string) => {
      const status = id.startsWith("a") ? "accepted" : id.startsWith("d") ? "declined" : "pending";
      return { request_id: id, status, sla_due_at: null, hold_expires_at: null, decided_at: status === "pending" ? null : now().toISOString(), decline_reason: status === "declined" ? "unavailable" : null, updated_at: now().toISOString(), sandbox: true };
    },
  };
}
