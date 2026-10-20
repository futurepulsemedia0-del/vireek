/**
 * Multi-technician job crews: types, labels and PURE business logic.
 * No Supabase import on purpose, so everything is unit-testable.
 * Data access lives in jobCrewApi.ts.
 *
 * The database (supabase/migrations/20271011000000_job_crews.sql) is the
 * AUTHORITATIVE calculator. allocateShares() mirrors its largest-remainder
 * allocation exactly so the UI can preview a split before saving.
 *
 * Shares are integer basis points (10000 = 100%) so nothing drifts.
 */

export type CrewRole = 'lead' | 'helper' | 'apprentice';
export type LaborSplitMode = 'role_weights' | 'equal' | 'manual' | 'actual_hours';
export type CommissionSplitMode = 'role_weights' | 'equal' | 'manual' | 'labor';

export const BPS_TOTAL = 10000;
export const MIN_CREW_SIZE = 2;
export const MAX_CREW_SIZE = 12;
export const MAX_REQUIRED_SKILLS = 20;
export const MAX_SKILL_LENGTH = 40;

export const ROLE_WEIGHTS: Record<CrewRole, number> = { lead: 50, helper: 30, apprentice: 20 };
export const ROLE_LABELS: Record<CrewRole, string> = { lead: 'Lead', helper: 'Helper', apprentice: 'Apprentice' };
export const ROLE_OPTIONS: CrewRole[] = ['lead', 'helper', 'apprentice'];

export const LABOR_MODE_LABELS: Record<LaborSplitMode, string> = {
  role_weights: 'By role',
  equal: 'Equal',
  manual: 'Manual %',
  actual_hours: 'Actual hours',
};
export const COMMISSION_MODE_LABELS: Record<CommissionSplitMode, string> = {
  role_weights: 'By role',
  equal: 'Equal',
  manual: 'Manual %',
  labor: 'Follow labor split',
};
export const LABOR_MODE_OPTIONS: LaborSplitMode[] = ['role_weights', 'equal', 'manual', 'actual_hours'];
export const COMMISSION_MODE_OPTIONS: CommissionSplitMode[] = ['role_weights', 'equal', 'manual', 'labor'];

export const LABOR_MODE_HINTS: Record<LaborSplitMode, string> = {
  role_weights: 'Lead 50 · Helper 30 · Apprentice 20, shared across the crew.',
  equal: 'Every member gets the same share.',
  manual: 'You set each percentage. Must total 100%.',
  actual_hours: 'Based on each person’s own clocked time on this job. Falls back to roles until hours exist.',
};
export const COMMISSION_MODE_HINTS: Record<CommissionSplitMode, string> = {
  role_weights: 'Lead 50 · Helper 30 · Apprentice 20, shared across the crew.',
  equal: 'Every member gets the same share.',
  manual: 'You set each percentage. Must total 100%.',
  labor: 'Uses the labor split above (including actual hours).',
};

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** One roster row as returned by get_job_crew(). Money fields are null when the viewer may not see them. */
export interface CrewMember {
  assignment_id: string;
  technician_id: string;
  name: string;
  role: CrewRole;
  skills: string[];
  net_minutes: number;
  labor_bps: number | null;
  commission_bps: number | null;
  labor_cost_cents: number | null;
}

export interface JobCrew {
  has_crew: boolean;
  can_manage: boolean;
  can_see_money: boolean;
  labor_mode: LaborSplitMode;
  commission_mode: CommissionSplitMode;
  required_skills: string[];
  skill_gaps: string[];
  total_minutes: number;
  members: CrewMember[];
}

export interface CrewDraftMember {
  technicianId: string;
  role: CrewRole;
  /** Used only in manual modes. */
  laborBps: number;
  commissionBps: number;
}

export interface CrewDraft {
  members: CrewDraftMember[];
  laborMode: LaborSplitMode;
  commissionMode: CommissionSplitMode;
  requiredSkills: string[];
}

export interface CrewRpcMember {
  technician_id: string;
  role: CrewRole;
  labor_bps: number;
  commission_bps: number;
}

// ------------------------------------------------------------
// Allocation (mirror of public._crew_allocate)
// ------------------------------------------------------------

/**
 * Largest-remainder allocation. Weights must be non-negative integers.
 * The result always sums to `total`; ties go to the earliest index; all-zero
 * weights fall back to an equal split.
 */
