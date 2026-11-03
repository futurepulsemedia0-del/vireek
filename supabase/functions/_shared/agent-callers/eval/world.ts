// Fixture "business" used by every synthetic scenario. All prices/fees/windows here are the ONLY numbers a correct
// agent exchange may ever contain — the harness asserts that no other dollar amount or time appears.

import type { PriceItemLite } from "../../price-book/match.ts";
import { DEFAULT_AGENT_CALLER_SETTINGS, normalizeAgentCallerSettings, type AgentCallerSettings } from "../settings.ts";
import type { World } from "./memoryPorts.ts";

const item = (o: Partial<PriceItemLite> & Pick<PriceItemLite, "service_name" | "price_cents">): PriceItemLite => ({
  category: null, pricing_model: "starting_at", price_max_cents: null, unit_label: null, keywords: [], agent_quotable: true, ...o,
});

export const FIXTURE_ITEMS: PriceItemLite[] = [
  item({ service_name: "Drain Cleaning", category: "Plumbing", price_cents: 12900, keywords: ["clogged drain", "slow drain"] }),
  item({ service_name: "Water Heater Replacement", category: "Plumbing", pricing_model: "range", price_cents: 129900, price_max_cents: 289900, keywords: ["water heater", "hot water tank"] }),
  item({ service_name: "AC Tune-Up", category: "HVAC", pricing_model: "flat", price_cents: 8900, keywords: ["ac tune up", "air conditioner maintenance"] }),
  item({ service_name: "Furnace Repair", category: "HVAC", pricing_model: "hourly", price_cents: 14500, keywords: ["furnace", "heater repair"] }),
  item({ service_name: "Panel Upgrade", category: "Electrical", pricing_model: "range", price_cents: 180000, price_max_cents: 350000, keywords: ["electrical panel", "breaker box"] }),
  item({ service_name: "Outlet Installation", category: "Electrical", pricing_model: "flat", price_cents: 15000, keywords: ["outlet", "receptacle"] }),
  item({ service_name: "Roof Leak Repair", category: "Roofing", price_cents: 35000, keywords: ["roof leak", "leaking roof"] }),
  item({ service_name: "Gutter Cleaning", category: "Roofing", pricing_model: "flat", price_cents: 17500, keywords: ["gutters"] }),
  item({ service_name: "Lock Rekey", category: "Locksmith", pricing_model: "flat", price_cents: 9500, keywords: ["rekey", "change locks"] }),
  item({ service_name: "Garage Door Spring", category: "Garage", price_cents: 24900, keywords: ["garage door", "broken spring"] }),
  item({ service_name: "Pest Inspection", category: "Pest", pricing_model: "flat", price_cents: 7500, keywords: ["termite", "pest"] }),
  item({ service_name: "Mold Remediation", category: "Restoration", price_cents: 150000, agent_quotable: false, keywords: ["mold"] }),
];

export const WINDOWS = [
  { id: "W1" as const, label: "Tuesday November 3 at 9:00 AM", startIso: "2026-11-03T15:00:00.000Z" },
  { id: "W2" as const, label: "Tuesday November 3 at 1:00 PM", startIso: "2026-11-03T19:00:00.000Z" },
  { id: "W3" as const, label: "Wednesday November 4 at 9:00 AM", startIso: "2026-11-04T15:00:00.000Z" },
];

export function makeWorld(over: Partial<World> = {}): World {
  return {
    items: FIXTURE_ITEMS,
    coverageByZip: {
      "78701": { status: "in_area", travelFeeCents: 4900 },
      "78702": { status: "in_area", travelFeeCents: 0 },
      "78704": { status: "in_area", travelFeeCents: 4900 },
      "73301": { status: "out_of_area", travelFeeCents: null },
      "78750": { status: "unknown", travelFeeCents: null },
    },
    windows: WINDOWS,
    now: new Date("2026-11-02T14:00:00.000Z"),
    holdsToday: 0,
    prior: { callerQuotes24h: 0, callerDistinctServices24h: 0, callerDistinctZips24h: 0, tenantQuotes1h: 0 },
    takenWindowIds: new Set(),
    smsOk: true,
    summaryDest24h: 0,
    latency: { db: 40, capacity: 250, send: 300 },
    ...over,
  };
}

export function makeSettings(over: Record<string, unknown> = {}): AgentCallerSettings {
  return normalizeAgentCallerSettings({ enabled: true, ...over }) ?? DEFAULT_AGENT_CALLER_SETTINGS;
}
