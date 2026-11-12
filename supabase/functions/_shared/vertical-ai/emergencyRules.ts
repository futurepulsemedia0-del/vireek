// supabase/functions/_shared/vertical-ai/emergencyRules.ts
//
// Deterministic trade emergency layer. PURE, dependency-light, NO LLM: it must keep working when every model
// provider is down. Emergency RECALL is the primary metric, so every ambiguity resolves toward "emergency"
// (a false positive costs one extra phone call; a false negative can cost a life or a house).
//
// It EXTENDS voice-resilience/emergencyFastPath.ts (the degraded-mode detector) instead of replacing it: that
// detector is used as a backstop for life-safety ids unless this layer saw an explicit negation for the same hazard.
//
// Scope of "emergency": life-safety hazards (gas, CO, fire/smoke, sparking, shock, downed lines, water meeting
// electricity, active flooding, sewage backup) and no-heat/no-cooling when it endangers people (freezing weather
// or a vulnerable occupant). "urgent" is same-day-service territory; everything else is "routine".

import { detectEmergencyText } from "../voice-resilience/emergencyFastPath.ts";
import { SAFETY_GUIDANCE } from "./ontologySeed.ts";
import { normalizeText } from "./ontology.ts";
import type { SafetyFlag, UrgencyClass, UrgencyVerdict } from "./types.ts";

type Severity = Exclude<UrgencyClass, "routine">;
interface Rule { id: string; flag: SafetyFlag | null; severity: Severity; re: RegExp; guard?: RegExp }

/** Two terms within `n` words of each other, either order. Operates on normalizeText() output. */
function near(a: string, b: string, n = 5): RegExp {
  return new RegExp(`\\b(?:${a})(?: \\S+){0,${n}} (?:${b})\\b|\\b(?:${b})(?: \\S+){0,${n}} (?:${a})\\b`);
}
const re = (s: string) => new RegExp(s);

const GAS = "gas|propane|lpg|natural gas|methane";
const ODOR = "smell|smells|smelling|smelled|smelly|odor|odour|stink|stinks|stinking|fumes|fume|hissing|huele|olor";
const ELEC = "outlet|outlets|panel|breaker|breakers|wire|wires|wiring|plug|plugs|switch|switches|fuse|fuses|fuse box|cord|socket|sockets|fixture|light|lights|appliance|meter|transformer|power strip|box";
const SPARK = "spark|sparks|sparking|sparked|arcing|arc|arcs|crackling|crackle|sizzling|popping|burning|burnt|burned|melting|melted|smoking|smoked|buzzing hot|too hot|very hot|hot to the touch";
const WATER = "water|wet|flooded|flooding|leak|leaking|leaks|dripping|soaked|dripped";
const ELEC_WET = "outlet|outlets|panel|breaker|breakers|electrical|wiring|light fixture|fixtures|light|lights|ceiling lights?|fuse box|power strip|switchboard";
const HEAT = "heat(?! wave)|(?<!water )heater|heating|furnace|boiler|heat pump|hvac";
const COOL = "ac|a c|air conditioning|air conditioner|air conditioning|cooling|a c unit";
const BROKEN = "not working|isnt working|is not working|not heating|not cooling|broken|broke|dead|is out|are out|went out|goes out|completely out|out since|out all|out for|out again|out today|out this|out last|out overnight|is down|are down|stopped|failed|quit|wont turn on|wont start|wont come on|wont work|doesnt work|doesnt turn on|no work|not turning on|not coming on|is off|went out";
const VULN = "baby|babies|infant|newborn|toddler|elderly|grandma|grandmother|grandpa|grandfather|oxygen|dialysis|insulin|disabled|pregnant|senior|seniors|old lady|old man|old woman|bedridden|medical equipment|medically fragile";

