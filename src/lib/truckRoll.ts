/**
 * Vireek Truck-Roll Elimination Engine.
 *
 * Not "dispatch optimization". The question asked before every dispatch is:
 * should this truck roll happen at all?
 *
 * Seven gates are evaluated for every scheduled job:
 *   1. Remote resolvable?            2. Evidence sufficient?
 *   3. Customer can provide media?   4. Correct part known?
 *   5. Correct technician available? 6. Access confirmed?
 *   7. Expected resolution probability high?
 * and the engine returns one verdict:
 *   - dispatch      cleared to roll (open items listed as conditions)
 *   - remote_first  a safe remote fix is likely: try it before rolling
 *   - hold          DO NOT DISPATCH: what is missing and how to fix it
 *   - emergency     safety-critical: never held, always dispatched
 *   - eliminated    resolved remotely: the truck roll was avoided
 *
 * Design rules (same philosophy as outcomeAssurance):
 *  - Everything above the "DATA LAYER" banner is pure and deterministic: same
 *    input, same answer, no I/O. Every verdict traces to gates, every gate to
 *    real records.
 *  - Honest about evidence: a missing signal is reported as "unknown", never
 *    guessed, and unknown never counts as a pass. Remote-resolution priors are
 *    labelled "estimated" and are replaced by the business's own measured
 *    results as remote attempts are recorded (Bayesian shrinkage).
 *  - Safety first: emergency jobs are never held. Urgent-SLA jobs are never
 *    held either; the open items are surfaced as conditions instead.
 *  - Planned work (installs, tune-ups, cleaning, estimates) is the product,
 *    not a failure: remote/evidence/media/part gates are "not applicable".
 *  - The probability gate reuses Outcome Assurance (single source of truth).
 *
 * Server counterpart: supabase/migrations/20270210000000_truck_roll_elimination.sql
 */

import { supabase } from '@/lib/supabase';
import {
  evaluateAll,
  jobTypeMatches,
  shrunkRate,
  skillMatch,
  gatherAssuranceContext,
  type AssuranceContext,
  type AssuranceJob,
  type AssuranceSettings,
  type JobAssurance,
} from '@/lib/outcomeAssurance';

// ============================================================
// TYPES
// ============================================================

export type GateKey = 'remote' | 'evidence' | 'media' | 'part' | 'technician' | 'access' | 'resolution';
export type GateStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'na';
export type Basis = 'measured' | 'estimated' | 'missing';
export type Verdict = 'dispatch' | 'remote_first' | 'hold' | 'emergency' | 'eliminated';
export type ActionKind =
  | 'request_media'
  | 'media_received'
  | 'access_confirmed'
  | 'remote_resolved'
  | 'remote_failed'
  | 'override_dispatch';
export type GateActionKind =
  | 'request_media'
  | 'confirm_access'
  | 'try_remote'
  | 'assign_technician'
  | 'resolve_parts'
  | 'add_evidence'
  | 'review_resolution'
  | 'fix_address';

export interface GateAction {
  kind: GateActionKind;
  label: string;
  href?: string;
}

export interface Gate {
  key: GateKey;
  label: string;
  question: string;
  status: GateStatus;
  /** 0-100, null when unknown / not applicable. */
  score: number | null;
  basis: Basis;
  /** Short human answer shown next to the question. */
  answer: string;
  detail: string;
  issues: string[];
  action: GateAction | null;
}

export interface JobExtra {
  id: string;
  address: string | null;
  customer_id: string | null;
  site_id: string | null;
  notes: string | null;
  tags: string[];
}

export interface EvidenceLite {
  job_id: string;
  stage: string;
  kind: string;
  actor_type: string;
}

export interface SiteLite {
  id: string;
  access_notes: string | null;
  site_contact_phone: string | null;
}

export interface CustomerLite {
  id: string;
  phone: string | null;
}

export interface ActionRow {
  id: string;
  job_id: string;
  kind: ActionKind;
  service_type: string | null;
  note: string | null;
  created_at: string;
}

export interface TruckRollSettings {
  /** Fully loaded cost of one truck roll (fuel, labour, vehicle, opportunity). */
  truck_roll_cost: number;
  /** Remote-resolution score (%) at which "try remote first" is recommended. */
  remote_threshold: number;
  /** First-visit resolution probability (%) required to clear the gate. */
  min_resolution: number;
  /** Overall readiness (%) below which a job is held. */
  min_readiness: number;
  notify_on_hold: boolean;
}

export interface TruckRollContext {
  assurance: AssuranceContext;
  extras: Record<string, JobExtra>;
  evidence: EvidenceLite[];
  sites: SiteLite[];
  customers: CustomerLite[];
  actions: ActionRow[];
}

export interface RemotePatternMatch {
  id: string;
  label: string;
  steps: string[];
}

export interface TruckRollRow {
  job: AssuranceJob;
  assurance: JobAssurance;
  verdict: Verdict;
  gates: Gate[];
  /** 0-100 weighted readiness across the applicable gates, null if nothing is known. */
  readiness: number | null;
  /** 0-100 probability a safe remote attempt resolves the issue, null when no remote path exists. */
  remoteScore: number | null;
  remotePattern: RemotePatternMatch | null;
  reasons: string[];
  /** Open (non-blocking) items for a cleared dispatch. */
  conditions: string[];
  actions: GateAction[];
  hoursToJob: number | null;
  /** Estimated cost avoided if Vireek's recommendation is followed (currency units). */
  avoidableCost: number;
  slaPressure: boolean;
  overridden: boolean;
  customerPhone: string | null;
}

// ============================================================
// CONSTANTS (documented so the model is auditable)
// ============================================================

