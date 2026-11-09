// supabase/functions/_shared/vertical-ai/ontologySeed.ts
//
// Bundled seed for the trade ontology (version 1). The SAME keys/versions are inserted by
// supabase/migrations/20281120000000_vertical_ai_ontology_outcomes.sql (a test keeps the two in sync).
//
// HONESTY NOTE: `reviewed` is false on every entry. These are editorial summaries of standard trade practice and
// public-safety guidance; they have NOT been reviewed by a licensed HVAC/plumbing/electrical professional.
// Until `reviewed` is flipped by such a review, technical (non-safety) statements are only ever asserted as
// "uncertain" (see grounding.ts). There are NO prices and NO jurisdiction-specific code citations in this seed.

import type { OntologyEntry, PermitPayload, SafetyPayload, SymptomPayload } from "./ontology.ts";
import type { OntologyTrade, SafetyFlag, UrgencyClass } from "./types.ts";

const EFFECTIVE = "2026-11-01";
const SRC_PRACTICE = "Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)";
const SRC_SAFETY = "Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)";
const SRC_PERMIT = "Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides";

function symptom(
  trade: OntologyTrade, key: string, title: string, p: SymptomPayload, confidence = 0.7,
): OntologyEntry {
  return { trade, kind: "symptom", key, version: 1, title, payload: p, source: SRC_PRACTICE, effectiveOn: EFFECTIVE, expiresOn: null, jurisdiction: "US", confidence, reviewed: false };
}
function safety(flag: SafetyFlag, title: string, guidance: string): OntologyEntry {
  const payload: SafetyPayload = { flag, guidance };
  return { trade: "all", kind: "safety_rule", key: flag, version: 1, title, payload, source: SRC_SAFETY, effectiveOn: EFFECTIVE, expiresOn: null, jurisdiction: "US", confidence: 0.9, reviewed: false };
}
function permit(trade: OntologyTrade, key: string, title: string, p: PermitPayload): OntologyEntry {
  return { trade, kind: "permit_trigger", key, version: 1, title, payload: p, source: SRC_PERMIT, effectiveOn: EFFECTIVE, expiresOn: null, jurisdiction: "US", confidence: 0.6, reviewed: false };
}
const u = (x: UrgencyClass) => x;

export const SAFETY_GUIDANCE: Record<SafetyFlag, string> = {
  gas_odor: "Please leave the building now and leave the door open behind you. Don't use light switches, lighters or phones inside. From outside, call 911 or your gas utility's emergency line. I'm alerting our on-call technician right now.",
  carbon_monoxide: "Get everyone outside into fresh air right now and call 911. Don't go back in until emergency responders say it's safe. I'm alerting our on-call technician.",
  fire_or_smoke: "If you see flames or heavy smoke, get everyone out and call 911 first. I'm alerting our on-call technician.",
  sparking_or_burning: "If it's safe to reach, turn off the breaker for that circuit or the main breaker, and stay away from it. If you see smoke or flames, leave and call 911. I'm alerting our on-call technician.",
  electric_shock: "Don't touch the person or the appliance. If anyone was hurt or feels unwell, call 911. If it's safe, turn off power at the main breaker. I'm alerting our on-call technician.",
  downed_line: "Stay far away from the line and anything touching it, and call 911 and the power utility. I'm alerting our on-call technician.",
  water_near_electrical: "Stay away from outlets, panels and anything electrical near the water. If you can reach the main breaker safely and dry, turn it off. I'm alerting our on-call technician.",
  active_flooding: "If you can do it safely, shut off the main water valve and stay away from electrical items near standing water. I'm alerting our on-call technician.",
  sewage_backup: "Avoid contact with the water and don't use fixtures that drain into that line. I'm alerting our on-call technician.",
  no_heat_freezing: "I'm flagging this as an emergency for our on-call team. Keep everyone warm in one room, and if anyone feels unwell call 911.",
  vulnerable_occupant_no_climate: "I'm flagging this as an emergency for our on-call team. Move everyone vulnerable to a safe temperature, and if anyone feels unwell call 911.",
  caller_declared_emergency: "I'm flagging this as an emergency and alerting our on-call technician right now.",
};