const RULES: Rule[] = [
  // ---- gas ------------------------------------------------------------------------------------------------------
  { id: "gas_odor_near", flag: "gas_odor", severity: "emergency", re: near(GAS, ODOR, 5) },
  { id: "gas_rotten_eggs", flag: "gas_odor", severity: "emergency", re: re("\\b(?:rotten eggs?|sulfur|sulphur|egg smell)\\b") },
  { id: "gas_leak_phrase", flag: "gas_odor", severity: "emergency", re: re("\\b(?:gas (?:leak|leaking|leaks|line (?:broke|broken|ruptured|cut|hit|damaged))|leaking gas|hit a gas line|fuga de gas|huele a gas|olor a gas)\\b") },
  // ---- carbon monoxide ------------------------------------------------------------------------------------------
  { id: "co_named", flag: "carbon_monoxide", severity: "emergency", re: re("\\b(?:carbon monoxide|monoxide|monoxido de carbono|co (?:alarm|detector|sensor|monitor)|co2? alarm)\\b") },
  { id: "co_symptoms", flag: "carbon_monoxide", severity: "emergency", re: near("headache|headaches|dizzy|dizziness|nausea|nauseous|passed out|fainted|light headed|lightheaded", "furnace|heater|boiler|water heater|gas stove|generator|gas oven|fireplace", 8) },
  // ---- fire / smoke ---------------------------------------------------------------------------------------------
  { id: "alarm_going_off", flag: "fire_or_smoke", severity: "emergency", re: near("smoke alarm|smoke alarms|smoke detector|smoke detectors|fire alarm", "going off|blaring|sounding|screaming|wont stop|keeps going off|is going off|are going off", 3) },
  { id: "fire_words", flag: "fire_or_smoke", severity: "emergency", re: re("\\b(?:on fire|caught fire|catching fire|is burning|are burning|flames?|house fire|electrical fire|fire in|smoke|smoking|smokey|smoky|incendio|humo)\\b") },
  // ---- sparking / burning electrical ----------------------------------------------------------------------------
  { id: "spark_alone", flag: "sparking_or_burning", severity: "emergency", re: re("\\b(?:spark|sparks|sparking|sparked|arcing)\\b") },
  { id: "elec_hot_or_burning", flag: "sparking_or_burning", severity: "emergency", re: near(ELEC, SPARK, 6), guard: re("\\b(?:hot water|water heater|pilot light|hot tub)\\b") },
  { id: "burning_smell_electrical", flag: "sparking_or_burning", severity: "emergency", re: near("burning|burnt|melting|melted|plastic|electrical", "smell|smells|smelling|odor|odour", 4), guard: re("\\b(?:toast|food|cooking|candle|popcorn|dinner|oven)\\b") },
  { id: "burning_smell_generic", flag: null, severity: "urgent", re: near("burning|burnt|melting", "smell|smells|smelling|odor|odour", 4), guard: re("\\b(?:toast|food|cooking|candle|popcorn|dinner)\\b") },
  // ---- shock / downed lines -------------------------------------------------------------------------------------
  { id: "shock_explicit", flag: "electric_shock", severity: "emergency", re: re("\\b(?:electrocuted|electrocution|electric shock|electrical shock|got shocked|get shocked|getting shocked|shocked me|shocks me|got zapped|zapped me|got a shock|received a shock)\\b"), guard: re("\\b(?:price|prices|quote|quotes|bill|cost|costs|estimate|amount|total|rate|rates|fee|fees|number)\\b") },
  { id: "shock_context", flag: "electric_shock", severity: "emergency", re: near("shock|shocked|shocks|zapped|tingle|tingling|tingles|electric current", "faucet|sink|outlet|switch|appliance|fridge|refrigerator|washer|dryer|panel|door knob|doorknob|metal|pipe|stove|lamp|touch|touched|touching|shower|tub", 6) },
  { id: "downed_line", flag: "downed_line", severity: "emergency", re: re("\\b(?:downed|fallen|broken|snapped) (?:power |electric |electrical |utility )?(?:line|lines|wire|wires|cable|cables|pole)\\b|\\b(?:power ?line|electric wire|live wire|utility wire|power lines?|wire|wires)s? (?:is |are )?(?:\\S+ )?(?:down|on the ground|fell|fallen|hanging|sparking)\\b|\\bwire down\\b|\\bline down\\b|\\b(?:knocked|brought) (?:a |the )?(?:wire|line|power line)s? down\\b") },
  // ---- water + electricity, flooding, sewage ------------------------------------------------------------------
  { id: "water_near_electrical", flag: "water_near_electrical", severity: "emergency", re: near(WATER, ELEC_WET, 6), guard: re("\\b(?:water heater|hot water)\\b.{0,20}\\b(?:breaker)\\b") },
  { id: "flood_words", flag: "active_flooding", severity: "emergency", re: re("\\b(?:flood|flooded|flooding|floods|inundacion|inundado|se inunda)\\b"), guard: re("\\b(?:flood insurance|flood zone|flood light|floodlight|flood lamp|flood plain|flood sensor|flood valve)\\b") },
  { id: "pipe_burst", flag: "active_flooding", severity: "emergency", re: near("pipe|pipes|main|water line|supply line|hose|water main|tuberia", "burst|bursted|busted|ruptured|exploded|snapped|broke|broken|rota|se rompio", 3) },
  { id: "pipe_pouring", flag: "active_flooding", severity: "emergency", re: near("pipe|pipes|faucet|wall|toilet|tank|hose", "pouring|gushing|spraying|shooting|streaming", 4) },
  { id: "water_gushing", flag: "active_flooding", severity: "emergency", re: near("water|agua", "pouring|gushing|spraying|shooting|everywhere|rushing|streaming|like a river|like river|waterfall|por todas partes", 4) },
  { id: "cant_find_valve", flag: "active_flooding", severity: "emergency", re: re("\\b(?:cant|cannot|unable to|couldnt|dont know where|not sure where) (?:\\S+ ){0,3}(?:find|locate)(?: \\S+){0,3} (?:valve|shutoff|shut off|main)\\b"), guard: re("\\b(?:gas)\\b") },
  { id: "water_spreading", flag: "active_flooding", severity: "emergency", re: near("water", "spreading|rising|filling|covering|all over|across the floor", 3) },
  { id: "cant_shut_off", flag: "active_flooding", severity: "emergency", re: re("\\b(?:cant|cannot|unable to|couldnt|wont|doesnt|isnt|not able to) (?:\\S+ ){0,3}(?:shut|turn|stop|close)(?:\\S+ ){0,3}(?:water|valve|leak|pipe|flow)\\b") },
  { id: "electricity_hitting", flag: "electric_shock", severity: "emergency", re: near("electricity|electric|current|electrico", "hit|hitting|hits|bit|bite|biting|hurt|hurts|hurting|shock|shocking|zap|zapping|pain|painful", 5) },
  { id: "ceiling_water_severe", flag: "active_flooding", severity: "emergency", re: near("ceiling|ceilings", "collapsed|collapsing|bulging|sagging|caving|caved|pouring", 4), guard: re("\\bnot\\b") },
  { id: "standing_water_depth", flag: "active_flooding", severity: "emergency", re: re("\\b(?:inch|inches|feet|foot|ankle deep|knee deep) of (?:standing )?water\\b|\\bwater (?:is )?(?:ankle|knee) deep\\b|\\bbasement (?:is )?(?:filling|full of water|underwater)\\b") },
  { id: "sewage_backup", flag: "sewage_backup", severity: "emergency", re: re("\\b(?:sewage|raw sewage|sewer backup|sewer back up|sewer backing up|sewer overflow|sewage backing up|sewage overflow)\\b|\\b(?:main line|main drain|all (?:the )?drains|every drain|all drains|multiple drains) (?:is |are )?(?:backing up|backed up|overflowing)\\b") },
  // ---- caller-declared -------------------------------------------------------------------------------------------
  { id: "caller_declared", flag: "caller_declared_emergency", severity: "emergency", re: re("\\b(?:emergency|emergencia|life threatening|life-threatening|911)\\b"), guard: re("\\b(?:fee|fees|charge|charges|charged|rate|rates|cost|costs|price|prices|pricing|how much|extra|surcharge|premium|diagnostic|per hour|hourly|do you offer|do you do|do you have|hours|call out|callout)\\b") },
  // ---- Spanish life-safety phrasings (accent-folded) --------------------------------------------------------------
  { id: "es_pipe_burst", flag: "active_flooding", severity: "emergency", re: near("tubo|tubos|tuberia|tuberias|cano|canos|caneria|llave de agua", "rompio|rompieron|revento|reventaron|exploto|rota|roto|reventado", 4) },
  { id: "es_flooding", flag: "active_flooding", severity: "emergency", re: re("\\b(?:se esta inundando|se inundo|esta inundado|esta inundada|inundando|agua por todas partes|agua saliendo)\\b") },
  { id: "es_sparks", flag: "sparking_or_burning", severity: "emergency", re: re("\\b(?:chispa|chispas|chispeando|echando chispas|sale humo|olor a quemado|huele a quemado|se quemo)\\b") },
  { id: "es_gas", flag: "gas_odor", severity: "emergency", re: near("gas", "huele|olor|fuga|escape", 4) },
  // ---- Roofing: open roof / storm damage -----------------------------------------------------------------------------
  { id: "roof_open", flag: null, severity: "emergency", re: near("roof|roofing|ceiling|attic", "hole|collapsed|caved in|caving in|blown off|ripped off|torn off|tore off|took off|taken off|peeled off|came off|flew off", 6) },
  { id: "rain_coming_in", flag: null, severity: "emergency", re: near("rain|raining|rainwater|storm water", "coming in|coming into|coming through|pouring in|pouring into|pouring through|getting in|getting into|leaking into", 5) },
  { id: "tree_on_house", flag: null, severity: "emergency", re: re("\\b(?:tree|trees|branch|limb)\\b(?: \\S+){0,4} (?:fell|fallen|crashed|landed|came through|went through|through)\\b(?: \\S+){0,4} (?:roof|house|ceiling|attic|home)\\b") },
  // ---- urgent-only -----------------------------------------------------------------------------------------------
  { id: "urgent_words", flag: null, severity: "urgent", re: re("\\b(?:urgent|urgente|asap|right away|immediately|as soon as possible|tonight|cant wait|today)\\b") },
  { id: "water_heater_leak", flag: null, severity: "urgent", re: near("water heater|hot water tank|tank", "leaking|leak|leaks|dripping|pooling", 5) },
  { id: "ceiling_leak", flag: null, severity: "urgent", re: near("ceiling|ceilings", "leaking|leak|leaks|dripping|wet|stain", 4) },
  { id: "overflowing", flag: null, severity: "urgent", re: re("\\b(?:toilet|sink|tub|bathtub) (?:is |keeps )?overflowing\\b|\\boverflowing (?:toilet|sink|tub|bathtub)\\b") },
  { id: "frozen_pipes", flag: null, severity: "urgent", re: re("\\b(?:frozen pipes?|pipes? (?:is |are )?frozen|pipe froze|pipes froze|no water at all)\\b") },
  { id: "panel_noise", flag: null, severity: "urgent", re: near("panel|breaker box|breaker panel|fuse box", "buzzing|humming|hot|warm|noise", 4) },
  { id: "breaker_wont_reset", flag: null, severity: "urgent", re: re("\\bbreaker (?:keeps tripping|wont reset|trips|keeps going off)\\b") },
  { id: "no_heat_alone", flag: null, severity: "urgent", re: re(`\\b(?:no heat|no heating|without heat|no hot air|no warm air)\\b`) },
  { id: "no_cooling_alone", flag: null, severity: "urgent", re: re(`\\b(?:no ac|no a c|no air conditioning|no cooling|no cold air)\\b`) },
];

