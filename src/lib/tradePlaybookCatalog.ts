/**
 * Trade Playbook catalog — curated, versioned operating knowledge per vertical.
 *
 * Content only (no I/O). Shipping a new trade or improving one is a code change
 * plus a `catalogVersion` bump, same philosophy as workflowPlaybooks.ts.
 *
 * All money is integer cents in a USD-like baseline. Tenants apply a price
 * multiplier at install time; nothing here overrides what a tenant already owns.
 * Guidance is general good practice — the technician's judgment, local code and
 * licensing always take precedence (the UI states this).
 */

import type { PricingModel } from '@/lib/priceBook';

export type TradeSlug = 'hvac' | 'plumbing' | 'electrical';

export interface ChecklistItem {
  id: string;
  label: string;
  /** Skipping this is a known callback / safety risk. */
  critical?: boolean;
}

export interface RootCause {
  key: string;
  label: string;
  likelihood: 'common' | 'occasional' | 'rare';
  test: string;
  fix: string;
  parts: string[];
}

export interface Troubleshooting {
  symptom: string;
  safety: string;
  causes: RootCause[];
}

export interface JobTypeBenchmark {
  ticketMinCents: number;
  ticketMaxCents: number;
  durationMinutes: number;
  firstTimeFixPct: number;
  /** Ceiling: callback rate above this is a quality problem. */
  maxCallbackPct: number;
  targetMarginPct: number;
}

export interface PriceSeed {
  serviceName: string;
  category: string;
  pricingModel: PricingModel;
  priceCents: number;
  priceMaxCents?: number;
  keywords: string[];
  description: string;
  estimatedCostCents: number;
}

export interface TradeJobType {
  key: string;
  label: string;
  /** Lower-case fragments matched against jobs.service_type. */
  match: string[];
  checklist: ChecklistItem[];
  troubleshooting?: Troubleshooting;
  benchmark: JobTypeBenchmark;
  price: PriceSeed;
}

export interface TradePlaybook {
  slug: TradeSlug;
  name: string;
  tagline: string;
  catalogVersion: number;
  jobTypes: TradeJobType[];
  /** Slugs from WORKFLOW_PLAYBOOKS recommended for this trade. */
  workflowSlugs: string[];
  /** Urgency / dispatch rules the AI and dispatchers should follow. */
  dispatchNotes: string[];
}

const c = (id: string, label: string, critical = false): ChecklistItem => ({ id, label, ...(critical ? { critical } : {}) });