const SAFETY_TITLES: Record<SafetyFlag, string> = {
  gas_odor: "Gas odor / suspected gas leak",
  carbon_monoxide: "Carbon monoxide alarm or symptoms",
  fire_or_smoke: "Fire or smoke",
  sparking_or_burning: "Sparking or burning at electrical equipment",
  electric_shock: "Electric shock",
  downed_line: "Downed or exposed live line",
  water_near_electrical: "Water near electrical equipment",
  active_flooding: "Active flooding or burst pipe",
  sewage_backup: "Sewage backup",
  no_heat_freezing: "No heat in freezing weather",
  vulnerable_occupant_no_climate: "No heating or cooling with a vulnerable occupant",
  caller_declared_emergency: "Caller declared an emergency",
};

export const ONTOLOGY_SEED: OntologyEntry[] = [
  // ---- safety rules (cross-trade) -------------------------------------------------------------------------
  ...(Object.keys(SAFETY_GUIDANCE) as SafetyFlag[]).map((f) => safety(f, SAFETY_TITLES[f], SAFETY_GUIDANCE[f])),

  // ---- HVAC ------------------------------------------------------------------------------------------------
  symptom("hvac", "no_cooling", "AC running but not cooling", {
    synonyms: ["ac not cooling", "air conditioner not cooling", "ac blowing warm air", "ac blows warm", "no cold air", "not cooling", "house wont cool", "ac isnt cooling well", "ac not cooling well", "ac running but warm", "ac no cold", "air not cold", "not making cold", "only warm wind", "only warm air", "ac is warm", "air conditioner not cold"],
    causes: [{ cause: "Dirty filter or restricted airflow", likelihood: "high" }, { cause: "Low refrigerant charge (leak)", likelihood: "medium" }, { cause: "Failed capacitor or condenser fan motor", likelihood: "medium" }, { cause: "Dirty condenser coil", likelihood: "medium" }],
    checks: ["Check filter condition", "Check thermostat mode and setpoint", "Verify outdoor unit running and fan spinning", "Measure supply/return temperature split", "Check refrigerant pressures and superheat/subcool"],
    parts: ["Run/start capacitor", "Condenser fan motor", "Air filter"], laborHours: { min: 0.5, max: 3 }, urgency: u("urgent"),
    escalateIf: ["Occupant is elderly, an infant or medically vulnerable in extreme heat"],
  })
  , symptom("hvac", "no_heat", "Heating not working", {
    synonyms: ["no heat", "heater not working", "furnace not working", "furnace not heating", "heat not working", "heater no work", "furnace wont turn on", "heat wont come on", "furnace stopped", "furnace is out", "no warm air", "boiler not working"],
    causes: [{ cause: "Ignition or flame-sensor fault", likelihood: "high" }, { cause: "Thermostat fault or batteries", likelihood: "medium" }, { cause: "Safety lockout (limit/pressure switch)", likelihood: "medium" }, { cause: "Gas or power supply interruption", likelihood: "low" }],
    checks: ["Check thermostat mode, setpoint, batteries", "Check power switch and breaker at the furnace", "Check error code on the control board", "Inspect flame sensor and ignitor", "Check gas supply and venting"],
    parts: ["Flame sensor", "Hot-surface ignitor", "Pressure switch", "Control board"], laborHours: { min: 0.5, max: 3 }, urgency: u("urgent"),
    escalateIf: ["Outdoor temperature at or below freezing", "Gas odor reported", "Vulnerable occupant"],
  })
  , symptom("hvac", "ac_freezing_up", "AC or evaporator coil icing over", {
    synonyms: ["ac freezing up", "ice on ac", "ice on the unit", "frozen evaporator", "ac frozen", "ice on the coil", "ice on refrigerant line", "ice on the pipe outside", "ice all over", "ice on the ac", "ice on the outdoor unit", "ice on my ac"],
    causes: [{ cause: "Restricted airflow (filter, blower)", likelihood: "high" }, { cause: "Low refrigerant charge", likelihood: "medium" }, { cause: "Failed blower motor", likelihood: "low" }],
    checks: ["Turn system off and let it thaw", "Check filter and return airflow", "Check blower operation", "Check refrigerant charge after thaw"],
    parts: ["Air filter", "Blower motor", "Blower capacitor"], laborHours: { min: 1, max: 3 }, urgency: u("urgent"),
  })
  , symptom("hvac", "short_cycling", "System turns on and off repeatedly", {
    synonyms: ["short cycling", "turns on and off", "keeps turning on and off", "starts and stops", "cycles on and off", "runs few minutes then stops", "shuts off after a few minutes"],
    causes: [{ cause: "Overheating from restricted airflow", likelihood: "high" }, { cause: "Oversized system or thermostat placement", likelihood: "medium" }, { cause: "Failing flame sensor or limit switch", likelihood: "medium" }],
    checks: ["Check filter and airflow", "Check thermostat location and settings", "Check limit switch and flame sensor", "Check refrigerant pressures"],
    parts: ["Flame sensor", "Limit switch", "Air filter"], laborHours: { min: 0.5, max: 2.5 }, urgency: u("routine"),
  })
  , symptom("hvac", "weak_airflow", "Weak airflow from vents", {
    synonyms: ["weak airflow", "low airflow", "air barely coming out", "vents weak", "not much air from vents", "little air coming out", "poor airflow"],
    causes: [{ cause: "Dirty filter or coil", likelihood: "high" }, { cause: "Blower motor or capacitor weakening", likelihood: "medium" }, { cause: "Duct restriction or leak", likelihood: "medium" }],
    checks: ["Check filter", "Check blower speed setting and capacitor", "Check duct dampers and obvious duct damage", "Check evaporator coil"],
    parts: ["Air filter", "Blower capacitor", "Blower motor"], laborHours: { min: 0.5, max: 2.5 }, urgency: u("routine"),
  })
  , symptom("hvac", "condensate_leak", "Water leaking from indoor unit", {
    synonyms: ["ac leaking water", "water leaking from ac", "water under furnace", "water dripping from air handler", "ac dripping inside", "water from vent", "drain line clogged", "condensate leak"],
    causes: [{ cause: "Clogged condensate drain line", likelihood: "high" }, { cause: "Cracked or overflowing drain pan", likelihood: "medium" }, { cause: "Frozen coil melting", likelihood: "medium" }],
    checks: ["Inspect drain line and trap", "Inspect drain pan", "Check float switch", "Check for coil icing"],
    parts: ["Condensate float switch", "Drain pan"], laborHours: { min: 0.5, max: 2 }, urgency: u("urgent"),
  })
  , symptom("hvac", "outdoor_unit_noise", "Loud noise from outdoor unit", {
    synonyms: ["outdoor unit loud", "ac making loud noise", "banging from outside unit", "outside unit buzzing", "ac humming but not starting", "grinding noise from ac", "unit outside is noisy", "squealing from ac", "outdoor unit is making", "loud banging noise", "loud noise from the unit", "banging noise", "outdoor unit banging"],
    causes: [{ cause: "Failing condenser fan motor or bearings", likelihood: "medium" }, { cause: "Failing capacitor (hum without start)", likelihood: "high" }, { cause: "Loose panel or debris", likelihood: "medium" }, { cause: "Compressor mechanical issue", likelihood: "low" }],
    checks: ["Inspect fan blade and debris", "Test capacitor", "Check amp draw on compressor and fan", "Check mounting and panels"],
    parts: ["Run capacitor", "Condenser fan motor", "Contactor"], laborHours: { min: 0.5, max: 3 }, urgency: u("urgent"),
  })
  , symptom("hvac", "thermostat_blank", "Thermostat blank or unresponsive", {
    synonyms: ["thermostat blank", "thermostat not working", "thermostat screen dead", "thermostat no power", "thermostat wont turn on", "thermostat is dead", "thermostat screen is blank", "thermostat screen blank"],
    causes: [{ cause: "Dead batteries", likelihood: "high" }, { cause: "Tripped float switch or blown low-voltage fuse", likelihood: "medium" }, { cause: "Failed transformer", likelihood: "low" }],
    checks: ["Replace batteries", "Check low-voltage fuse and float switch", "Check transformer output"],
    parts: ["Thermostat", "Low-voltage fuse", "Transformer"], laborHours: { min: 0.5, max: 1.5 }, urgency: u("routine"),
  })
  , symptom("hvac", "pilot_or_ignition_failure", "Furnace clicks but does not light", {
    synonyms: ["furnace clicking", "furnace clicks but no flame", "furnace wont ignite", "pilot light out", "pilot wont stay lit", "furnace tries to start then stops", "burner wont light"],
    causes: [{ cause: "Dirty flame sensor", likelihood: "high" }, { cause: "Failed ignitor", likelihood: "medium" }, { cause: "Gas valve or supply problem", likelihood: "low" }],
    checks: ["Read control-board error code", "Inspect flame sensor and ignitor", "Verify gas supply and valve", "Check venting and pressure switch"],
    parts: ["Flame sensor", "Hot-surface ignitor", "Gas valve"], laborHours: { min: 0.5, max: 2.5 }, urgency: u("urgent"),
    escalateIf: ["Gas odor reported"],
  })

  // ---- Plumbing ----------------------------------------------------------------------------------------------
  , symptom("plumbing", "clogged_drain", "Slow or clogged drain", {
    synonyms: ["clogged drain", "drain clogged", "drain is slow", "sink wont drain", "tub wont drain", "shower wont drain", "water not going down", "water not going", "sink backed up", "toilet is not going down", "sink is making stuck", "drain blocked", "drain is stopped", "drains slowly", "sink drains slowly", "slow sink", "drain cleaning"],
    causes: [{ cause: "Local blockage (hair, grease, debris)", likelihood: "high" }, { cause: "Main line blockage if several fixtures are affected", likelihood: "medium" }],
    checks: ["Identify whether one fixture or several are affected", "Snake the fixture drain", "Camera-inspect the line if it recurs"],
    parts: ["P-trap", "Cleanout cap"], laborHours: { min: 0.5, max: 2 }, urgency: u("routine"),
    escalateIf: ["Multiple fixtures backing up or sewage visible"],
  })
  , symptom("plumbing", "no_hot_water", "No hot water", {
    synonyms: ["no hot water", "water heater not working", "water is cold", "only cold water", "hot water gone", "water not getting hot", "no warm water", "water heater no heat", "hot water finished", "hot water is gone", "not producing hot water", "isnt producing hot water", "not getting any hot water", "not making hot water", "hot water not working", "only cold water coming"],
    causes: [{ cause: "Gas unit: pilot/thermocouple or burner fault", likelihood: "high" }, { cause: "Electric unit: failed heating element or thermostat, tripped breaker", likelihood: "high" }, { cause: "Sediment buildup reducing capacity", likelihood: "medium" }],
    checks: ["Determine gas vs electric unit", "Check breaker or pilot status", "Check thermostat setting", "Inspect for leaks at tank"],
    parts: ["Heating element", "Thermostat", "Thermocouple"], laborHours: { min: 1, max: 3 }, urgency: u("urgent"),
    escalateIf: ["Gas odor reported", "Water pooling around the tank"],
  })
  , symptom("plumbing", "water_heater_leaking", "Water heater leaking", {
    synonyms: ["water heater leaking", "water heater is leaking", "leak from water heater", "water around water heater", "tank leaking", "water pooling by water heater", "hot water tank leaking"],
    causes: [{ cause: "Failed fitting or relief valve discharge", likelihood: "medium" }, { cause: "Tank corrosion (typically requires replacement)", likelihood: "medium" }],
    checks: ["Locate the source of the water", "Shut off water supply and power/gas to the unit if leaking heavily", "Inspect T&P valve and fittings"],
    parts: ["T&P relief valve", "Supply connectors"], laborHours: { min: 1, max: 4 }, urgency: u("urgent"),
    escalateIf: ["Water is flowing heavily"],
  })
  , symptom("plumbing", "running_toilet", "Toilet keeps running", {
    synonyms: ["toilet running", "toilet keeps running", "running toilet", "toilet wont stop running", "toilet runs all the time", "toilet constantly running", "toilet hissing", "inodoro corriendo", "toilet always running"],
    causes: [{ cause: "Worn flapper", likelihood: "high" }, { cause: "Faulty fill valve", likelihood: "high" }, { cause: "Incorrect water level or chain", likelihood: "medium" }],
    checks: ["Dye test for flapper leak", "Check fill valve and float", "Check chain slack"],
    parts: ["Flapper", "Fill valve"], laborHours: { min: 0.5, max: 1 }, urgency: u("routine"),
  })
  , symptom("plumbing", "low_water_pressure", "Low water pressure", {
    synonyms: ["low water pressure", "weak water pressure", "water pressure is low", "water barely coming out", "shower pressure weak", "no water pressure", "trickle from faucet"],
    causes: [{ cause: "Clogged aerators or fixture cartridges", likelihood: "high" }, { cause: "Partially closed or failing shutoff or pressure regulator", likelihood: "medium" }, { cause: "Supply-line corrosion or leak", likelihood: "low" }],
    checks: ["Determine if one fixture or the whole house", "Check main shutoff and pressure regulator", "Measure static pressure with a gauge"],
    parts: ["Pressure regulator", "Faucet aerator"], laborHours: { min: 0.5, max: 3 }, urgency: u("routine"),
  })
  , symptom("plumbing", "sewer_odor", "Sewer smell indoors", {
    synonyms: ["sewer smell", "smells like sewage", "sewage smell", "bad smell from drain", "rotten smell from drain", "drain smells", "smells like sewer"],
    causes: [{ cause: "Dry P-trap on a seldom-used fixture", likelihood: "high" }, { cause: "Failed wax ring or vent problem", likelihood: "medium" }, { cause: "Partial main-line blockage", likelihood: "low" }],
    checks: ["Run water in rarely used drains", "Check toilet seal", "Check vent terminations", "Camera-inspect if persistent"],
    parts: ["Wax ring", "P-trap"], laborHours: { min: 0.5, max: 3 }, urgency: u("routine"),
    escalateIf: ["Odor smells like rotten eggs and may be gas rather than sewer"],
  })
  , symptom("plumbing", "garbage_disposal_jam", "Garbage disposal jammed or humming", {
    synonyms: ["garbage disposal not working", "disposal humming", "disposal jammed", "disposal wont spin", "garbage disposal stuck", "disposal is stuck", "garbage disposal is humming", "disposal humming"],
    causes: [{ cause: "Jammed flywheel", likelihood: "high" }, { cause: "Tripped reset button or failed motor", likelihood: "medium" }],
    checks: ["Power off before inspecting", "Rotate flywheel with the wrench slot", "Check reset button"],
    parts: ["Disposal unit", "Flange kit"], laborHours: { min: 0.5, max: 2 }, urgency: u("routine"),
  })
  , symptom("plumbing", "dripping_faucet", "Dripping faucet", {
    synonyms: ["faucet leaking", "faucet dripping", "dripping faucet", "dripping faucet in the bathroom", "leaky faucet", "faucet drips", "faucet wont stop dripping"],
    causes: [{ cause: "Worn cartridge, washer or o-ring", likelihood: "high" }, { cause: "Worn valve seat", likelihood: "medium" }],
    checks: ["Identify faucet type", "Inspect cartridge or washer", "Confirm no leak at supply connections"],
    parts: ["Faucet cartridge", "O-ring kit"], laborHours: { min: 0.5, max: 1.5 }, urgency: u("routine"),
    escalateIf: ["Water spraying or flowing, not dripping"],
  })
  , symptom("plumbing", "leaking_pipe_or_faucet", "Leaking pipe, faucet or fixture", {
    synonyms: ["leaking pipe", "pipe is leaking", "faucet dripping", "leak under sink", "water under the sink", "drip under sink"],
    causes: [{ cause: "Worn cartridge, washer or o-ring", likelihood: "high" }, { cause: "Loose or failed supply connection", likelihood: "medium" }, { cause: "Corroded or cracked pipe", likelihood: "low" }],
    checks: ["Locate source and shut local stop valve", "Inspect connections and cartridge", "Dry and re-check to confirm source"],
    parts: ["Faucet cartridge", "Supply line", "Compression fitting"], laborHours: { min: 0.5, max: 2.5 }, urgency: u("urgent"),
    escalateIf: ["Water spraying or flowing heavily", "Cannot shut off water"],
  })

  // ---- Electrical ----------------------------------------------------------------------------------------------
  , symptom("electrical", "outlet_dead", "Outlet or switch not working", {
    synonyms: ["outlet not working", "outlet dead", "outlet has no power", "plug not working", "switch not working", "outlet stopped working", "no power at outlet", "socket not working", "outlet in the living room doesnt work", "outlet doesnt work", "outlet wont work"],
    causes: [{ cause: "Tripped GFCI upstream", likelihood: "high" }, { cause: "Tripped breaker", likelihood: "high" }, { cause: "Loose connection or failed device", likelihood: "medium" }],
    checks: ["Reset GFCI outlets and check breaker", "Test with a known-good load", "Inspect device and connections with power off"],
    parts: ["Receptacle", "GFCI receptacle"], laborHours: { min: 0.5, max: 2 }, urgency: u("routine"),
    escalateIf: ["Burning smell, heat or discoloration at the device"],
  })
  , symptom("electrical", "breaker_trips", "Breaker keeps tripping", {
    synonyms: ["breaker keeps tripping", "breaker trips", "breaker wont reset", "circuit breaker tripping", "breaker keeps going off", "fuse keeps blowing", "breaker tripped again"],
    causes: [{ cause: "Overloaded circuit", likelihood: "high" }, { cause: "Short circuit or ground fault", likelihood: "medium" }, { cause: "Failing breaker", likelihood: "medium" }],
    checks: ["Identify the load on the circuit", "Unplug loads and re-test", "Check for heat or damage at the panel and device"],
    parts: ["Circuit breaker"], laborHours: { min: 1, max: 3 }, urgency: u("urgent"),
    escalateIf: ["Burning smell or visible damage at the panel"],
  })
  , symptom("electrical", "flickering_lights", "Flickering or dimming lights", {
    synonyms: ["lights flickering", "flickering lights", "lights dimming", "lights flicker", "lights go dim", "lights blink", "lights keep flickering"],
    causes: [{ cause: "Loose bulb, fixture or dimmer incompatibility", likelihood: "high" }, { cause: "Loose neutral or connection in the circuit or panel", likelihood: "medium" }, { cause: "Utility-side voltage problem", likelihood: "low" }],
    checks: ["Determine whether one fixture or the whole house", "Swap bulb and check dimmer type", "Inspect connections; check service voltage"],
    parts: ["Dimmer switch", "Light fixture"], laborHours: { min: 1, max: 3 }, urgency: u("urgent"),
    escalateIf: ["Whole-house flicker combined with burning smell, buzzing or heat"],
  })
  , symptom("electrical", "panel_buzzing", "Panel buzzing or hot", {
    synonyms: ["panel buzzing", "breaker box buzzing", "panel is hot", "breaker box hot", "electrical panel humming", "breaker panel noise", "buzzing from panel", "buzzing from the electrical panel", "electrical panel is buzzing", "buzzing from the breaker box"],
    causes: [{ cause: "Loose lug or failing breaker", likelihood: "medium" }, { cause: "Overloaded or arcing connection", likelihood: "medium" }],
    checks: ["Do not open the panel cover as a homeowner", "Inspect for heat discoloration with proper PPE", "Thermal-scan connections"],
    parts: ["Circuit breaker", "Main breaker"], laborHours: { min: 1, max: 4 }, urgency: u("urgent"),
    escalateIf: ["Burning smell, sparking, smoke or heat at the panel"],
  })
  , symptom("electrical", "gfci_tripping", "GFCI keeps tripping", {
    synonyms: ["gfci keeps tripping", "gfci wont reset", "gfci tripping", "gfci outlet wont reset", "gfci wont reset", "gfi wont reset", "outlet wont reset", "reset button wont stay", "outdoor outlet keeps tripping"],
    causes: [{ cause: "Moisture in the circuit or device", likelihood: "high" }, { cause: "Failing GFCI device", likelihood: "medium" }, { cause: "Ground fault in connected appliance", likelihood: "medium" }],
    checks: ["Unplug all loads and reset", "Inspect for moisture", "Test GFCI device"],
    parts: ["GFCI receptacle", "Weatherproof cover"], laborHours: { min: 0.5, max: 2 }, urgency: u("routine"),
  })
  , symptom("electrical", "partial_power_loss", "Part of the house has no power", {
    synonyms: ["half the house no power", "part of house has no power", "some outlets dead", "room has no power", "power out in some rooms", "lost power in half the house", "half my house is out", "half the house has no power", "half of my house has no power", "no light in half of my house", "no light in the half of my house", "part of the house has no power"],
    causes: [{ cause: "Tripped breaker or one leg of service lost", likelihood: "medium" }, { cause: "Failed main breaker or loose service connection", likelihood: "low" }],
    checks: ["Check main and branch breakers", "Check whether the neighbors are affected (utility)", "Measure voltage at the panel with proper PPE"],
    parts: ["Main breaker", "Circuit breaker"], laborHours: { min: 1, max: 4 }, urgency: u("urgent"),
  })

  // ---- Permit triggers (generic US heuristics; the AHJ decides) -------------------------------------------------
  , permit("plumbing", "water_heater_replacement", "Water heater replacement", { work: "Water heater replacement", synonyms: ["replace water heater", "new water heater", "water heater replacement", "install water heater", "swapping out water heater", "swap water heater", "swapping water heater", "change out water heater"], note: "Most US jurisdictions require a permit; the local authority having jurisdiction decides." })
  , permit("hvac", "equipment_replacement", "Furnace or AC replacement", { work: "HVAC equipment replacement", synonyms: ["replace furnace", "new furnace", "replace ac", "new ac", "new air conditioner", "replace air conditioner", "install furnace", "install ac", "new heat pump"], note: "Most US jurisdictions require a mechanical permit for changeouts; the local authority having jurisdiction decides." })
  , permit("electrical", "panel_upgrade", "Electrical panel upgrade or replacement", { work: "Service panel work", synonyms: ["panel upgrade", "replace panel", "new panel", "upgrade electrical panel", "200 amp service", "replace breaker panel", "upgrade service"], note: "Panel and service work almost always requires an electrical permit and inspection; the local authority having jurisdiction decides." })
  , permit("electrical", "new_circuit", "New circuit or outlet installation", { work: "New circuits", synonyms: ["new circuit", "add outlet", "install new outlet", "add a circuit", "ev charger install", "install ev charger", "add a 240 outlet"], note: "New circuits commonly require a permit; the local authority having jurisdiction decides." })
  , permit("plumbing", "gas_line_work", "Gas line installation or modification", { work: "Gas piping", synonyms: ["new gas line", "move gas line", "gas line install", "run a gas line", "gas stove hookup", "gas range hookup", "gas piping"], note: "Gas piping work typically requires a permit and pressure test; the local authority having jurisdiction decides." })
  , permit("plumbing", "repipe", "Whole-house repipe", { work: "Repiping", synonyms: ["repipe", "re-pipe", "replace all the pipes", "whole house repipe", "replace main water line", "new water main"], note: "Repiping commonly requires a plumbing permit; the local authority having jurisdiction decides." }),
];