/** "no gas smell", "not an emergency", "dont smell any gas": a negator directly before the match (<=3 filler words). */
const NEGATION_BEFORE = /\b(?:no|not|isnt|arent|wasnt|dont|doesnt|didnt|never|without|nothing like)\s+(?:(?:an?|any|the|really|exactly|quite|actually|real|true|longer|see|smell|hear|notice|detect|have|has|get|got|had|smelling|seeing|any kind of)\s+){0,3}$/;

function negatedBefore(text: string, idx: number): boolean {
  return NEGATION_BEFORE.test(text.slice(Math.max(0, idx - 32), idx));
}

const COLD_WORDS = /\b(?:mucho frio|hace frio|muy frio|frio afuera|helando|freezing|below freezing|below zero|sub ?zero|snow|snowing|snowstorm|blizzard|ice storm|cold snap|polar vortex|frost|frosty|bitter cold|extremely cold|very cold outside)\b|(?:^|\s)(?:-\d{1,2}|minus \d{1,2}|negative \d{1,2}|(?:[0-9]|[12][0-9]|3[0-2])) ?(?:degrees|f|fahrenheit)\b/;
const HOT_WORDS = /\b(?:heat ?wave|extreme heat|triple digits|scorching|sweltering|boiling hot outside|(?:9[5-9]|1[0-2]\d) degrees?)\b/;
const INDOOR_COLD = /\b(?:house|home|inside|indoors|indoor|room|apartment|bedroom|baby|infant|newborn|kids?|children|grandma|grandpa|mother|father) (?:is |are |its |getting |gets |feels )?(?:freezing|very cold|extremely cold|getting cold|so cold|really cold|cold|\d{2} degrees)\b/;
const INDOOR_HOT = /\b(?:house|home|inside|indoors|indoor|room|apartment|bedroom) (?:is |its |getting |gets |feels )?(?:boiling|very hot|extremely hot|getting hot|so hot|really hot|sweltering|9\d degrees|10\d degrees)\b/;

