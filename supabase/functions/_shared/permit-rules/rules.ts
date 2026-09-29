// supabase/functions/_shared/permit-rules/rules.ts
//
// Curated, versioned rule library. This is the deterministic backbone of the
// engine: the AI layer can ADD context but can never remove or downgrade
// anything defined here.
//
// Wording principle: local permit law is set by the Authority Having
// Jurisdiction (AHJ) and cannot be known from an address alone, so local
// items say "typically" / "commonly" and always name who to verify with.
// Only genuinely national rules (EPA, OSHA, national codes' existence) are
// marked confidence "high".

import type { Confidence, RequirementCategory, RequirementItem, Severity, WorkType } from "./types.ts";

export const RULES_VERSION = "2027.1";

export interface RuleContext {
  text: string; // lower-cased job text (service type + notes + tags)
  customerType: "residential" | "commercial" | null;
  isEmergency: boolean;
  state: string | null;
  workTypes: WorkType[];
}

type Draft = {
  key: string;
  category: RequirementCategory;
  severity: Severity;
  title: string;
  detail: string;
  authority?: string | null;
  reference?: string | null;
  confidence: Confidence;
};

export interface Rule {
  /** Applies when ANY of these work types is present ("*" = every job). */
  workTypes: WorkType[] | "*";
  scope: "us" | "gb" | "ca" | "any";
  when?: (ctx: RuleContext) => boolean;
  item: Draft | ((ctx: RuleContext) => Draft);
}

const EXCAVATION = /\b(excavat|trench|dig|digging|underground|sewer line|water service|main line|service line|yard|buried)\b/;
const INVASIVE_TEXT = /\b(drywall|wall|ceiling|plaster|paint|soffit|attic access|chase)\b/;
const OLD_MATERIAL = /\b(asbestos|transite|vermiculite|popcorn|old duct|duct wrap|pipe insulation|pipe wrap|9x9|vinyl tile)\b/;
const ROOF = /\b(roof|rooftop|rtu)\b/;

const ELECTRICAL: WorkType[] = ["electrical_service", "electrical_new", "ev_charger", "generator", "electrical_repair"];
const LIVE_EQUIPMENT: WorkType[] = [...ELECTRICAL, "hvac_replace", "hvac_new", "refrigerant", "appliance_repair", "water_heater"];
const GAS_COMBUSTION: WorkType[] = ["gas_work", "water_heater", "hvac_replace", "hvac_new"];
const INVASIVE: WorkType[] = ["ductwork", "plumbing_repipe", "plumbing_drain", "electrical_service", "electrical_new", "hvac_new"];

const permit = (key: string, title: string, detail: string, extra: Partial<Draft> = {}): Draft => ({
  key,
  category: "permit",
  severity: "blocker",
  title,
  detail,
  authority: "Local building department (AHJ)",
  confidence: "medium",
  ...extra,
});