export const TRADE_PLAYBOOKS: TradePlaybook[] = [
  /* ============================== HVAC ============================== */
  {
    slug: 'hvac',
    name: 'HVAC',
    tagline: 'Cooling, heating, tune-ups and system replacement — with diagnostics that reduce callbacks.',
    catalogVersion: 1,
    workflowSlugs: ['missed-call-text-back', 'speed-to-lead-60s', 'quote-follow-up-close', 'membership-welcome', 'membership-visit-reminder', 'post-job-review-request'],
    dispatchNotes: [
      'Gas smell, carbon monoxide alarm or burning smell: tell the caller to leave the building and call the gas utility or emergency services first, then dispatch as priority one.',
      'No heat below freezing or no cooling above 95°F (35°C) with elderly, infants or medical needs in the home: same-day priority.',
      'Water leaking from an air handler or ice on the line set: advise turning the system off at the thermostat while waiting.',
    ],
    jobTypes: [
      {
        key: 'ac-no-cooling',
        label: 'AC not cooling',
        match: [' ac ', 'a/c', 'air condition', 'cooling', 'no cool', 'compressor', 'condenser', 'refrigerant', 'freon'],
        benchmark: { ticketMinCents: 28000, ticketMaxCents: 65000, durationMinutes: 90, firstTimeFixPct: 78, maxCallbackPct: 6, targetMarginPct: 50 },
        price: { serviceName: 'AC Repair (diagnostic + typical repair)', category: 'HVAC Repair', pricingModel: 'range', priceCents: 24900, priceMaxCents: 64900, keywords: ['ac not cooling', 'air conditioner broken', 'no cold air', 'ac repair'], description: 'Diagnostic, capacitor/contactor-level repairs and drain clearing. Refrigerant leaks and compressor work are quoted separately.', estimatedCostCents: 12500 },
        checklist: [
          c('lockout', 'Disconnect power and lock out before opening any panel', true),
          c('thermostat', 'Confirm thermostat mode, setpoint and power'),
          c('airflow', 'Check filter and record supply/return temperature split'),
          c('capacitor', 'Test run capacitor µF against the nameplate', true),
          c('contactor', 'Inspect contactor contacts and coil voltage'),
          c('refrigerant', 'Record superheat and subcooling before adding refrigerant', true),
          c('drain', 'Inspect condensate line, pan and float switch'),
          c('photos', 'Photograph data plate, findings and the finished repair'),
        ],
        troubleshooting: {
          symptom: 'AC runs but does not cool, or does not run at all',
          safety: 'Lock out power and discharge capacitors before testing. Never bypass safety switches.',
          causes: [
            { key: 'airflow-restriction', label: 'Restricted airflow (filter or evaporator coil)', likelihood: 'common', test: 'Check filter, measure static pressure and temperature split, look for coil icing.', fix: 'Replace filter, clean coil, correct blower speed.', parts: ['Air filter', 'Coil cleaner'] },
            { key: 'failed-capacitor', label: 'Failed run capacitor', likelihood: 'common', test: 'Measure µF against the nameplate (tolerance about ±6%).', fix: 'Replace with matching µF and voltage rating.', parts: ['Run capacitor'] },
            { key: 'worn-contactor', label: 'Worn contactor or relay', likelihood: 'common', test: 'Inspect for pitting; verify coil voltage and contact continuity.', fix: 'Replace the contactor.', parts: ['Contactor'] },
            { key: 'condensate-lockout', label: 'Clogged condensate line / tripped float switch', likelihood: 'common', test: 'Inspect drain pan and float switch; check for standing water.', fix: 'Clear and flush the line; recommend a cleanout.', parts: ['Float switch', 'Condensate tablets'] },
            { key: 'low-refrigerant', label: 'Low refrigerant (leak)', likelihood: 'occasional', test: 'Measure superheat/subcooling; perform a leak search.', fix: 'Repair the leak, recharge to spec; present repair-vs-replace options.', parts: ['Refrigerant', 'Schrader cores'] },
            { key: 'compressor-failure', label: 'Compressor failure', likelihood: 'rare', test: 'Check amp draw, winding resistance and start components first.', fix: 'Present compressor vs system replacement options.', parts: ['Compressor'] },
          ],
        },
      },
      {
        key: 'furnace-no-heat',
        label: 'Furnace / no heat',
        match: ['furnace', 'no heat', 'heater', 'heating', 'pilot', 'ignitor', 'igniter', 'boiler'],
        benchmark: { ticketMinCents: 26000, ticketMaxCents: 60000, durationMinutes: 90, firstTimeFixPct: 76, maxCallbackPct: 6, targetMarginPct: 50 },
        price: { serviceName: 'Furnace Repair (diagnostic + typical repair)', category: 'HVAC Repair', pricingModel: 'range', priceCents: 22900, priceMaxCents: 59900, keywords: ['no heat', 'furnace not working', 'heater broken', 'furnace repair'], description: 'Diagnostic and common ignition, sensor and control repairs. Heat exchanger findings are quoted separately.', estimatedCostCents: 11500 },
        checklist: [
          c('gas-co', 'Check for gas odor and test for CO before and after service', true),
          c('lockout', 'Isolate power and gas before opening the cabinet', true),
          c('thermostat', 'Confirm thermostat call for heat and power'),
          c('filter', 'Inspect filter and airflow'),
          c('ignition', 'Observe the full ignition sequence and error codes'),
          c('flame-sensor', 'Clean and test flame sensor microamps'),
          c('venting', 'Inspect venting, pressure switch and inducer'),
          c('photos', 'Photograph data plate, error codes and completed work'),
        ],
        troubleshooting: {
          symptom: 'No heat, furnace short-cycles or fails to ignite',
          safety: 'If gas odor is present, stop work, ventilate and evacuate. Test CO before and after.',
          causes: [
            { key: 'ignitor-failure', label: 'Failed hot-surface ignitor', likelihood: 'common', test: 'Check ignitor resistance and glow during the sequence.', fix: 'Replace the ignitor (do not touch the element).', parts: ['Hot-surface ignitor'] },
            { key: 'dirty-flame-sensor', label: 'Dirty flame sensor', likelihood: 'common', test: 'Measure flame sensor microamps; inspect for oxidation.', fix: 'Clean or replace the sensor.', parts: ['Flame sensor'] },
            { key: 'pressure-switch-inducer', label: 'Pressure switch / inducer fault', likelihood: 'occasional', test: 'Check inducer operation, hoses and switch closure with a manometer.', fix: 'Clear blockage or replace switch/inducer motor.', parts: ['Pressure switch', 'Inducer motor'] },
            { key: 'airflow-limit-trip', label: 'Clogged filter tripping the high-limit', likelihood: 'common', test: 'Inspect filter and blower; check limit switch history.', fix: 'Replace filter, verify blower; replace limit if faulty.', parts: ['Air filter', 'High-limit switch'] },
            { key: 'control-board', label: 'Control board / thermostat fault', likelihood: 'rare', test: 'Verify 24V at the board and thermostat wiring.', fix: 'Replace the board or thermostat.', parts: ['Control board', 'Thermostat'] },
          ],
        },
      },
      {
        key: 'maintenance-tuneup',
        label: 'Seasonal tune-up',
        match: ['tune', 'maintenance', 'inspection', 'seasonal', 'checkup', 'check-up'],
        benchmark: { ticketMinCents: 12900, ticketMaxCents: 24900, durationMinutes: 60, firstTimeFixPct: 97, maxCallbackPct: 2, targetMarginPct: 55 },
        price: { serviceName: 'HVAC Tune-Up (multi-point inspection)', category: 'HVAC Maintenance', pricingModel: 'flat', priceCents: 14900, keywords: ['tune up', 'maintenance', 'annual service', 'seasonal check'], description: 'Full multi-point inspection and cleaning of one system, with a written condition report.', estimatedCostCents: 6500 },
        checklist: [
          c('safeties', 'Test safety controls and shut-offs', true),
          c('electrical', 'Tighten electrical connections; test capacitor and contactor'),
          c('coils', 'Inspect and clean coils'),
          c('airflow', 'Replace or check filter; measure temperature split'),
          c('drain', 'Flush condensate line'),
          c('combustion', 'Test combustion and CO (gas systems)', true),
          c('report', 'Give the customer a condition report with photos'),
          c('membership', 'Offer a maintenance membership'),
        ],
      },
      {
        key: 'system-replacement',
        label: 'System replacement estimate',
        match: ['replace', 'replacement', 'new system', 'new unit', 'install', 'upgrade', 'second opinion'],
        benchmark: { ticketMinCents: 650000, ticketMaxCents: 1400000, durationMinutes: 480, firstTimeFixPct: 95, maxCallbackPct: 3, targetMarginPct: 38 },
        price: { serviceName: 'System Replacement (installed, starting at)', category: 'HVAC Install', pricingModel: 'starting_at', priceCents: 690000, keywords: ['new ac', 'new furnace', 'replace system', 'new hvac'], description: 'Complete replacement with permit, startup and warranty registration. Final price depends on size, efficiency and ductwork.', estimatedCostCents: 420000 },
        checklist: [
          c('load-calc', 'Perform a load calculation (do not size by replacement)', true),
          c('ductwork', 'Inspect ductwork and static pressure'),
          c('options', 'Present good / better / best options with financing'),
          c('permit', 'Confirm permit and code requirements', true),
          c('startup', 'Complete startup and commissioning checklist', true),
          c('registration', 'Register manufacturer warranty'),
          c('photos', 'Photograph before / after and data plates'),
        ],
      },
    ],
  },

  /* ============================= PLUMBING ============================= */
  {
    slug: 'plumbing',
    name: 'Plumbing',
    tagline: 'Drains, water heaters, leaks and fixtures — with diagnostics that reduce callbacks.',
    catalogVersion: 1,
    workflowSlugs: ['missed-call-text-back', 'speed-to-lead-60s', 'quote-follow-up-close', 'quote-declined-winback', 'post-job-review-request'],
    dispatchNotes: [
      'Active leak, burst pipe or sewage backup: tell the caller to shut off the main water valve, and dispatch as priority one.',
      'Gas smell near a water heater: tell the caller to leave the building and call the gas utility first.',
      'No hot water only: schedule within 24 hours; escalate if there are infants, elderly or medical needs.',
    ],
    jobTypes: [
      {
        key: 'drain-clog',
        label: 'Clogged drain',
        match: ['drain', 'clog', 'blocked', 'backup', 'slow drain', 'snake', 'sewer'],
        benchmark: { ticketMinCents: 17500, ticketMaxCents: 42500, durationMinutes: 75, firstTimeFixPct: 88, maxCallbackPct: 5, targetMarginPct: 58 },
        price: { serviceName: 'Drain Clearing', category: 'Drains', pricingModel: 'range', priceCents: 17500, priceMaxCents: 42500, keywords: ['clogged drain', 'slow drain', 'sewer backup', 'blocked sink'], description: 'Clearing a single fixture or branch line. Main-line and camera work are quoted separately.', estimatedCostCents: 7000 },
        checklist: [
          c('isolate', 'Run other fixtures to isolate fixture vs branch vs main line', true),
          c('ppe', 'Use PPE and protect floors'),
          c('clear', 'Clear the blockage with the appropriate tool'),
          c('flow', 'Verify full flow with sustained running water', true),
          c('camera', 'Camera-inspect after clearing if the line has recurred'),
          c('advice', 'Advise the customer on prevention (no grease or wipes)'),
          c('photos', 'Photograph the blockage and the cleanout access'),
        ],
        troubleshooting: {
          symptom: 'Slow or fully blocked drain, gurgling or backup',
          safety: 'Never mix chemical drain cleaners. Treat sewage as a biohazard; use PPE.',
          causes: [
            { key: 'trap-buildup', label: 'Hair / soap / debris in trap or branch', likelihood: 'common', test: 'Isolate to a single fixture; inspect the trap and arm.', fix: 'Remove the trap debris and cable the branch.', parts: ['P-trap kit'] },
            { key: 'grease-buildup', label: 'Grease buildup (kitchen line)', likelihood: 'common', test: 'Inspect residue; assess with a cable or camera.', fix: 'Cable or hydro-jet; advise on prevention.', parts: [] },
            { key: 'root-intrusion', label: 'Tree-root intrusion in the main line', likelihood: 'occasional', test: 'Multiple fixtures affected; confirm with a camera.', fix: 'Cut roots and recommend a scheduled maintenance or repair.', parts: [] },
            { key: 'foreign-object', label: 'Foreign object (toys, wipes)', likelihood: 'occasional', test: 'Retrieve with a cable retriever or pull the toilet.', fix: 'Retrieve the object and reset the fixture.', parts: ['Wax ring'] },
            { key: 'collapsed-line', label: 'Bellied or collapsed line', likelihood: 'rare', test: 'Camera shows standing water or a break.', fix: 'Quote a spot repair or line replacement.', parts: [] },
          ],
        },
      },
      {
        key: 'water-heater',
        label: 'Water heater',
        match: ['water heater', 'hot water', 'no hot', 'tank', 'tankless', 'anode'],
        benchmark: { ticketMinCents: 19900, ticketMaxCents: 52900, durationMinutes: 105, firstTimeFixPct: 80, maxCallbackPct: 5, targetMarginPct: 52 },
        price: { serviceName: 'Water Heater Repair', category: 'Water Heaters', pricingModel: 'range', priceCents: 19900, priceMaxCents: 52900, keywords: ['no hot water', 'water heater broken', 'water heater leaking'], description: 'Diagnostic and common element, thermostat, thermocouple and valve repairs. Replacement is quoted separately.', estimatedCostCents: 9500 },
        checklist: [
          c('shutoff', 'Shut off gas / power and water before opening the unit', true),
          c('gas-co', 'Check for gas odor and combustion venting (gas units)', true),
          c('tp-valve', 'Test the T&P valve and confirm the discharge line', true),
          c('temp', 'Set and verify outlet temperature'),
          c('flush', 'Flush sediment if appropriate'),
          c('age', 'Record model, serial and manufacture date'),
          c('options', 'Present repair vs replace options if the tank is past its service life'),
        ],
        troubleshooting: {
          symptom: 'No hot water, lukewarm water, or water heater leaking',
          safety: 'Shut off gas or power and water before opening. Any tank leak means the tank has failed.',
          causes: [
            { key: 'heating-element', label: 'Failed heating element / thermostat (electric)', likelihood: 'common', test: 'Check element resistance and thermostat continuity with power off.', fix: 'Replace the element or thermostat.', parts: ['Heating element', 'Thermostat'] },
            { key: 'thermocouple-burner', label: 'Faulty thermocouple / burner (gas)', likelihood: 'common', test: 'Test pilot, thermocouple millivolts and burner.', fix: 'Replace the thermocouple or clean the burner assembly.', parts: ['Thermocouple', 'Gas control valve'] },
            { key: 'sediment', label: 'Sediment buildup', likelihood: 'occasional', test: 'Listen for rumbling; drain a sample.', fix: 'Flush the tank; advise annual flushing.', parts: [] },
            { key: 'tp-valve-leak', label: 'Leaking T&P valve or connection', likelihood: 'occasional', test: 'Check discharge line, pressure and thermal expansion.', fix: 'Replace the valve; consider an expansion tank.', parts: ['T&P valve', 'Expansion tank'] },
            { key: 'tank-failure', label: 'Tank corrosion failure', likelihood: 'occasional', test: 'Leak from the tank body itself.', fix: 'Present replacement options.', parts: ['Water heater'] },
          ],
        },
      },
      {
        key: 'leak-repair',
        label: 'Leak repair',
        match: ['leak', 'burst', 'drip', 'pipe', 'water damage', 'shutoff', 'shut-off'],
        benchmark: { ticketMinCents: 24900, ticketMaxCents: 79900, durationMinutes: 120, firstTimeFixPct: 82, maxCallbackPct: 7, targetMarginPct: 52 },
        price: { serviceName: 'Leak Repair', category: 'Repairs', pricingModel: 'range', priceCents: 24900, priceMaxCents: 79900, keywords: ['leaking pipe', 'burst pipe', 'dripping', 'water leak'], description: 'Locating and repairing accessible supply or drain leaks. Concealed or in-wall access is quoted separately.', estimatedCostCents: 11000 },
        checklist: [
          c('shutoff', 'Shut off water and confirm the source of the leak', true),
          c('electrical', 'Check for electrical hazards near water', true),
          c('pressure', 'Measure static water pressure'),
          c('repair', 'Repair with the correct fitting and pipe material'),
          c('test', 'Pressure-test and hold for the specified time', true),
          c('moisture', 'Check adjacent areas for moisture and damage'),
          c('photos', 'Photograph the leak and the repair for insurance records'),
        ],
        troubleshooting: {
          symptom: 'Visible leak, dripping, stains or unexplained water use',
          safety: 'Shut off the main if the source is unknown. Watch for electrical hazards near standing water.',
          causes: [
            { key: 'failed-fitting', label: 'Failed fitting or compression joint', likelihood: 'common', test: 'Dry the area and trace the water to a joint.', fix: 'Replace or re-make the joint.', parts: ['Fittings', 'Supply line'] },
            { key: 'supply-line', label: 'Corroded or failed supply line / stop valve', likelihood: 'common', test: 'Inspect the connector and the valve stem.', fix: 'Replace the line or valve.', parts: ['Braided supply line', 'Angle stop'] },
            { key: 'pinhole-corrosion', label: 'Pinhole corrosion in the pipe', likelihood: 'occasional', test: 'Localized spray or pit; check the pipe age and water chemistry.', fix: 'Section repair; discuss re-pipe if widespread.', parts: ['Pipe section', 'Couplings'] },
            { key: 'high-pressure', label: 'High water pressure', likelihood: 'occasional', test: 'Gauge on a hose bib reads above 80 psi.', fix: 'Install or replace the pressure regulator.', parts: ['Pressure regulator'] },
          ],
        },
      },
      {
        key: 'fixture-install',
        label: 'Fixture installation',
        match: ['toilet', 'faucet', 'sink', 'disposal', 'fixture', 'install'],
        benchmark: { ticketMinCents: 17900, ticketMaxCents: 36900, durationMinutes: 90, firstTimeFixPct: 95, maxCallbackPct: 3, targetMarginPct: 55 },
        price: { serviceName: 'Fixture Installation (toilet / faucet)', category: 'Installs', pricingModel: 'range', priceCents: 17900, priceMaxCents: 36900, keywords: ['install toilet', 'install faucet', 'replace sink', 'garbage disposal'], description: 'Labor to install a customer- or contractor-supplied fixture, including new supply lines and shut-off checks.', estimatedCostCents: 8000 },
        checklist: [
          c('shutoff', 'Verify the shut-off valves work before starting', true),
          c('fit', 'Dry-fit the fixture and confirm the rough-in dimensions'),
          c('supply', 'Install new supply lines and seals'),
          c('leak-check', 'Run the fixture and check every joint for leaks after 10 minutes', true),
          c('caulk', 'Seal and clean up the work area'),
          c('demo', 'Demonstrate operation to the customer'),
        ],
      },
    ],
  },

  /* ============================ ELECTRICAL ============================ */
  {
    slug: 'electrical',
    name: 'Electrical',
    tagline: 'Circuits, panels, lighting and EV charging — with safety-first checklists.',
    catalogVersion: 1,
    workflowSlugs: ['missed-call-text-back', 'speed-to-lead-60s', 'quote-follow-up-close', 'estimate-booking-recovery', 'post-job-review-request'],
    dispatchNotes: [
      'Burning smell, sparks, smoking outlet or panel: tell the caller to stay away, turn off the main breaker only if it is safe, call emergency services if there is fire, and dispatch as priority one.',
      'Partial power loss or a tripping main: same-day priority; total outage may be a utility issue, so ask whether neighbors are affected.',
      'Never advise the caller to open a panel or touch wiring.',
    ],
    jobTypes: [
      {
        key: 'dead-outlet-circuit',
        label: 'Dead outlet / circuit',
        match: ['outlet', 'no power', 'dead', 'circuit', 'gfci', 'tripping', 'receptacle'],
        benchmark: { ticketMinCents: 15900, ticketMaxCents: 49900, durationMinutes: 75, firstTimeFixPct: 85, maxCallbackPct: 4, targetMarginPct: 55 },
        price: { serviceName: 'Outlet / Circuit Troubleshooting', category: 'Troubleshooting', pricingModel: 'range', priceCents: 15900, priceMaxCents: 49900, keywords: ['outlet not working', 'no power', 'gfci tripping', 'dead circuit'], description: 'Diagnosis and repair of a dead outlet, GFCI or single-circuit fault. Concealed wiring repairs are quoted separately.', estimatedCostCents: 7000 },
        checklist: [
          c('verify-dead', 'Verify the circuit is de-energized with a tester before touching conductors', true),
          c('gfci', 'Check upstream GFCI/AFCI devices and reset'),
          c('load', 'Check the load on the circuit and recent additions'),
          c('connections', 'Inspect connections; replace backstab connections with terminal screws'),
          c('polarity', 'Verify polarity, grounding and voltage after repair', true),
          c('aluminum', 'Note aluminum wiring or a burning smell and quote separately', true),
          c('photos', 'Photograph findings and the completed repair'),
        ],
        troubleshooting: {
          symptom: 'Outlet, GFCI or a whole circuit has no power',
          safety: 'Always verify dead with a tester. Stop and quote separately if you find aluminum wiring, heat damage or a burning smell.',
          causes: [
            { key: 'tripped-gfci', label: 'Tripped upstream GFCI / AFCI', likelihood: 'common', test: 'Locate and test upstream protective devices.', fix: 'Reset; replace if it will not hold or fails the test.', parts: ['GFCI receptacle'] },
            { key: 'loose-connection', label: 'Loose or backstab connection', likelihood: 'common', test: 'Check for heat marks and wiggle-test with power off.', fix: 'Re-terminate at screw terminals or pigtail.', parts: ['Wire connectors', 'Receptacle'] },
            { key: 'failed-receptacle', label: 'Failed receptacle or switch', likelihood: 'common', test: 'Test continuity and voltage at the device.', fix: 'Replace the device.', parts: ['Receptacle', 'Switch'] },
            { key: 'overloaded-circuit', label: 'Overloaded circuit', likelihood: 'occasional', test: 'Measure load; identify what is on the circuit.', fix: 'Redistribute the load or add a circuit.', parts: ['Breaker'] },
            { key: 'damaged-wiring', label: 'Damaged or degraded wiring', likelihood: 'rare', test: 'Trace the run; test insulation resistance where appropriate.', fix: 'Quote a wiring repair or replacement.', parts: ['Cable'] },
          ],
        },
      },
      {
        key: 'panel-breaker',
        label: 'Breaker / panel',
        match: ['panel', 'breaker', 'fuse', 'main breaker', 'service upgrade', 'subpanel', 'meter'],
        benchmark: { ticketMinCents: 27900, ticketMaxCents: 129900, durationMinutes: 120, firstTimeFixPct: 80, maxCallbackPct: 5, targetMarginPct: 50 },
        price: { serviceName: 'Breaker / Panel Repair', category: 'Panels', pricingModel: 'range', priceCents: 27900, priceMaxCents: 129900, keywords: ['breaker keeps tripping', 'panel problem', 'replace breaker', 'fuse box'], description: 'Diagnosis and repair of breakers, lugs and panel components. Panel or service upgrades are quoted separately.', estimatedCostCents: 15000 },
        checklist: [
          c('ppe', 'Use appropriate PPE and insulated tools; never work alone on the service side', true),
          c('label', 'Photograph and confirm the panel schedule before changes'),
          c('thermal', 'Thermal-scan or visually inspect for heat damage'),
          c('torque', 'Torque lugs and terminals to spec', true),
          c('breaker-match', 'Match breaker type and rating to the panel listing', true),
          c('double-tap', 'Check for double-tapped breakers and overcurrent protection'),
          c('permit', 'Confirm permit and inspection requirements'),
        ],
        troubleshooting: {
          symptom: 'Breaker trips repeatedly, will not reset, or the panel is hot / buzzing',
          safety: 'Panel covers are live parts. Stop and quote if you see scorching, corrosion or a recalled panel brand.',
          causes: [
            { key: 'failed-breaker', label: 'Failed or weak breaker', likelihood: 'common', test: 'Compare trip behavior with a known load; check for heat.', fix: 'Replace with the correct listed breaker.', parts: ['Circuit breaker'] },
            { key: 'loose-lug', label: 'Loose lug or neutral connection', likelihood: 'common', test: 'Look for discoloration; check torque with power off.', fix: 'Re-terminate and torque to spec.', parts: ['Lug', 'Anti-oxidant compound'] },
            { key: 'overloaded-panel', label: 'Overloaded or double-tapped circuit', likelihood: 'occasional', test: 'Run a load calculation and inspect the breaker terminals.', fix: 'Add circuits or upgrade capacity.', parts: ['Tandem breaker', 'Subpanel'] },
            { key: 'obsolete-panel', label: 'Obsolete or recalled panel', likelihood: 'occasional', test: 'Identify the brand and model against recall lists.', fix: 'Recommend a panel replacement.', parts: ['Panel'] },
            { key: 'bus-corrosion', label: 'Corroded or damaged bus', likelihood: 'rare', test: 'Visual inspection for corrosion and arcing.', fix: 'Quote a panel replacement.', parts: ['Panel'] },
          ],
        },
      },
      {
        key: 'lighting-fan',
        label: 'Lighting / ceiling fan',
        match: ['light', 'lighting', 'fan', 'recessed', 'can light', 'dimmer', 'chandelier'],
        benchmark: { ticketMinCents: 12900, ticketMaxCents: 34900, durationMinutes: 75, firstTimeFixPct: 95, maxCallbackPct: 3, targetMarginPct: 58 },
        price: { serviceName: 'Light / Ceiling Fan Installation', category: 'Installs', pricingModel: 'range', priceCents: 12900, priceMaxCents: 34900, keywords: ['install ceiling fan', 'new light fixture', 'recessed lighting', 'dimmer switch'], description: 'Labor to install a customer- or contractor-supplied fixture on an existing box. New circuits and box changes are quoted separately.', estimatedCostCents: 5500 },
        checklist: [
          c('verify-dead', 'Verify the circuit is de-energized before starting', true),
          c('box-rating', 'Confirm the box is rated for the fan or fixture weight', true),
          c('wiring', 'Make connections with proper connectors and grounding'),
          c('balance', 'Balance and secure the fan; test all speeds'),
          c('function', 'Test switch, dimmer and remote operation'),
          c('cleanup', 'Clean the work area and demonstrate operation'),
        ],
      },
      {
        key: 'ev-charger',
        label: 'EV charger installation',
        match: [' ev ', 'charger', 'tesla', 'level 2', 'electric vehicle'],
        benchmark: { ticketMinCents: 129900, ticketMaxCents: 290000, durationMinutes: 240, firstTimeFixPct: 90, maxCallbackPct: 3, targetMarginPct: 40 },
        price: { serviceName: 'EV Charger Installation (Level 2, starting at)', category: 'EV', pricingModel: 'starting_at', priceCents: 129900, keywords: ['ev charger', 'tesla charger', 'level 2 charger', 'car charger'], description: 'Level 2 charger install on a dedicated circuit with a short run. Longer runs, panel upgrades and permits are quoted separately.', estimatedCostCents: 78000 },
        checklist: [
          c('load-calc', 'Perform a load calculation and confirm panel capacity', true),
          c('permit', 'Confirm permit, inspection and utility requirements', true),
          c('breaker', 'Install the correct dedicated breaker and wire gauge', true),
          c('torque', 'Torque all terminals to spec'),
          c('gfci', 'Verify GFCI protection and ground continuity'),
          c('commission', 'Commission the charger and test with a vehicle or tester'),
          c('handover', 'Hand over documentation and warranty details'),
        ],
      },
    ],
  },
];

export function getTradePlaybook(slug: string | null | undefined): TradePlaybook | undefined {
  return TRADE_PLAYBOOKS.find((p) => p.slug === slug);
}

/**
 * Maps a job's free-text service_type to a job type. Longest matching fragment
 * wins so "water heater leak" resolves to water-heater, not leak-repair.
 */
export function matchJobType(playbook: TradePlaybook, serviceType: string | null | undefined): TradeJobType | undefined {
  const text = ` ${(serviceType ?? '').toLowerCase()} `;
  if (text.trim() === '') return undefined;
  let best: { jt: TradeJobType; len: number } | undefined;
  for (const jt of playbook.jobTypes) {
    for (const fragment of jt.match) {
      if (text.includes(fragment) && (!best || fragment.length > best.len)) best = { jt, len: fragment.length };
    }
  }
  return best?.jt;
}