export const DEFAULT_TRUCK_ROLL_SETTINGS: TruckRollSettings = {
  truck_roll_cost: 185,
  remote_threshold: 55,
  min_resolution: 80,
  min_readiness: 75,
  notify_on_hold: true,
};

export const GATE_LABELS: Record<GateKey, { label: string; question: string }> = {
  remote: { label: 'Remote resolution', question: 'Can this be resolved remotely?' },
  evidence: { label: 'Evidence', question: 'Is the evidence sufficient?' },
  media: { label: 'Customer media', question: 'Can the customer provide photo or video?' },
  part: { label: 'Part', question: 'Is the correct part known and available?' },
  technician: { label: 'Technician', question: 'Is the correct technician available?' },
  access: { label: 'Access', question: 'Is access confirmed?' },
  resolution: { label: 'Resolution probability', question: 'Is the expected resolution probability high?' },
};

/** Weights for the readiness score. The remote gate is a separate path and is not weighted. */
export const GATE_WEIGHTS: Record<Exclude<GateKey, 'remote'>, number> = {
  resolution: 25,
  technician: 20,
  part: 20,
  evidence: 15,
  access: 15,
  media: 5,
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  dispatch: 'Cleared to dispatch',
  remote_first: 'Try remote first',
  hold: 'DO NOT DISPATCH',
  emergency: 'Emergency: dispatch now',
  eliminated: 'Truck roll eliminated',
};

export const VERDICT_COLORS: Record<Verdict, string> = {
  dispatch: 'bg-success-500/10 text-success-500',
  remote_first: 'bg-accent/10 text-accent',
  hold: 'bg-danger/10 text-danger',
  emergency: 'bg-danger text-white',
  eliminated: 'bg-success-500/10 text-success-500',
};

export const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  pass: 'Pass',
  warn: 'Needs attention',
  fail: 'Blocked',
  unknown: 'Unknown',
  na: 'Not applicable',
};

export const TRUCK_ROLL = {
  /** Remote prior shrinkage: how many recorded attempts it takes to outweigh the prior. */
  remoteShrinkK: 5,
  /** Learned remote rate is trusted only after this many recorded attempts of the type. */
  remoteMinSamples: 3,
  /** Hours a media request may stay unanswered before it is treated as stale. */
  mediaStaleHours: 24,
  /** Access confirmations expire. */
  accessConfirmDays: 14,
  /** Overrides expire. */
  overrideDays: 7,
  /** SLA at or below this many hours is "urgent": never held. */
  urgentSlaHours: 4,
  /** Default job window when no duration is known. */
  defaultDurationMinutes: 90,
  /** Assumed first-visit failure rate when probability is unknown (used for savings only). */
  unknownFailureRate: 0.5,
} as const;

// ============================================================
// TEXT CLASSIFIERS
// ============================================================

const EMERGENCY_RE =
  /\b(gas (leak|smell)|smell(s)? (of )?gas|carbon monoxide|co alarm (going off|sounding)|flood(ing|ed)?|burst pipe|sewage|sewer backup|spark(s|ing)?|burning smell|smoke (coming|pouring)|smoking|smells? (of )?smoke|on fire|electrical fire|exposed wire|water (pouring|gushing)|emergency|no heat.{0,20}(freez|baby|elderly|infant))\b/i;

const PLANNED_RE =
  /\b(install(ation)?|replacement|new unit|tune[- ]?up|maintenance|inspection|estimate|quote|survey|commission(ing)?|seasonal|annual|clean(ing)?|deep clean|move[- ]?(in|out)|detail(ing)?)\b/i;

const EQUIPMENT_RE =
  /\b(model|serial|make|brand|carrier|trane|lennox|rheem|goodman|york|daikin|mitsubishi|bradford|navien|rinnai|bosch|kohler|moen|square d|siemens|eaton|\d{1,2}\s?(years?|yrs?)\s?old|\d{1,2}\s?(ton|seer|gallon|gal|amp))\b/i;

export function isEmergency(text: string, tags: string[] = []): boolean {
  if (tags.some((t) => /^(emergency|urgent-safety|safety)$/i.test(t.trim()))) return true;
  return EMERGENCY_RE.test(text);
}

const REPAIR_RE = /\b(repair|fix|leak(ing)?|clog(ged)?|drain|sewer|not working|no (heat|cool|power|hot water)|broken|trip(s|ped)?|emergency)\b/i;

export function isPlannedWork(serviceType: string | null | undefined): boolean {
  const svc = (serviceType ?? '').trim();
  if (!svc || REPAIR_RE.test(svc)) return false;
  return PLANNED_RE.test(svc);
}

// ============================================================
// REMOTE-RESOLUTION PATTERNS
// ============================================================
// Starting priors only. Each is labelled "estimated" in the UI and is blended
// with the business's own recorded remote attempts (shrinkage), so after enough
// real results the prior stops mattering. Steps are strictly customer-safe:
// no opening panels, no gas, no tools.

interface RemotePattern {
  id: string;
  label: string;
  match: RegExp;
  prior: number;
  steps: string[];
}