export const RULES: Rule[] = [
  // ---------------------------------------------------------------- US: electrical
  {
    workTypes: ["electrical_service"], scope: "us",
    item: permit("permit.electrical_service", "Electrical permit typically required (panel / service work)",
      "Panel replacement, service upgrades, meter-base and sub-panel work are permitted almost everywhere in the US. Confirm the permit is pulled by the licensed electrician of record BEFORE work starts.",
      { reference: "NFPA 70 (NEC), as adopted locally" }),
  },
  {
    workTypes: ["electrical_service"], scope: "us",
    item: {
      key: "inspection.electrical_service", category: "inspection", severity: "warning",
      title: "Inspection and utility coordination",
      detail: "Expect a rough/final electrical inspection and, for service changes, utility disconnect/reconnect scheduling. Power is often not restored until the inspection passes.",
      authority: "Local AHJ + serving electric utility", reference: null, confidence: "medium",
    },
  },
  {
    workTypes: ["electrical_new"], scope: "us",
    item: permit("permit.electrical_new", "Electrical permit typically required (new circuits / added devices)",
      "Adding circuits, outlets, lighting runs, or rewiring is commonly permitted. Current NEC arc-fault and ground-fault protection rules generally apply to new and extended circuits.",
      { reference: "NFPA 70 (NEC) 210.8 GFCI, 210.12 AFCI" }),
  },
  {
    workTypes: ["ev_charger"], scope: "us",
    item: permit("permit.ev_charger", "EV charger install: permit and load calculation",
      "EVSE installs are typically permitted and inspected. A service load calculation is usually required to confirm the panel can carry the added continuous load; the circuit is dedicated.",
      { reference: "NFPA 70 (NEC) Art. 625 and Art. 220" }),
  },
  {
    workTypes: ["generator"], scope: "us",
    item: permit("permit.generator", "Generator / transfer switch: permit, inspection, utility notice",
      "Standby generator and transfer switch installs typically need an electrical permit, a fuel-gas permit if gas-fired, siting/setback approval, and utility notification. A transfer switch is required to prevent back-feed.",
      { reference: "NFPA 70 (NEC) Art. 702; NFPA 37 / manufacturer clearances" }),
  },
  {
    workTypes: ["electrical_repair"], scope: "us",
    item: {
      key: "permit.electrical_repair_exemption", category: "permit", severity: "info",
      title: "Like-for-like electrical repair is often permit-exempt",
      detail: "Replacing a switch, outlet, fixture or breaker of the same rating is commonly exempt, but a few jurisdictions require a permit for any electrical work. If the scope grows (new circuit, panel change), re-run this review. When replacing receptacles, current code may require GFCI/AFCI protection.",
      authority: "Local AHJ", reference: "NFPA 70 (NEC) 406.4(D)", confidence: "medium",
    },
  },
  // ---------------------------------------------------------------- US: plumbing / gas
  {
    workTypes: ["water_heater"], scope: "us",
    item: permit("permit.water_heater", "Water heater replacement: permit typically required",
      "Most jurisdictions permit water heater replacements, including like-for-like. Inspectors commonly check the T&P relief discharge, venting/combustion air (gas), expansion tank where required, and shut-off valve.",
      { reference: "Local plumbing/mechanical code (IPC/UPC, IFGC)" }),
  },
  {
    workTypes: ["plumbing_repipe"], scope: "us",
    item: permit("permit.plumbing_repipe", "Repipe / water service work: permit and inspection",
      "Whole-house repipes and water service line work are nearly always permitted and inspected (pressure test before walls are closed). Materials must be lead-free.",
      { reference: "Safe Drinking Water Act s.1417 (lead-free); local plumbing code" }),
  },
  {
    workTypes: ["plumbing_drain"], scope: "us",
    item: permit("permit.plumbing_drain", "Drain / sewer line work: permit and inspection",
      "Sewer and building-drain repairs or replacements are typically permitted, and some municipalities also require a right-of-way permit for work near the street or a licensed sewer contractor.",
      { reference: "Local plumbing code; municipal sewer ordinance" }),
  },
  {
    workTypes: ["plumbing_fixture"], scope: "us",
    item: {
      key: "permit.plumbing_fixture_exemption", category: "permit", severity: "info",
      title: "Like-for-like fixture swaps are often permit-exempt",
      detail: "Faucets, toilets and disposals replaced in the same location are commonly exempt. Relocating supply/drain lines or adding fixtures normally is not.",
      authority: "Local AHJ", reference: null, confidence: "medium",
    },
  },
  {
    workTypes: ["gas_work"], scope: "us",
    item: permit("permit.gas_work", "Gas piping / appliance work: permit and pressure test",
      "Gas line extensions, appliance hookups and repairs to piping are typically permitted and require a documented leak/pressure test before the gas is turned on. Some jurisdictions require a licensed gas fitter specifically.",
      { reference: "NFPA 54 / ANSI Z223.1 (National Fuel Gas Code)", authority: "Local AHJ / gas utility" }),
  },
  {
    workTypes: GAS_COMBUSTION, scope: "us",
    item: {
      key: "safety.combustion_air_venting", category: "safety", severity: "warning",
      title: "Verify combustion air, venting and CO safety",
      detail: "Confirm adequate combustion air, correct vent sizing/termination and a working CO alarm before leaving. Backdrafting and CO are the most serious hazards on fuel-burning replacements.",
      authority: null, reference: "NFPA 54; IFGC; manufacturer instructions", confidence: "high",
    },
  },
  {
    workTypes: ["gas_work"], scope: "us",
    item: {
      key: "safety.gas_leak_test", category: "safety", severity: "blocker",
      title: "Leak test before restoring gas",
      detail: "Perform and record a leak check on every joint disturbed. Do not leave gas on to an appliance that has not passed a leak test.",
      authority: null, reference: "NFPA 54", confidence: "high",
    },
  },
  // ---------------------------------------------------------------- US: HVAC
  {
    workTypes: ["hvac_replace", "hvac_new"], scope: "us",
    item: permit("permit.hvac", "HVAC replacement / new system: mechanical permit typically required",
      "Furnace, AC, heat-pump, air-handler and mini-split installs are commonly permitted, with a final inspection. Many jurisdictions require a load calculation (Manual J) and correct equipment sizing (Manual S). Energy-code duct testing may apply.",
      { reference: "IRC M1401.3 / IMC, IECC; ACCA Manual J & S" }),
  },
  {
    workTypes: ["hvac_replace", "hvac_new"], scope: "us",
    item: {
      key: "regulation.refrigerant_transition", category: "regulation", severity: "warning",
      title: "Refrigerant transition rules apply to new equipment",
      detail: "EPA rules restrict which refrigerants may be used in newly installed systems and set dates for equipment made or installed with older refrigerants. Confirm the equipment and refrigerant are compliant for the install date.",
      authority: "U.S. EPA (AIM Act)", reference: "40 CFR Part 84 (Technology Transitions)", confidence: "high",
    },
  },
  {
    workTypes: ["ductwork"], scope: "us",
    item: permit("permit.ductwork", "Ductwork modification: permit possible; leakage testing",
      "Duct replacement or major alteration is often permitted, and the energy code frequently requires duct-leakage testing and minimum insulation.",
      { severity: "warning", reference: "IECC R403.3 (duct sealing/testing)" }),
  },
  {
    workTypes: ["refrigerant", "hvac_replace", "hvac_new", "appliance_repair"], scope: "us",
    when: (c) => c.workTypes.includes("refrigerant") || c.workTypes.includes("hvac_replace") || c.workTypes.includes("hvac_new") || /\b(refrigerant|freon|compressor|sealed system|evaporator|condenser coil|line set|recharge|r-?410a|r-?22)\b/.test(c.text),
    item: {
      key: "licensing.epa_608", category: "licensing", severity: "blocker",
      title: "EPA Section 608 certification required for refrigerant work",
      detail: "Only an EPA 608-certified technician may open a refrigerant circuit or purchase/handle regulated refrigerant. Venting is prohibited; recovery and leak-repair rules apply. Confirm the assigned technician's certification is current.",
      authority: "U.S. EPA", reference: "40 CFR Part 82, Subpart F", confidence: "high",
    },
  },
  {
    workTypes: ["refrigerant"], scope: "us",
    when: (c) => c.customerType === "commercial",
    item: {
      key: "regulation.refrigerant_leak_records", category: "regulation", severity: "warning",
      title: "Commercial refrigeration: leak-rate records may apply",
      detail: "Appliances with 50 lb or more of a regulated refrigerant charge carry leak-rate calculation, repair-deadline and record-keeping duties. Log the charge added and the leak repair.",
      authority: "U.S. EPA", reference: "40 CFR 82.157", confidence: "high",
    },
  },
  // ---------------------------------------------------------------- US: safety (OSHA / environmental)
  {
    workTypes: LIVE_EQUIPMENT, scope: "us",
    item: {
      key: "safety.lockout_tagout", category: "safety", severity: "warning",
      title: "De-energize and lock out before servicing",
      detail: "Isolate electrical/fuel sources, lock out and tag, and verify zero energy before opening equipment. Use appropriate PPE and never work energized panels unless trained and permitted under electrical-safe-work practices.",
      authority: "OSHA", reference: "OSHA 29 CFR 1910.147; NFPA 70E", confidence: "high",
    },
  },
  {
    workTypes: ["plumbing_drain", "plumbing_repipe", "gas_work", "generator", "hvac_new"], scope: "us",
    when: (c) => EXCAVATION.test(c.text) || c.workTypes.includes("plumbing_drain"),
    item: (c) => ({
      key: "safety.call_811", category: "safety",
      severity: EXCAVATION.test(c.text) ? "blocker" : "warning",
      title: "Call 811 before any digging",
      detail: "Utility locate is required before excavation. Schedule it in advance of the visit (typically a few working days). For trenches 5 ft or deeper, a protective system and a competent person are required.",
      authority: "811 / state one-call center; OSHA", reference: "State one-call (damage-prevention) laws; OSHA 29 CFR 1926 Subpart P", confidence: "high",
    }),
  },
  {
    workTypes: INVASIVE, scope: "us",
    when: (c) => INVASIVE_TEXT.test(c.text) || c.workTypes.some((w) => INVASIVE.includes(w)),
    item: {
      key: "regulation.lead_rrp", category: "regulation", severity: "warning",
      title: "Pre-1978 home? Lead-safe work rules may apply",
      detail: "If the home or child-occupied space was built before 1978 and the work disturbs more than 6 sq ft of interior (20 sq ft exterior) painted surface, an EPA lead-safe certified firm and certified renovator are required, with lead-safe work practices and records. Confirm the build year.",
      authority: "U.S. EPA", reference: "40 CFR Part 745, Subpart E (RRP Rule)", confidence: "high",
    },
  },
  {
    workTypes: ["ductwork", "plumbing_repipe", "plumbing_drain", "hvac_replace", "water_heater"], scope: "us",
    when: (c) => OLD_MATERIAL.test(c.text),
    item: {
      key: "regulation.asbestos", category: "regulation", severity: "warning",
      title: "Possible asbestos-containing material: stop and assess first",
      detail: "Old pipe/duct wrap, transite, vermiculite and some flooring can contain asbestos. Do not disturb suspect material; get it tested and follow abatement rules before proceeding.",
      authority: "U.S. EPA / state environmental agency; OSHA", reference: "40 CFR Part 61 Subpart M (NESHAP); OSHA 29 CFR 1926.1101", confidence: "high",
    },
  },
  {
    workTypes: ["hvac_replace", "hvac_new", "refrigerant", "maintenance"], scope: "us",
    when: (c) => ROOF.test(c.text),
    item: {
      key: "safety.roof_fall_protection", category: "safety", severity: "warning",
      title: "Rooftop work: fall protection required",
      detail: "Rooftop units and roof access require fall protection at 6 ft or more above a lower level for construction work, plus safe ladder access and roof-edge controls.",
      authority: "OSHA", reference: "OSHA 29 CFR 1926.501(b)", confidence: "high",
    },
  },
  // ---------------------------------------------------------------- US: appliance / maintenance
  {
    workTypes: ["appliance_repair", "maintenance"], scope: "us",
    item: {
      key: "permit.routine_service_exemption", category: "permit", severity: "info",
      title: "Routine repair / maintenance normally needs no permit",
      detail: "Diagnostics, tune-ups and like-for-like appliance repairs are generally permit-exempt. Re-run this review if the scope turns into replacement or new installation.",
      authority: "Local AHJ", reference: null, confidence: "medium",
    },
  },
  // ---------------------------------------------------------------- universal (any country)
  {
    workTypes: ["electrical_service", "electrical_new", "ev_charger", "generator", "water_heater", "plumbing_repipe", "plumbing_drain", "gas_work", "hvac_replace", "hvac_new", "ductwork"],
    scope: "any",
    item: {
      key: "licensing.contractor_of_record", category: "licensing", severity: "warning",
      title: "Confirm licensed contractor / technician of record",
      detail: "Permitted work must be performed under the right trade license and insurance. Confirm the assigned technician or company holds the required license for this trade and jurisdiction, and that it is current.",
      authority: "State / provincial licensing board", reference: null, confidence: "medium",
    },
  },
  {
    workTypes: "*", scope: "any",
    when: (c) => c.customerType === "commercial",
    item: {
      key: "documentation.commercial_access_coi", category: "documentation", severity: "warning",
      title: "Commercial site: insurance certificate and access approval",
      detail: "Commercial properties commonly require a certificate of insurance, a signed work authorization from the owner/property manager, and access or after-hours approval. Commercial permit scopes can also be broader (fire, hood, life-safety).",
      authority: "Property owner / manager", reference: null, confidence: "medium",
    },
  },
  {
    workTypes: "*", scope: "any",
    when: (c) => c.isEmergency,
    item: {
      key: "permit.emergency_work", category: "permit", severity: "info",
      title: "Emergency work: retroactive permit rules",
      detail: "Many jurisdictions allow genuine emergency repairs to start first and require the permit application within a short window (often 1-3 business days). Rules vary - document the emergency (photos, notes) and file promptly.",
      authority: "Local AHJ", reference: null, confidence: "medium",
    },
  },
  {
    workTypes: ["electrical_service", "electrical_new", "ev_charger", "generator", "water_heater", "plumbing_repipe", "plumbing_drain", "gas_work", "hvac_replace", "hvac_new", "ductwork"],
    scope: "any",
    item: {
      key: "documentation.permit_records", category: "documentation", severity: "info",
      title: "Record permit number and keep sign-offs",
      detail: "Record the permit number on this job, keep the permit available on site, and attach the final inspection sign-off / commissioning record. These are your proof of compliance for the customer, insurer and any future audit.",
      authority: null, reference: null, confidence: "high",
    },
  },
  // ---------------------------------------------------------------- United Kingdom
  {
    workTypes: ["gas_work", "water_heater", "hvac_replace", "hvac_new"], scope: "gb",
    when: (c) => c.workTypes.includes("gas_work") || /\b(gas|boiler|combi)\b/.test(c.text),
    item: {
      key: "gb.gas_safe", category: "licensing", severity: "blocker",
      title: "Gas Safe registration required for gas work",
      detail: "It is a legal requirement that gas work is carried out by a Gas Safe registered engineer competent for the appliance type. Record the engineer's Gas Safe number and issue the required safety records.",
      authority: "Gas Safe Register", reference: "Gas Safety (Installation and Use) Regulations 1998", confidence: "high",
    },
  },
  {
    workTypes: ["electrical_service", "electrical_new", "ev_charger", "generator"], scope: "gb",
    item: {
      key: "gb.part_p", category: "permit", severity: "blocker",
      title: "Notifiable electrical work: Building Regulations Part P (England & Wales)",
      detail: "Notifiable domestic electrical work must be notified to building control or carried out by a registered competent person, with an Electrical Installation Certificate issued. Scotland and Northern Ireland have separate regimes.",
      authority: "Local building control / competent-person scheme", reference: "Building Regulations Part P; BS 7671", confidence: "high",
    },
  },
  {
    workTypes: ["refrigerant", "hvac_replace", "hvac_new"], scope: "gb",
    item: {
      key: "gb.fgas", category: "licensing", severity: "blocker",
      title: "F-Gas certification required for refrigerant work",
      detail: "Handling fluorinated refrigerants requires an F-Gas certified company and engineer, with leak-check and record-keeping duties.",
      authority: "Environment Agency / certification body", reference: "UK F-Gas Regulation", confidence: "high",
    },
  },
  // ---------------------------------------------------------------- Canada
  {
    workTypes: ["electrical_service", "electrical_new", "ev_charger", "generator", "gas_work", "water_heater", "hvac_replace", "hvac_new", "plumbing_repipe", "plumbing_drain"],
    scope: "ca",
    item: {
      key: "ca.provincial_permit", category: "permit", severity: "blocker",
      title: "Provincial trade licence and permit typically required",
      detail: "Electrical, gas and plumbing trades are regulated by the province or territory. Work is typically permitted through the provincial safety authority or municipality and performed by a licensed contractor. Verify which authority applies.",
      authority: "Provincial safety authority (e.g. ESA, TSSA, Technical Safety BC) / municipality",
      reference: "CSA C22.1 (Canadian Electrical Code); CSA B149.1 (gas)", confidence: "medium",
    },
  },
];

