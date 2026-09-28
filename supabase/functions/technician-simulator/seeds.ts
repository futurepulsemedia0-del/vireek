// supabase/functions/technician-simulator/seeds.ts
//
// Fault families steer the model toward real, common field failures instead of
// letting it free-associate (less hallucination, more variety, and a shorter
// prompt). The hint names the SYMPTOM area only - never the answer.

import type { Trade } from "./normalize.ts";

export interface Seed { trade: Trade; family: string; hint: string }

export const SEEDS: Seed[] = [
  { trade: "hvac", family: "no_cooling_running", hint: "Central AC runs but the house does not cool. Blower and outdoor fan run." },
  { trade: "hvac", family: "outdoor_unit_wont_start", hint: "Indoor blower runs, outdoor unit hums or does not start." },
  { trade: "hvac", family: "short_cycling", hint: "System starts and stops repeatedly, never completing a full cycle." },
  { trade: "hvac", family: "furnace_no_heat", hint: "Gas furnace calls for heat but there is no flame or it shuts down after a few seconds." },
  { trade: "hvac", family: "iced_coil", hint: "Evaporator coil or suction line freezing over, weak airflow, water on floor after thaw." },
  { trade: "hvac", family: "heat_pump_no_heat", hint: "Heat pump blows cool air in heating mode during cold weather." },
  { trade: "plumbing", family: "no_hot_water", hint: "Tank water heater produces no hot water or only lukewarm water." },
  { trade: "plumbing", family: "low_pressure", hint: "Whole-house or single-fixture low water pressure that developed over time." },
  { trade: "plumbing", family: "recurring_drain_clog", hint: "Main drain or kitchen line backs up repeatedly after being snaked." },
  { trade: "plumbing", family: "running_toilet_leak", hint: "Constant running water or hidden leak with rising water bill and damp spot." },
  { trade: "electrical", family: "breaker_trips", hint: "A circuit breaker trips repeatedly, sometimes immediately, sometimes under load." },
  { trade: "electrical", family: "dead_outlets", hint: "Several outlets or a room lost power with no tripped breaker visible." },
  { trade: "electrical", family: "flickering_lights", hint: "Lights flicker or dim when large appliances start; possible shared neutral or connection issue." },
  { trade: "appliance", family: "fridge_not_cooling", hint: "Refrigerator warm while compressor or fans behave oddly; freezer may be fine or frosted." },
  { trade: "appliance", family: "dryer_no_heat", hint: "Electric or gas dryer tumbles but does not heat or takes several cycles to dry." },
  { trade: "appliance", family: "washer_wont_drain", hint: "Washer fills and agitates but leaves water in the drum and stops mid-cycle." },
];

export function seedsForTrade(trade: Trade): Seed[] {
  return SEEDS.filter((s) => s.trade === trade);
}