export interface UrgencyInput {
  text: string;
  /** From the check_weather tool / provider data when known. */
  outdoorTempF?: number | null;
}

/** normalizeText() keeps accented letters, but the Spanish rules below are written unaccented ("rompio", "inundacion").
 *  Fold diacritics for matching only, otherwise real transcripts ("se rompió", "calefacción") never match. */
function foldAccents(t: string): string {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function classifyUrgency(input: UrgencyInput): UrgencyVerdict {
  const raw = input.text ?? "";
  const text = foldAccents(normalizeText(raw));
  const flags = new Set<SafetyFlag>();
  const suppressed = new Set<SafetyFlag>();
  const rules: string[] = [];
  let urgent = false;
  let emergency = false;

  if (text) {
    // Keep smoke detectors/alarms (chirping = low battery) from reading as smoke, and fire-adjacent nouns as fire.
    const forFire = text
      .replace(/\bsmoke (?:detector|alarm)s?\b/g, " smokealarmref ")
      .replace(/\bflame (?:sensor|rollout|roll out|detector|arrestor|arrester|switch|rod)s?\b/g, " flamepart ")
      .replace(/\b(?:fireplace|fire place|fire pit|firepit|fire code|fire rated|fire rating|fire inspector|fire marshal|fire wall|firewall|fire sprinklers?|fire department permit)\b/g, " firenoun ");

    for (const r of RULES) {
      const subject = r.id === "fire_words" ? forFire : text;
      const m = r.re.exec(subject);
      if (!m) continue;
      const idx = m.index;
      const matched = m[0];
      if (r.guard) {
        const window = subject.slice(Math.max(0, idx - 40), idx + matched.length + 40);
        if (r.guard.test(window)) { if (r.flag) suppressed.add(r.flag); continue; }
      }
      if (negatedBefore(subject, idx)) { if (r.flag) suppressed.add(r.flag); continue; }
      rules.push(r.id);
      if (r.severity === "emergency") { emergency = true; if (r.flag) flags.add(r.flag); } else urgent = true;
    }

    // ---- composite rules (need two independent facts) ------------------------------------------------------------
    const esNoHeat = /\b(?:sin calefaccion|no tengo calefaccion|no hay calefaccion|calefaccion no funciona|no funciona la calefaccion|no funciona el calefactor|no tengo calor|sin calor)\b/.test(text);
    const heatOut = esNoHeat || near(HEAT, BROKEN, 4).test(text) || /\b(?:no heat|no heating|without heat|heat (?:is )?on but (?:nothing|no)|not getting (?:any )?heat|no warm air|no hot air|only cold air)\b/.test(text);
    if (!flags.has("active_flooding") && /\b(?:cant|cannot|unable to|couldnt|wont|not able to) (?:\S+ ){0,2}(?:turn|shut|stop) (?:it|them|this|that|the flow) off\b/.test(text) && /\b(?:water|leak|leaking|pipe|pouring|spraying|dripping|gushing|valve)\b/.test(text)) {
      emergency = true; flags.add("active_flooding"); rules.push("cant_turn_it_off");
    }
    const coolOut = near(COOL, BROKEN, 4).test(text) || /\b(?:no ac|no a c|no air conditioning|no cooling)\b/.test(text);
    const coldKnown = (typeof input.outdoorTempF === "number" && input.outdoorTempF <= 32) || COLD_WORDS.test(text);
    const hotKnown = (typeof input.outdoorTempF === "number" && input.outdoorTempF >= 95) || HOT_WORDS.test(text);
    const t = /\b(?:thermostat|house|home|inside|indoors|its|temp(?:erature)?)\b(?: \S+){0,4} (?:reads|read|says|shows|at|is|dropped to|down to|hit|reading)(?: about| around)? (\d{2})\b/.exec(text);
    const indoorNumCold = t ? Number(t[1]) <= 55 && Number(t[1]) >= 20 : false;
    const indoorCold = INDOOR_COLD.test(text) || indoorNumCold;
    const indoorHot = INDOOR_HOT.test(text);
    const vulnerable = new RegExp(`\\b(?:${VULN})\\b`).test(text);

    if (heatOut && (coldKnown || indoorCold) && !suppressed.has("no_heat_freezing")) {
      emergency = true; flags.add("no_heat_freezing"); rules.push("no_heat_freezing");
    } else if (heatOut) { urgent = true; rules.push("heat_out"); }
    if (coolOut) { urgent = true; rules.push("cooling_out"); }

    if (vulnerable && (heatOut || coolOut)) {
      const danger = (heatOut && (coldKnown || indoorCold)) || (coolOut && (hotKnown || indoorHot));
      if (danger) { emergency = true; flags.add("vulnerable_occupant_no_climate"); rules.push("vulnerable_no_climate"); }
      else { urgent = true; rules.push("vulnerable_climate_unknown"); }
    }

    // ---- backstop: the existing degraded-mode detector, unless THIS layer saw an explicit negation ---------------
    const fp = detectEmergencyText(raw);
    if (fp.emergency) {
      const map: Record<string, SafetyFlag> = { gas: "gas_odor", co: "carbon_monoxide", fire: "fire_or_smoke", flood: "active_flooding" };
      for (const id of fp.matched) {
        const flag = map[id];
        if (!flag || suppressed.has(flag) || flags.has(flag)) continue;
        // The degraded detector has no notion of detector-battery chirps or fire nouns; defer to our own pre-filter.
        if (id === "fire" && !/\b(?:on fire|caught fire|flames?|house fire|electrical fire|smoke|smoking|burning)\b/.test(forFire)) continue;
        emergency = true; flags.add(flag); rules.push(`fastpath:${id}`);
      }
    }
  }

  const urgency: UrgencyClass = emergency ? "emergency" : urgent ? "urgent" : "routine";
  return { urgency, flags: sortFlags([...flags]), rules, override: emergency };
}

const FLAG_PRIORITY: SafetyFlag[] = [
  "gas_odor", "carbon_monoxide", "fire_or_smoke", "electric_shock", "downed_line", "sparking_or_burning",
  "water_near_electrical", "active_flooding", "sewage_backup", "no_heat_freezing", "vulnerable_occupant_no_climate", "caller_declared_emergency",
];
function sortFlags(f: SafetyFlag[]): SafetyFlag[] {
  return f.sort((a, b) => FLAG_PRIORITY.indexOf(a) - FLAG_PRIORITY.indexOf(b));
}

/** The single most important flag, used to choose what to say first. */
export function primaryFlag(flags: readonly SafetyFlag[]): SafetyFlag | null {
  return sortFlags([...flags])[0] ?? null;
}

/**
 * Spoken instruction for the highest-priority flag. The text lives in ONE place (ontologySeed SAFETY_GUIDANCE ==
 * the `safety_rule` ontology rows), so the words a caller hears always trace to an evidence id.
 */
export function emergencyInstruction(flags: readonly SafetyFlag[]): { flag: SafetyFlag; text: string; evidenceKey: string } | null {
  const flag = primaryFlag(flags);
  if (!flag) return null;
  return { flag, text: SAFETY_GUIDANCE[flag], evidenceKey: flag };
}