export function allocateShares(weights: number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (!Number.isInteger(total) || total < 0) throw new Error('Total must be a whole number of 0 or more.');
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) throw new Error('Weights must be whole numbers of 0 or more.');
  }
  let w = weights;
  let sum = w.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    w = weights.map(() => 1);
    sum = n;
  }
  const res = w.map((x) => (total * x - ((total * x) % sum)) / sum);
  const rem = w.map((x) => (total * x) % sum);
  let left = total - res.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let idx = 0;
    for (let i = 1; i < n; i += 1) if (rem[i] > rem[idx]) idx = i;
    res[idx] += 1;
    rem[idx] = -1;
    left -= 1;
  }
  return res;
}

/** Split a money amount (integer cents) by shares in basis points. Sums exactly to `cents`. */
export function splitCents(cents: number, shareBps: number[]): number[] {
  return allocateShares(shareBps, cents);
}

function roleWeights(members: Pick<CrewDraftMember, 'role'>[]): number[] {
  return members.map((m) => ROLE_WEIGHTS[m.role]);
}

/** Planned (stored) labor shares for a draft. */
export function plannedLaborShares(draft: Pick<CrewDraft, 'members' | 'laborMode'>): number[] {
  const { members, laborMode } = draft;
  if (laborMode === 'equal') return allocateShares(members.map(() => 1), BPS_TOTAL);
  if (laborMode === 'manual') return members.map((m) => m.laborBps);
  return allocateShares(roleWeights(members), BPS_TOTAL); // role_weights + actual_hours fallback
}

/** Planned (stored) commission shares for a draft. */
export function plannedCommissionShares(draft: Pick<CrewDraft, 'members' | 'commissionMode' | 'laborMode'>): number[] {
  const { members, commissionMode } = draft;
  if (commissionMode === 'equal') return allocateShares(members.map(() => 1), BPS_TOTAL);
  if (commissionMode === 'manual') return members.map((m) => m.commissionBps);
  if (commissionMode === 'labor') return plannedLaborShares(draft);
  return allocateShares(roleWeights(members), BPS_TOTAL);
}

/**
 * Effective shares (mirror of public._crew_effective): planned shares,
 * normalised to 100%, replaced by actual-hours shares when that mode is on and
 * at least one minute was worked.
 */
export function effectiveShares(params: {
  plannedLabor: number[];
  plannedCommission: number[];
  minutes: number[];
  laborMode: LaborSplitMode;
  commissionMode: CommissionSplitMode;
}): { labor: number[]; commission: number[] } {
  let labor = allocateShares(params.plannedLabor, BPS_TOTAL);
  let commission = allocateShares(params.plannedCommission, BPS_TOTAL);
  const totalMinutes = params.minutes.reduce((a, b) => a + b, 0);
  if (params.laborMode === 'actual_hours' && totalMinutes > 0) labor = allocateShares(params.minutes, BPS_TOTAL);
  if (params.commissionMode === 'labor') commission = labor;
  return { labor, commission };
}

// ------------------------------------------------------------
// Skills
// ------------------------------------------------------------

/** Trim, lower-case, de-duplicate, drop empties, cap length and count. */
export function normalizeSkills(skills: string[]): string[] {
  const out: string[] = [];
  for (const raw of skills) {
    const s = raw.trim().toLowerCase().slice(0, MAX_SKILL_LENGTH).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_REQUIRED_SKILLS);
}

/** Required skills that no crew member covers (case-insensitive). */
export function skillGaps(required: string[], crewSkills: string[][]): string[] {
  const have = new Set(crewSkills.flat().map((s) => s.trim().toLowerCase()));
  return normalizeSkills(required).filter((s) => !have.has(s));
}

// ------------------------------------------------------------
// Validation + payload
// ------------------------------------------------------------

