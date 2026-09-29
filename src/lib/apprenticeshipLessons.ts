/**
 * Vireek Technician Apprenticeship Engine - learning content.
 *
 * Static, reviewable micro-lessons, one per competency. Learning is the ONLY
 * self-attested stage of the pathway (completion is recorded through the
 * complete_apprenticeship_lesson RPC). It can never lift a certification on
 * its own: the Assessment and Real Job stages are derived from server-scored
 * simulator attempts and real job outcomes.
 *
 * Content is general good practice, not a substitute for manufacturer
 * documentation, local code or licensing requirements.
 */

export interface ApprenticeshipLesson {
  id: string;
  competencyId: string;
  title: string;
  minutes: number;
  summary: string;
  checkpoints: string[];
}

export const APPRENTICESHIP_LESSONS: ApprenticeshipLesson[] = [
  {
    id: 'hvac-refrigerant-diagnosis',
    competencyId: 'hvac_refrigerant',
    title: 'Refrigerant-side diagnosis, in the right order',
    minutes: 8,
    summary:
      'Most "low charge" calls are really airflow, metering or coil problems. Rule those out with measurements before touching the charge.',
    checkpoints: [
      'Confirm filter, blower and coil airflow first, then take temperature split across the evaporator.',
      'Use superheat for fixed-orifice systems and subcooling for TXV systems, and compare against the manufacturer chart.',
      'Never vent refrigerant. Recovery and handling require the proper EPA 608 certification and equipment.',
    ],
  },
  {
    id: 'hvac-airflow-controls',
    competencyId: 'hvac_airflow_controls',
    title: 'Airflow, heating and control-circuit fault finding',
    minutes: 7,
    summary:
      'Comfort complaints come from airflow, ignition sequence or a control signal that never arrives. Trace the sequence of operation, not the symptom.',
    checkpoints: [
      'Walk the sequence of operation step by step and find the first step that does not happen.',
      'Check static pressure and duct restrictions before condemning a blower or furnace.',
      'Verify low-voltage control power and thermostat call signals before replacing boards.',
    ],
  },
  {
    id: 'plumbing-leak-drain',
    competencyId: 'plumbing_leak_drain',
    title: 'Locating leaks and clearing drains without guessing',
    minutes: 7,
    summary:
      'Isolate the system into zones and test each one. A fast, confident diagnosis beats opening walls on a hunch.',
    checkpoints: [
      'Isolate supply zones and use a pressure test or meter movement to confirm where water is being lost.',
      'For drains, check venting and slope, and use a camera before choosing cable, jetting or excavation.',
      'Document moisture readings and photos so the customer and any insurer can follow your reasoning.',
    ],
  },
  {
    id: 'plumbing-water-heating',
    competencyId: 'plumbing_water_heating',
    title: 'Water heater service and safety checks',
    minutes: 7,
    summary:
      'Water heaters combine stored energy, combustion and pressure. Safety devices come first, performance second.',
    checkpoints: [
      'Inspect the temperature and pressure relief valve, discharge line, and expansion control before anything else.',
      'On gas units verify venting, combustion air and carbon monoxide, and test the thermocouple or flame sensor.',
      'On electric units test elements and thermostats with power isolated and verified off.',
    ],
  },
  {
    id: 'electrical-fault-isolation',
    competencyId: 'electrical_fault',
    title: 'Electrical fault isolation, safely',
    minutes: 8,
    summary:
      'Isolate by halves, measure instead of assuming, and treat every conductor as live until you have proven otherwise.',
    checkpoints: [
      'Lock out and tag out, then verify the meter on a known source, test the circuit, and re-verify the meter.',
      'Split the circuit in halves to find the fault, and check neutrals and loose terminations before replacing devices.',
      'Measure voltage drop under load. Do not trust breaker labels, and stop and escalate on anything beyond your licence.',
    ],
  },
  {
    id: 'appliance-diagnosis',
    competencyId: 'appliance_diagnosis',
    title: 'Appliance diagnosis from error code to component',
    minutes: 6,
    summary:
      'Codes point at a circuit, not a part. Confirm supply, then test the component before you order it.',
    checkpoints: [
      'Read the error history and confirm power, water and gas supply before opening the appliance.',
      'Test heating elements, thermistors and motors for resistance or continuity against the spec sheet.',
      'Respect stored energy, such as microwave capacitors, and disconnect power before touching internal components.',
    ],
  },
  {
    id: 'core-diagnostic-reasoning',
    competencyId: 'diagnostic_reasoning',
    title: 'Structured diagnostic reasoning',
    minutes: 6,
    summary:
      'List the plausible causes, rank them by likelihood and cost of being wrong, then choose the test that separates them fastest.',
    checkpoints: [
      'Write down at least three candidate causes before you pick up a tool.',
      'Choose tests that can rule a cause out, not only tests that confirm your favourite.',
      'Revisit the list every time a reading surprises you.',
    ],
  },
  {
    id: 'core-evidence-testing',
    competencyId: 'evidence_testing',
    title: 'Measure first, replace second',
    minutes: 5,
    summary:
      'A reading you can show the customer is worth more than an opinion. Record it, compare it to spec, then act.',
    checkpoints: [
      'Take the decisive measurement before replacing a part, and skip low-value tests that add time but no information.',
      'Record readings with units and location so another technician could repeat them.',
      'Compare each reading to a stated specification, not to what looks normal.',
    ],
  },
  {
    id: 'core-safety-compliance',
    competencyId: 'safety_compliance',
    title: 'Safety gates you never skip',
    minutes: 5,
    summary:
      'Every trade has steps that protect you and the customer. Skipping one to save five minutes is never the fast path.',
    checkpoints: [
      'Complete isolation, ventilation and PPE checks before intrusive measurements.',
      'Stop work and escalate when a hazard is beyond your training or licence.',
      'Photograph and log safety findings so the customer receives a clear record.',
    ],
  },
  {
    id: 'core-customer-communication',
    competencyId: 'customer_communication',
    title: 'Explaining findings and options to customers',
    minutes: 6,
    summary:
      'Customers trust technicians who explain plainly, offer real choices and confirm before they act.',
    checkpoints: [
      'Ask about symptoms, timing and history before you start, then summarise back what you heard.',
      'Explain the cause in plain language and present repair, replace and defer options with clear pricing.',
      'Get explicit approval before extra work and set honest expectations about time and follow-up.',
    ],
  },
  {
    id: 'core-parts-decisions',
    competencyId: 'parts_decisions',
    title: 'Repair, quote or escalate: making the call',
    minutes: 5,
    summary:
      'The right decision depends on part availability, safety, cost of return visits and what you can fix well today.',
    checkpoints: [
      'Confirm the exact part number and compatibility before ordering or installing.',
      'Choose repair now only when you can finish safely on this visit, otherwise quote and schedule.',
      'Escalate when the fault needs a licensed specialist or the manufacturer.',
    ],
  },
  {
    id: 'core-confidence-calibration',
    competencyId: 'confidence_calibration',
    title: 'Knowing how sure you really are',
    minutes: 4,
    summary:
      'Good technicians know when they are guessing. Calibrated confidence prevents callbacks and unsafe overreach.',
    checkpoints: [
      'State your confidence honestly and match it to the evidence you actually collected.',
      'Ask for remote expert help when confidence is low instead of pushing through.',
      'After every callback, compare what you believed with what turned out to be true.',
    ],
  },
];

export function lessonsFor(competencyId: string): ApprenticeshipLesson[] {
  return APPRENTICESHIP_LESSONS.filter((l) => l.competencyId === competencyId);
}