export const REMOTE_PATTERNS: RemotePattern[] = [
  { id: 'hvac_thermostat', label: 'Thermostat blank or unresponsive', match: /thermostat.{0,30}(blank|dead|not (working|responding)|no display|unresponsive)|blank thermostat/i, prior: 0.6, steps: ['Replace the thermostat batteries (if it takes them).', 'Check the HVAC breaker in the panel is not tripped; reset it once only.', 'Confirm the thermostat is set to the right mode and a temperature that calls for heating/cooling.', 'Wait 5 minutes and confirm the system starts.'] },
  { id: 'hvac_filter', label: 'Airflow or freezing caused by a dirty filter', match: /(dirty|clogged|blocked) (air )?filter|filter.{0,20}(dirty|clogged)|(ice|frozen|freezing).{0,20}(coil|evaporator|line)|weak airflow/i, prior: 0.35, steps: ['Switch the system off.', 'Replace or clean the air filter.', 'If ice is visible, leave the system off for 2-3 hours to thaw (fan only if available).', 'Restart and confirm airflow.'] },
  { id: 'hvac_condensate', label: 'Condensate overflow switch tripped', match: /(condensate|drain pan|float switch).{0,30}(full|overflow|tripped|water)|water (near|under) (the )?(air handler|furnace)/i, prior: 0.4, steps: ['Switch the system off.', 'Photograph the drain pan and drain line.', 'Clear visible standing water with a wet/dry vac if safe.', 'Restart and confirm cooling.'] },
  { id: 'elec_breaker', label: 'Tripped breaker or GFCI', match: /(breaker|gfci|gfi).{0,25}(trip|tripped|kept tripping|reset)|outlets? (not working|dead|no power)|power (out|off) (in|to) (one|some|a) (room|outlet)/i, prior: 0.6, steps: ['Unplug devices on the dead outlets.', 'Press RESET on any GFCI outlet nearby (kitchen, bathroom, garage, exterior).', 'Reset the tripped breaker once (fully off, then on).', 'If it trips again immediately, stop and keep it off: a visit is justified.'] },
  { id: 'elec_smoke_chirp', label: 'Smoke / CO detector chirping', match: /(smoke|co|carbon).{0,15}(detector|alarm).{0,20}(chirp|beep|low battery)|(chirp|beep).{0,20}(smoke|co) (detector|alarm)/i, prior: 0.65, steps: ['Replace the detector battery.', 'Hold the test button for 15 seconds to reset.', 'If it chirps again, note the unit age printed on the back (replace after 10 years).'] },
  { id: 'elec_bulb', label: 'Light fixture not working', match: /(light|fixture|lamp).{0,20}(not working|out|flicker)|bulb/i, prior: 0.4, steps: ['Replace the bulb with a known-good one of the same type.', 'Check the wall switch and any dimmer setting.', 'Check the circuit breaker.'] },
  { id: 'plumb_toilet_run', label: 'Running toilet', match: /(toilet).{0,25}(running|keeps running|runs constantly|won'?t stop)/i, prior: 0.5, steps: ['Close the toilet shut-off valve to stop the water.', 'Lift the tank lid and check that the flapper seals and the chain has slack.', 'Adjust the float so water stops below the overflow tube.', 'Open the valve and confirm it stops.'] },
  { id: 'plumb_toilet_clog', label: 'Clogged toilet', match: /(toilet).{0,25}(clog|clogged|blocked|won'?t flush|backed up)/i, prior: 0.6, steps: ['Do not flush again.', 'Use a flange plunger with a firm seal for 20 seconds.', 'Pour a bucket of warm water from waist height to force the clog through.', 'Flush once to confirm.'] },
  { id: 'plumb_disposal', label: 'Jammed garbage disposal', match: /(garbage )?disposal.{0,25}(jam|jammed|hum|humming|stuck|not (working|spinning))/i, prior: 0.6, steps: ['Switch the disposal off at the wall.', 'Insert a 1/4" hex key in the bottom socket and work it back and forth.', 'Press the red RESET button on the underside.', 'Run cold water and test.'] },
  { id: 'plumb_drain', label: 'Single slow drain', match: /(sink|drain|shower|tub).{0,25}(slow|clog|clogged|backing up)/i, prior: 0.4, steps: ['Remove visible hair or debris from the drain.', 'Use a plunger with the overflow blocked.', 'Flush with hot (not boiling) water.', 'If other fixtures are also slow, stop: a visit is justified.'] },
  { id: 'plumb_aerator', label: 'Low pressure at one faucet', match: /(low|weak) (water )?pressure.{0,25}(one|single|kitchen|bathroom) (faucet|sink|tap)|faucet.{0,20}(low|weak) pressure/i, prior: 0.45, steps: ['Unscrew the faucet aerator.', 'Rinse out sediment and reinstall.', 'Confirm both hot and cold.'] },
  { id: 'plumb_water_heater', label: 'Water heater pilot or reset', match: /(water heater).{0,30}(no hot water|pilot|reset|tripped)|no hot water/i, prior: 0.35, steps: ['Electric: reset the breaker once and press the red reset button on the heater.', 'Do NOT attempt anything if there is a gas smell: that is an emergency, leave and call.', 'Confirm the thermostat dial is not set to the lowest setting.'] },
  { id: 'appl_reset', label: 'Appliance error or needs a power reset', match: /(dishwasher|washer|dryer|oven|fridge|refrigerator|appliance).{0,30}(error|code|not (starting|working)|won'?t start|reset)/i, prior: 0.4, steps: ['Unplug the appliance (or switch its breaker off) for 2 minutes.', 'Restore power and run a short cycle.', 'Photograph the model plate and any error code if it persists.'] },
  { id: 'hvac_error_code', label: 'HVAC error code or lockout', match: /(error|fault|lockout|e\d{1,2}|code \d{1,2}).{0,25}(furnace|heat pump|ac|air conditioner|boiler|hvac)|(furnace|heat pump|boiler).{0,25}(lockout|error|fault code)/i, prior: 0.3, steps: ['Switch the system off at the thermostat for 5 minutes.', 'Restart and note whether the code returns.', 'Photograph the control board code and the unit data plate.'] },
];

export function matchRemotePattern(text: string): RemotePattern | null {
  for (const p of REMOTE_PATTERNS) if (p.match.test(text)) return p;
  return null;
}

// ============================================================
// HELPERS
// ============================================================

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function hasPhone(s: string | null | undefined): boolean {
  return (s ?? '').replace(/\D/g, '').length >= 7;
}

function latest(actions: ActionRow[], jobId: string, kinds: ActionKind[]): ActionRow | null {
  let best: ActionRow | null = null;
  for (const a of actions) {
    if (a.job_id !== jobId || !kinds.includes(a.kind)) continue;
    if (!best || a.created_at > best.created_at) best = a;
  }
  return best;
}

function jobText(job: AssuranceJob, extra: JobExtra | undefined, predictedIssue: string | null): string {
  return [job.service_type, job.diagnosis_notes, extra?.notes, predictedIssue, ...(extra?.tags ?? [])].filter(Boolean).join(' ');
}

function gate(
  key: GateKey,
  status: GateStatus,
  score: number | null,
  basis: Basis,
  answer: string,
  detail: string,
  issues: string[] = [],
  action: GateAction | null = null,
): Gate {
  return { key, ...GATE_LABELS[key], status, score: score === null ? null : round1(clamp(score)), basis, answer, detail, issues, action };
}

function notApplicable(key: GateKey, why: string): Gate {
  return gate(key, 'na', null, 'estimated', 'Not applicable', why);
}

// ============================================================
// GATES
// ============================================================

interface JobFacts {
  job: AssuranceJob;
  extra: JobExtra | undefined;
  text: string;
  planned: boolean;
  emergency: boolean;
  customerPhone: string | null;
  predictedIssue: string | null;
  briefConfidence: number | null;
}

function remoteGate(f: JobFacts, ctx: TruckRollContext, settings: TruckRollSettings): { gate: Gate; score: number | null; pattern: RemotePattern | null; viable: boolean } {
  if (f.planned) return { gate: notApplicable('remote', 'Planned work needs a visit by definition.'), score: null, pattern: null, viable: false };
  if (f.emergency) return { gate: notApplicable('remote', 'Safety-critical: remote attempts are never recommended.'), score: null, pattern: null, viable: false };

  const failed = latest(ctx.actions, f.job.id, ['remote_failed']);
  if (failed) {
    return {
      gate: gate('remote', 'na', null, 'measured', 'Attempted: not resolved', 'A remote attempt did not resolve this issue, so a visit is now justified.'),
      score: null,
      pattern: null,
      viable: false,
    };
  }

  const pattern = matchRemotePattern(f.text);
  const learned = ctx.actions.filter(
    (a) => (a.kind === 'remote_resolved' || a.kind === 'remote_failed') && jobTypeMatches(f.job.service_type, a.service_type),
  );
  const resolved = learned.filter((a) => a.kind === 'remote_resolved').length;
  const n = learned.length;
  const hasLearned = n >= TRUCK_ROLL.remoteMinSamples;

  if (!pattern && !hasLearned) {
    return { gate: gate('remote', 'na', null, 'estimated', 'No remote path', 'No safe remote fix is known for this issue, so a visit is justified.'), score: null, pattern: null, viable: false };
  }

  const prior = pattern?.prior ?? 0.1;
  const rate = hasLearned ? shrunkRate(resolved, n, prior, TRUCK_ROLL.remoteShrinkK) : prior;
  const score = round1(clamp(rate * 100));
  const basis: Basis = hasLearned ? 'measured' : 'estimated';
  const reachable = hasPhone(f.customerPhone);
  const issues: string[] = [];
  if (!reachable) issues.push('No customer phone on file: a remote attempt cannot be started.');
  const viable = score >= settings.remote_threshold && reachable;
  const src = hasLearned ? `${resolved} of ${n} similar remote attempts at your business resolved the issue` : 'starting estimate: not enough of your own remote results yet';

  return {
    gate: gate(
      'remote',
      viable ? 'warn' : 'na',
      score,
      basis,
      viable ? `Yes: ${Math.round(score)}% remote resolution` : `Unlikely: ${Math.round(score)}%`,
      `${pattern ? pattern.label + '. ' : ''}${src}.`,
      issues,
      viable ? { kind: 'try_remote', label: 'Guide a remote fix' } : null,
    ),
    score,
    pattern,
    viable,
  };
}

function evidenceGate(f: JobFacts, ctx: TruckRollContext): { gate: Gate; mediaCount: number } {
  const entries = ctx.evidence.filter((e) => e.job_id === f.job.id);
  const mediaEntries = entries.filter((e) => e.kind === 'media').length;
  const mediaActions = latest(ctx.actions, f.job.id, ['media_received']) ? 1 : 0;
  const mediaCount = mediaEntries + mediaActions;
  const chainSymptom = entries.some((e) => e.stage === 'problem' || e.stage === 'diagnosis');

  if (f.planned) return { gate: notApplicable('evidence', 'Planned work does not need diagnostic evidence.'), mediaCount };

  const noteLen = Math.max((f.job.diagnosis_notes ?? '').trim().length, (f.extra?.notes ?? '').trim().length);
  let score = 0;
  const have: string[] = [];
  const missing: string[] = [];

  if (noteLen >= 25 || f.predictedIssue || chainSymptom) {
    score += 30;
    have.push('symptom described');
  } else if (noteLen >= 8) {
    score += 15;
    missing.push('symptom needs more detail');
  } else {
    missing.push('no symptom description');
  }

  if (EQUIPMENT_RE.test(f.text)) {
    score += 15;
    have.push('equipment identified');
  } else {
    missing.push('equipment make/model/age unknown');
  }

  if (mediaCount > 0) {
    score += 30;
    have.push('photo/video on file');
  } else {
    missing.push('no photo or video');
  }

  if (f.briefConfidence !== null) {
    score += Math.round(clamp(f.briefConfidence, 0, 1) * 25);
    have.push(`mission brief ${Math.round(f.briefConfidence * 100)}% confident`);
  } else {
    missing.push('no mission brief');
  }

  const status: GateStatus = score >= 70 ? 'pass' : score >= 40 ? 'warn' : 'fail';
  return {
    mediaCount,
    gate: gate(
      'evidence',
      status,
      score,
      'measured',
      status === 'pass' ? 'Yes' : status === 'warn' ? 'Partly' : 'No',
      have.length ? `On file: ${have.join(', ')}.` : 'Nothing usable on file yet.',
      missing,
      status === 'pass' ? null : { kind: 'add_evidence', label: 'Add evidence', href: '/dashboard/evidence-chain' },
    ),
  };
}

function mediaGate(f: JobFacts, ctx: TruckRollContext, mediaCount: number): Gate {
  if (f.planned) return notApplicable('media', 'Planned work does not need customer media.');
  if (mediaCount > 0) return gate('media', 'pass', 100, 'measured', 'Received', 'Customer photo/video is on file.');

  const requested = latest(ctx.actions, f.job.id, ['request_media']);
  const reachable = hasPhone(f.customerPhone);
  if (requested) {
    const hours = Math.max(0, (ctx.assurance.now - new Date(requested.created_at).getTime()) / HOUR_MS);
    const stale = hours > TRUCK_ROLL.mediaStaleHours;
    return gate(
      'media',
      'warn',
      stale ? 35 : 60,
      'measured',
      stale ? 'No reply' : 'Requested',
      `Requested ${Math.round(hours)}h ago.`,
      stale ? ['No response after 24h: call the customer, or send the technician with extra diagnostics.'] : ['Waiting for the customer to reply.'],
      stale && reachable ? { kind: 'request_media', label: 'Send another request' } : null,
    );
  }
  if (reachable) {
    return gate('media', 'warn', 50, 'estimated', 'Can be requested', 'Customer is reachable: ask for a photo or video before rolling.', [], { kind: 'request_media', label: 'Request photo/video' });
  }
  return gate('media', 'fail', 15, 'missing', 'Cannot request', 'No customer phone on file, so media cannot be requested.', ['Add a customer phone number.']);
}

function partGate(f: JobFacts, ctx: TruckRollContext): Gate {
  const lines = ctx.assurance.parts.filter((p) => p.job_id === f.job.id);
  if (lines.length === 0) {
    if (f.planned) return notApplicable('part', 'No parts are required for this planned work.');
    if (f.predictedIssue || (f.job.diagnosis_notes ?? '').trim().length >= 25) {
      return gate('part', 'warn', 50, 'estimated', 'Not identified', 'A fault is described but no required part is recorded.', ['Confirm whether a part is needed before rolling.'], { kind: 'resolve_parts', label: 'Check parts', href: '/dashboard/parts-market' });
    }
    return gate('part', 'unknown', null, 'missing', 'Unknown', 'No diagnosis and no required parts recorded.', [], { kind: 'resolve_parts', label: 'Check parts', href: '/dashboard/parts-market' });
  }
  const ready = lines.filter((l) => l.readiness_status === 'ready').length;
  const score = (ready / lines.length) * 100;
  const short = lines.filter((l) => l.readiness_status !== 'ready');
  const issues = short.map((l) => (l.readiness_status === 'no_location' ? `${l.part_name}: not stocked anywhere` : `${l.part_name}: short by ${l.shortage_quantity}`));
  const status: GateStatus = short.length === 0 ? 'pass' : ready === 0 ? 'fail' : 'warn';
  return gate(
    'part',
    status,
    score,
    'measured',
    status === 'pass' ? 'Yes' : 'Not fully',
    `${ready} of ${lines.length} required part${lines.length === 1 ? '' : 's'} available on the van or in the warehouse.`,
    issues,
    status === 'pass' ? null : { kind: 'resolve_parts', label: 'Source the part', href: '/dashboard/parts-market' },
  );
}

function technicianGate(f: JobFacts, ctx: TruckRollContext, assurance: JobAssurance): Gate {
  const job = f.job;
  const tech = job.assigned_technician_id ? ctx.assurance.technicians.find((t) => t.id === job.assigned_technician_id) ?? null : null;
  const dispatchAction: GateAction = { kind: 'assign_technician', label: 'Open dispatch board', href: '/dashboard/dispatch' };
  if (!tech) {
    return gate('technician', 'fail', 0, 'measured', 'No technician', 'No technician is assigned to this job.', ['Assign a qualified technician.'], dispatchAction);
  }

  let score = 100;
  let hard = false;
  const issues: string[] = [];

  if (!tech.dispatch_enabled) {
    hard = true;
    score = 0;
    issues.push(`${tech.name} is not enabled for dispatch.`);
  }
  if (assurance.blockers.length > 0) {
    hard = true;
    score = Math.min(score, 10);
    issues.push(...assurance.blockers);
  }

  const skill = skillMatch(tech.skills, job.service_type);
  if (skill === 'none') {
    hard = true;
    score -= 75;
    issues.push(`${tech.name} has no recorded skill for ${job.service_type ?? 'this service'}.`);
  } else if (skill === 'partial') {
    score -= 35;
    issues.push('Skill match is partial.');
  } else if (skill === 'unknown') {
    score -= 30;
    issues.push('No skills recorded for this technician.');
  }

  if (job.scheduled_datetime) {
    const start = new Date(job.scheduled_datetime).getTime();
    const end = start + (job.duration_minutes ?? TRUCK_ROLL.defaultDurationMinutes) * 60_000;
    const day = new Date(start).toDateString();
    const others = ctx.assurance.jobs.filter(
      (j) => j.id !== job.id && j.assigned_technician_id === tech.id && j.scheduled_datetime && ['scheduled', 'en_route', 'in_progress'].includes(j.job_status),
    );
    const sameDay = others.filter((j) => new Date(j.scheduled_datetime as string).toDateString() === day).length + 1;
    const overlap = others.some((j) => {
      const s = new Date(j.scheduled_datetime as string).getTime();
      const e = s + (j.duration_minutes ?? TRUCK_ROLL.defaultDurationMinutes) * 60_000;
      return s < end && e > start;
    });
    if (overlap) {
      hard = true;
      score -= 60;
      issues.push(`${tech.name} is double-booked at this time.`);
    }
    if (sameDay > tech.max_jobs_per_day) {
      hard = true;
      score -= 40;
      issues.push(`${tech.name} is over the daily limit (${sameDay}/${tech.max_jobs_per_day}).`);
    } else if (sameDay === tech.max_jobs_per_day) {
      score -= 10;
      issues.push('At the daily job limit.');
    }
  }

  score = clamp(score);
  const status: GateStatus = hard ? 'fail' : score < 85 ? 'warn' : 'pass';
  return gate(
    'technician',
    status,
    score,
    'measured',
    status === 'pass' ? `Yes: ${tech.name}` : status === 'warn' ? `Partly: ${tech.name}` : `No: ${tech.name}`,
    assurance.technicianFit !== null ? `Technician fit ${assurance.technicianFit}%.` : 'Technician fit unknown.',
    issues,
    status === 'pass' ? null : dispatchAction,
  );
}

function accessGate(f: JobFacts, ctx: TruckRollContext): Gate {
  const job = f.job;
  const address = (f.extra?.address ?? '').trim();
  if (address.length < 5) {
    return gate('access', 'fail', 0, 'missing', 'No address', 'No usable service address on this job.', ['Add the service address.'], { kind: 'fix_address', label: 'Open jobs', href: '/dashboard/jobs' });
  }
  let score = 40;
  const have = ['address on file'];
  const issues: string[] = [];

  const confirmed = latest(ctx.actions, job.id, ['access_confirmed']);
  const confirmedFresh = confirmed && ctx.assurance.now - new Date(confirmed.created_at).getTime() <= TRUCK_ROLL.accessConfirmDays * DAY_MS;
  const site = f.extra?.site_id ? ctx.sites.find((s) => s.id === f.extra?.site_id) ?? null : null;

  if (confirmedFresh) {
    score += 60;
    have.push('access confirmed');
  } else if (site && (site.access_notes ?? '').trim().length >= 5) {
    score += 45;
    have.push('site access notes on file');
  } else if (job.customer_type === 'commercial' && site && hasPhone(site.site_contact_phone)) {
    score += 30;
    have.push('on-site contact on file');
    issues.push('Access method (gate code, key, security) not recorded.');
  } else {
    issues.push(job.customer_type === 'commercial' ? 'No site access notes or on-site contact.' : 'Customer presence and access not confirmed.');
  }

  const status: GateStatus = score >= 80 ? 'pass' : 'warn';
  return gate(
    'access',
    status,
    score,
    'measured',
    status === 'pass' ? 'Yes' : 'Not confirmed',
    `On file: ${have.join(', ')}.`,
    status === 'pass' ? [] : issues,
    status === 'pass' ? null : { kind: 'confirm_access', label: 'Mark access confirmed' },
  );
}

function resolutionGate(assurance: JobAssurance, settings: TruckRollSettings): Gate {
  const action: GateAction = { kind: 'review_resolution', label: 'Open Outcome Assurance', href: '/dashboard/outcome-assurance' };
  if (assurance.status === 'insufficient') {
    return gate('resolution', 'unknown', null, 'missing', 'Unknown', 'Not enough evidence to estimate first-visit resolution. Vireek will not guess.', [], action);
  }
  const p = assurance.probability;
  const status: GateStatus = p >= settings.min_resolution ? 'pass' : p >= settings.min_resolution - 12 ? 'warn' : 'fail';
  return gate(
    'resolution',
    status,
    p,
    assurance.coverage >= 70 ? 'measured' : 'estimated',
    `${Math.round(p)}% first-visit`,
    `Needs at least ${settings.min_resolution}%. ${Math.round(assurance.coverage)}% of the model is backed by evidence.`,
    status === 'pass' ? [] : assurance.interventions.slice(0, 2).map((i) => i.title),
    status === 'pass' ? null : action,
  );
}

// ============================================================
// VERDICT
// ============================================================

export function weightedReadiness(gates: Gate[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const g of gates) {
    if (g.key === 'remote' || g.score === null || g.status === 'na') continue;
    const w = GATE_WEIGHTS[g.key];
    sum += g.score * w;
    weight += w;
  }
  return weight === 0 ? null : round1(sum / weight);
}

export function evaluateTruckRoll(job: AssuranceJob, assurance: JobAssurance, ctx: TruckRollContext, settings: TruckRollSettings = DEFAULT_TRUCK_ROLL_SETTINGS): TruckRollRow {
  const extra = ctx.extras[job.id];
  const brief = ctx.assurance.briefs.find((b) => b.job_id === job.id) ?? null;
  const customer = extra?.customer_id ? ctx.customers.find((c) => c.id === extra.customer_id) ?? null : null;
  const text = jobText(job, extra, brief?.predicted_issue ?? null);
  const facts: JobFacts = {
    job,
    extra,
    text,
    planned: isPlannedWork(job.service_type),
    emergency: isEmergency(text, extra?.tags ?? []),
    customerPhone: customer?.phone ?? null,
    predictedIssue: brief?.predicted_issue ?? null,
    briefConfidence: brief ? brief.confidence : null,
  };

  const remote = remoteGate(facts, ctx, settings);
  const evidence = evidenceGate(facts, ctx);
  const gates: Gate[] = [
    remote.gate,
    evidence.gate,
    mediaGate(facts, ctx, evidence.mediaCount),
    partGate(facts, ctx),
    technicianGate(facts, ctx, assurance),
    accessGate(facts, ctx),
    resolutionGate(assurance, settings),
  ];

  const required = gates.filter((g) => g.key !== 'remote' && g.status !== 'na');
  const fails = required.filter((g) => g.status === 'fail');
  const opens = required.filter((g) => g.status === 'warn' || g.status === 'unknown');
  const readiness = weightedReadiness(gates);
  const hoursToJob = job.scheduled_datetime ? round1((new Date(job.scheduled_datetime).getTime() - ctx.assurance.now) / HOUR_MS) : null;
  const slaPressure = job.sla_response_hours !== null && job.sla_response_hours <= TRUCK_ROLL.urgentSlaHours;

  const override = latest(ctx.actions, job.id, ['override_dispatch']);
  const overridden = !!override && ctx.assurance.now - new Date(override.created_at).getTime() <= TRUCK_ROLL.overrideDays * DAY_MS;
  const eliminatedBy = latest(ctx.actions, job.id, ['remote_resolved']);

  const describe = (g: Gate) => `${g.label}: ${g.issues[0] ?? g.answer}`;
  const reasons: string[] = [];
  const conditions: string[] = [];
  let verdict: Verdict;

  if (eliminatedBy) {
    verdict = 'eliminated';
    reasons.push('Resolved remotely. Close or cancel this job instead of dispatching.');
  } else if (facts.emergency) {
    verdict = 'emergency';
    reasons.push('Safety-critical issue: Vireek never holds emergencies.');
    opens.concat(fails).forEach((g) => conditions.push(describe(g)));
  } else if (overridden) {
    verdict = 'dispatch';
    reasons.push(`Owner override: ${override?.note ?? 'no reason recorded'}`);
  } else if (remote.viable) {
    verdict = 'remote_first';
    reasons.push(`${remote.pattern?.label ?? 'Remote path'} is resolved without a visit about ${Math.round(remote.score ?? 0)}% of the time.`);
    reasons.push('Try the guided remote fix first. If it fails, the visit is justified.');
  } else if (fails.length > 0 || opens.length >= 2 || (readiness !== null && readiness < settings.min_readiness)) {
    if (slaPressure) {
      verdict = 'dispatch';
      reasons.push(`Urgent SLA (${job.sla_response_hours}h): not held. Fix the open items in parallel.`);
      fails.concat(opens).forEach((g) => conditions.push(describe(g)));
    } else {
      verdict = 'hold';
      fails.forEach((g) => reasons.push(describe(g)));
      opens.forEach((g) => reasons.push(describe(g)));
      if (reasons.length === 0 && readiness !== null) reasons.push(`Readiness ${Math.round(readiness)}% is below your ${settings.min_readiness}% minimum.`);
    }
  } else {
    verdict = 'dispatch';
    reasons.push(opens.length === 0 ? 'All applicable checks passed.' : 'Cleared with one open item.');
    opens.forEach((g) => conditions.push(describe(g)));
  }

  // Next actions: remote first, then blocking gates, then open gates; one per gate.
  const actions: GateAction[] = [];
  const seen = new Set<string>();
  const ordered = [remote.gate, ...fails, ...opens];
  for (const g of ordered) {
    if (!g.action || (g.key === 'remote' && !remote.viable) || seen.has(g.action.kind)) continue;
    seen.add(g.action.kind);
    actions.push(g.action);
  }

  // Estimated avoided cost (explicit, documented assumptions; never presented as realized).
  const p = assurance.status === 'insufficient' ? null : assurance.probability / 100;
  let avoidableCost = 0;
  if (verdict === 'hold') avoidableCost = (1 - (p ?? 1 - TRUCK_ROLL.unknownFailureRate)) * settings.truck_roll_cost;
  else if (verdict === 'remote_first') avoidableCost = ((remote.score ?? 0) / 100) * settings.truck_roll_cost;

  return {
    job,
    assurance,
    verdict,
    gates,
    readiness,
    remoteScore: remote.score,
    remotePattern: remote.pattern ? { id: remote.pattern.id, label: remote.pattern.label, steps: remote.pattern.steps } : null,
    reasons,
    conditions,
    actions,
    hoursToJob,
    avoidableCost: Math.round(avoidableCost),
    slaPressure,
    overridden,
    customerPhone: facts.customerPhone,
  };
}

const VERDICT_ORDER: Record<Verdict, number> = { emergency: 0, hold: 1, remote_first: 2, dispatch: 3, eliminated: 4 };

export function evaluateTruckRolls(ctx: TruckRollContext, assuranceSettings: AssuranceSettings, settings: TruckRollSettings = DEFAULT_TRUCK_ROLL_SETTINGS): TruckRollRow[] {
  return evaluateAll(ctx.assurance, assuranceSettings)
    .filter((r) => r.job.job_status === 'scheduled')
    .map((r) => evaluateTruckRoll(r.job, r.result, ctx, settings))
    .sort((a, b) => {
      const v = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
      if (v !== 0) return v;
      return (a.job.scheduled_datetime ?? '9999').localeCompare(b.job.scheduled_datetime ?? '9999');
    });
}

export interface TruckRollSummary {
  total: number;
  hold: number;
  remoteFirst: number;
  dispatch: number;
  emergency: number;
  eliminated: number;
  /** Estimated cost avoided if recommendations are followed on today's open jobs. */
  potentialSavings: number;
  /** Measured: remote resolutions recorded in the last 90 days x cost per roll. */
  realizedRolls: number;
  realizedSavings: number;
}

export function summarizeTruckRolls(rows: TruckRollRow[], actions: ActionRow[], settings: TruckRollSettings, now: number): TruckRollSummary {
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const since = now - 90 * DAY_MS;
  const realizedRolls = actions.filter((a) => a.kind === 'remote_resolved' && new Date(a.created_at).getTime() >= since).length;
  return {
    total: rows.length,
    hold: count('hold'),
    remoteFirst: count('remote_first'),
    dispatch: count('dispatch'),
    emergency: count('emergency'),
    eliminated: count('eliminated'),
    potentialSavings: rows.reduce((s, r) => s + r.avoidableCost, 0),
    realizedRolls,
    realizedSavings: Math.round(realizedRolls * settings.truck_roll_cost),
  };
}

/** Plain-text request the owner sends to the customer. Never claims anything about the fault. */
export function buildMediaRequestMessage(customerName: string, serviceType: string | null): string {
  const first = customerName.trim().split(/\s+/)[0] || 'there';
  const what = serviceType ? ` with your ${serviceType.toLowerCase()}` : '';
  return `Hi ${first}, to send the right technician and parts the first time${what}, could you reply with a short photo or video of the problem (and the label on the unit if you can see one)? Thank you!`;
}

export function smsHref(phone: string, body: string): string {
  return `sms:${phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(body)}`;
}

// ============================================================
// DATA LAYER (everything below does I/O)
// ============================================================

/** Optional data sources fail soft: a missing module lowers coverage instead of breaking the page. */
async function soft<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await p;
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function gatherTruckRollContext(): Promise<TruckRollContext> {
  const assurance = await gatherAssuranceContext();
  const scheduledIds = assurance.jobs.filter((j) => j.job_status === 'scheduled').map((j) => j.id);
  const groups = chunk(scheduledIds, 60);

  const [extraG, evidenceG, actions] = await Promise.all([
    Promise.all(groups.map((g) => soft<Record<string, unknown>>(supabase.from('jobs').select('id, address, customer_id, site_id, notes, tags').in('id', g)))),
    Promise.all(groups.map((g) => soft<EvidenceLite>(supabase.from('job_evidence_chain_entries').select('job_id, stage, kind, actor_type').in('job_id', g)))),
    soft<ActionRow>(
      supabase
        .from('truck_roll_actions')
        .select('id, job_id, kind, service_type, note, created_at')
        .gte('created_at', new Date(assurance.now - 365 * DAY_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(2000),
    ),
  ]);

  const extras: Record<string, JobExtra> = {};
  for (const r of extraG.flat()) {
    const id = String(r.id);
    extras[id] = {
      id,
      address: (r.address as string | null) ?? null,
      customer_id: (r.customer_id as string | null) ?? null,
      site_id: (r.site_id as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    };
  }

  const siteIds = [...new Set(Object.values(extras).map((e) => e.site_id).filter((x): x is string => !!x))];
  const customerIds = [...new Set(Object.values(extras).map((e) => e.customer_id).filter((x): x is string => !!x))];
  const [sitesG, customersG] = await Promise.all([
    Promise.all(chunk(siteIds, 60).map((g) => soft<SiteLite>(supabase.from('customer_sites').select('id, access_notes, site_contact_phone').in('id', g)))),
    Promise.all(chunk(customerIds, 60).map((g) => soft<CustomerLite>(supabase.from('customers').select('id, phone').in('id', g)))),
  ]);

  return { assurance, extras, evidence: evidenceG.flat(), sites: sitesG.flat(), customers: customersG.flat(), actions };
}

export async function fetchTruckRollSettings(): Promise<TruckRollSettings> {
  try {
    const { data, error } = await supabase
      .from('truck_roll_settings')
      .select('truck_roll_cost, remote_threshold, min_resolution, min_readiness, notify_on_hold')
      .maybeSingle();
    if (error || !data) return DEFAULT_TRUCK_ROLL_SETTINGS;
    return { ...(data as TruckRollSettings), truck_roll_cost: Number((data as TruckRollSettings).truck_roll_cost) };
  } catch {
    return DEFAULT_TRUCK_ROLL_SETTINGS;
  }
}

export async function saveTruckRollSettings(s: TruckRollSettings): Promise<void> {
  const { error } = await supabase.rpc('save_truck_roll_settings', {
    p_truck_roll_cost: s.truck_roll_cost,
    p_remote_threshold: s.remote_threshold,
    p_min_resolution: s.min_resolution,
    p_min_readiness: s.min_readiness,
    p_notify_on_hold: s.notify_on_hold,
  });
  if (error) throw error;
}

export async function persistTruckRollAssessments(rows: TruckRollRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  for (const part of chunk(rows, 200)) {
    const { data, error } = await supabase.rpc('record_truck_roll_assessments', {
      p_items: part.map((r) => ({
        job_id: r.job.id,
        verdict: r.verdict,
        readiness: r.readiness,
        remote_score: r.remoteScore,
        resolution_probability: r.assurance.status === 'insufficient' ? null : r.assurance.probability,
        gates: r.gates.map((g) => ({ key: g.key, status: g.status, score: g.score, basis: g.basis })),
        reasons: r.reasons.slice(0, 8),
      })),
    });
    if (error) throw error;
    written += typeof data === 'number' ? data : 0;
  }
  return written;
}

export async function recordTruckRollAction(jobId: string, kind: ActionKind, note?: string): Promise<void> {
  const { error } = await supabase.rpc('record_truck_roll_action', { p_job_id: jobId, p_kind: kind, p_note: note ?? null });
  if (error) throw error;
}