/** Returns a human-readable problem, or null when the draft can be saved. An empty roster means "no crew". */
export function validateCrewDraft(draft: CrewDraft): string | null {
  const { members } = draft;
  if (members.length === 0) return null;
  if (members.length < MIN_CREW_SIZE) return 'A crew needs at least two people. Remove the crew to go back to one technician.';
  if (members.length > MAX_CREW_SIZE) return `A crew can have at most ${MAX_CREW_SIZE} people.`;
  if (new Set(members.map((m) => m.technicianId)).size !== members.length) return 'Each technician can only appear once.';
  if (members.some((m) => !m.technicianId)) return 'Choose a technician for every row.';
  const leads = members.filter((m) => m.role === 'lead').length;
  if (leads !== 1) return leads === 0 ? 'Pick exactly one lead.' : 'Only one person can be the lead.';

  if (draft.laborMode === 'manual') {
    const err = validateManual(members.map((m) => m.laborBps), 'Labor');
    if (err) return err;
  }
  if (draft.commissionMode === 'manual') {
    const err = validateManual(members.map((m) => m.commissionBps), 'Commission');
    if (err) return err;
  }
  if (draft.requiredSkills.length > MAX_REQUIRED_SKILLS) return `At most ${MAX_REQUIRED_SKILLS} required skills.`;
  return null;
}

function validateManual(values: number[], label: string): string | null {
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > BPS_TOTAL)) return `${label} percentages must be between 0% and 100%.`;
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum !== BPS_TOTAL) return `${label} shares total ${formatBps(sum)}. They must total 100%.`;
  return null;
}

/** Payload for set_job_crew(). Planned shares are computed server-side; manual values are passed through. */
export function toRpcMembers(draft: CrewDraft): CrewRpcMember[] {
  return draft.members.map((m) => ({
    technician_id: m.technicianId,
    role: m.role,
    labor_bps: draft.laborMode === 'manual' ? m.laborBps : 0,
    commission_bps: draft.commissionMode === 'manual' ? m.commissionBps : 0,
  }));
}

/** Builds an editable draft from the saved crew (or a starter draft with just the lead). */
export function draftFromCrew(crew: JobCrew | null, leadTechnicianId: string | null): CrewDraft {
  if (crew && crew.has_crew) {
    return {
      members: crew.members.map((m) => ({
        technicianId: m.technician_id,
        role: m.role,
        laborBps: m.labor_bps ?? 0,
        commissionBps: m.commission_bps ?? 0,
      })),
      laborMode: crew.labor_mode,
      commissionMode: crew.commission_mode,
      requiredSkills: crew.required_skills,
    };
  }
  return {
    members: leadTechnicianId ? [{ technicianId: leadTechnicianId, role: 'lead', laborBps: 0, commissionBps: 0 }] : [],
    laborMode: 'role_weights',
    commissionMode: 'role_weights',
    requiredSkills: [],
  };
}

/** Gives manual modes a sensible starting point: the current planned split. */
export function seedManualShares(draft: CrewDraft): CrewDraft {
  const labor = plannedLaborShares({ members: draft.members, laborMode: 'role_weights' });
  const commission = plannedCommissionShares({ members: draft.members, commissionMode: 'role_weights', laborMode: 'role_weights' });
  return { ...draft, members: draft.members.map((m, i) => ({ ...m, laborBps: labor[i] ?? 0, commissionBps: commission[i] ?? 0 })) };
}

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "33.33" -> 3333. Returns null for anything that is not a number with at most 2 decimals in 0..100. */
export function percentInputToBps(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100);
  return n >= 0 && n <= BPS_TOTAL ? n : null;
}

export function bpsToPercentInput(bps: number): string {
  return (bps / 100).toString();
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Turns a database / PostgREST error into something a dispatcher can act on. */
export function describeCrewError(error: { code?: string; message?: string } | null | undefined): string {
  const msg = (error?.message ?? '').toLowerCase();
  const table: Array<[string, string]> = [
    ['crew_forbidden', 'You do not have permission to change crews.'],
    ['crew_job_not_found', 'This job could not be found.'],
    ['crew_size_invalid', 'A crew needs 2 to 12 people.'],
    ['crew_duplicate_member', 'Each technician can only appear once.'],
    ['crew_invalid_role', 'One of the roles is not valid.'],
    ['crew_needs_one_lead', 'Pick exactly one lead.'],
    ['crew_member_not_on_team', 'One of the technicians is no longer on your team.'],
    ['crew_labor_shares_must_total_100', 'Labor shares must total 100%.'],
    ['crew_commission_shares_must_total_100', 'Commission shares must total 100%.'],
    ['crew_unassign_blocked', 'Remove the crew before unassigning this job.'],
    ['already on a statement', 'Commissions for this job are already on a statement. Void the statement or add an adjustment first.'],
  ];
  for (const [needle, text] of table) if (msg.includes(needle)) return text;
  if (error?.code === '42501') return 'You do not have permission to change crews.';
  return 'Could not save the crew. Please try again.';
}