// ---------------------------------------------------------------------------
// State layer (US). Only authorities and notes we are confident in.
// ---------------------------------------------------------------------------

export interface StateNote {
  licensing: string;
  notes?: { key: string; when: WorkType[]; title: string; detail: string; reference?: string }[];
}

export const STATE_NOTES: Record<string, StateNote> = {
  CA: {
    licensing: "California Contractors State License Board (CSLB)",
    notes: [
      { key: "state.ca.title24", when: ["hvac_replace", "hvac_new", "ductwork"], title: "California Title 24: permit and verification for HVAC alterations",
        detail: "HVAC replacements and duct alterations generally need a permit and Title 24 energy compliance documentation, and some measures require third-party HERS verification.", reference: "CA Energy Code (Title 24, Part 6)" },
      { key: "state.ca.wh_strapping", when: ["water_heater"], title: "California: water heater must be braced/anchored",
        detail: "California plumbing code requires water heaters to be anchored or strapped against seismic movement.", reference: "California Plumbing Code (CPC) 507.2" },
    ],
  },
  TX: { licensing: "Texas Dept. of Licensing and Regulation (TDLR) for HVAC and electrical; Texas State Board of Plumbing Examiners (TSBPE) for plumbing" },
  FL: {
    licensing: "Florida DBPR - Construction Industry Licensing Board",
    notes: [
      { key: "state.fl.wind", when: ["generator", "hvac_replace", "hvac_new"], title: "Florida: outdoor equipment wind-load anchoring",
        detail: "The Florida Building Code sets tie-down/anchoring requirements for outdoor equipment such as condensers and generators, and product approvals may apply. Confirm with the local building department.", reference: "Florida Building Code" },
    ],
  },
  NY: { licensing: "Licensing is largely local in New York - NYC requires DOB-licensed master plumbers/electricians and DOB filings; elsewhere verify county/municipal licensing" },
  WA: { licensing: "Washington Dept. of Labor & Industries (L&I) - electrical work requires a state-licensed electrician and electrical permit; plumbers and contractors are also L&I-licensed" },
  AZ: { licensing: "Arizona Registrar of Contractors (ROC)" },
  NV: { licensing: "Nevada State Contractors Board" },
  CO: { licensing: "Colorado DORA - State Electrical Board and State Plumbing Board" },
  MA: { licensing: "Massachusetts Division of Professional Licensure - Boards of State Examiners of Electricians and of Plumbers & Gas Fitters" },
  NJ: { licensing: "New Jersey Division of Consumer Affairs (trade licensing boards) and local construction offices" },
  IL: { licensing: "Illinois - plumbers licensed by IDPH; electricians commonly licensed locally (e.g. Chicago). Verify municipal requirements" },
  GA: { licensing: "Georgia Secretary of State - Construction Industry Licensing Boards" },
  NC: { licensing: "North Carolina State Licensing Boards (Electrical, Plumbing/Heating/Fire Sprinkler, General Contractors)" },
  PA: { licensing: "Pennsylvania has no statewide trade license for most trades - verify municipal licensing; contractors must hold Home Improvement Contractor registration (Attorney General)" },
  OH: { licensing: "Ohio Construction Industry Licensing Board (OCILB) for HVAC, electrical, plumbing, refrigeration, hydronics" },
  MI: { licensing: "Michigan LARA - Bureau of Construction Codes" },
  VA: { licensing: "Virginia DPOR - Board for Contractors" },
  OR: { licensing: "Oregon Construction Contractors Board (CCB) and Building Codes Division" },
};

export function stateRulesFor(state: string | null, workTypes: WorkType[]): RequirementItem[] {
  if (!state) return [];
  const entry = STATE_NOTES[state];
  if (!entry) return [];
  const items: RequirementItem[] = [];
  const regulated = workTypes.some((w) => w !== "maintenance" && w !== "appliance_repair" && w !== "plumbing_fixture" && w !== "electrical_repair");
  if (regulated) {
    items.push({
      key: `state.${state.toLowerCase()}.licensing`,
      category: "licensing",
      severity: "warning",
      title: `${state}: verify trade licensing`,
      detail: `Confirm the assigned technician/company holds the correct licence for this work. Authority: ${entry.licensing}.`,
      authority: entry.licensing,
      reference: null,
      confidence: "medium",
      source: "rule",
    });
  }
  for (const n of entry.notes ?? []) {
    if (!n.when.some((w) => workTypes.includes(w))) continue;
    items.push({
      key: n.key, category: "regulation", severity: "warning", title: n.title, detail: n.detail,
      authority: entry.licensing, reference: n.reference ?? null, confidence: "medium", source: "rule",
    });
  }
  return items;
}
