// Project Scheduler — pure scheduling engine for multi-phase install projects.
//
// No React and no Supabase on purpose: dependency math, cascading moves,
// critical path, conflict detection and timeline geometry are deterministic
// and unit tested (projectScheduler.test.ts). Data access lives in
// projectSchedulerApi.ts.
//
// All dates are local calendar days (YYYY-MM-DD). A phase window is
// INCLUSIVE on both ends. Durations are counted in working days (Mon–Fri
// unless the project works weekends).

import {
  addDaysIso,
  clamp,
  daysBetween,
  formatDate,
  type InstallProject,
  type ProjectMaterial,
  type ProjectMilestone,
  type ProjectPhase,
  type ScheduleHealth,
} from '@/lib/installProjects';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';

export const DEP_TYPE_LABEL: Record<DepType, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};
export const MIN_LAG_DAYS = -60;
export const MAX_LAG_DAYS = 365;

export interface PhaseDependency {
  id: string;
  project_id: string;
  predecessor_id: string;
  successor_id: string;
  dep_type: DepType;
  /** Working days; negative = lead (overlap). */
  lag_days: number;
}

export interface PhaseCrewRow {
  id: string;
  project_id: string;
  phase_id: string;
  technician_id: string;
}

export interface WorkCalendar {
  workWeekends: boolean;
}

export interface Win {
  start: string;
  end: string;
}

export interface ScheduleChange {
  id: string;
  start: string;
  end: string;
  prevStart: string | null;
  prevEnd: string | null;
}

export type MoveBlock = 'locked' | 'completed' | 'invalid';

export interface ScheduleResult {
  windows: Map<string, Win>;
  changes: ScheduleChange[];
  cyclic: boolean;
  blocked?: MoveBlock;
}

export const calendarFor = (project: Pick<InstallProject, 'work_weekends'> | null | undefined): WorkCalendar => ({
  workWeekends: project?.work_weekends === true,
});

const maxIso = (a: string, b: string) => (a >= b ? a : b);
const minIso = (a: string, b: string) => (a <= b ? a : b);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------
// Working-day calendar
// ------------------------------------------------------------------

function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWeekend = (iso: string): boolean => {
  const w = weekday(iso);
  return w === 0 || w === 6;
};

export const isWorkday = (iso: string, cal: WorkCalendar): boolean => cal.workWeekends || !isWeekend(iso);

/** The date itself if it is a working day, otherwise the next one. */
export function nextWorkday(iso: string, cal: WorkCalendar): string {
  let d = iso;
  while (!isWorkday(d, cal)) d = addDaysIso(d, 1);
  return d;
}

/** The date itself if it is a working day, otherwise the previous one. */
export function prevWorkday(iso: string, cal: WorkCalendar): string {
  let d = iso;
  while (!isWorkday(d, cal)) d = addDaysIso(d, -1);
  return d;
}

/** Moves `n` working days (negative = back) from the nearest working day in that direction. */
export function shiftWorkdays(iso: string, n: number, cal: WorkCalendar): string {
  if (cal.workWeekends) return addDaysIso(iso, n);
  let d = n >= 0 ? nextWorkday(iso, cal) : prevWorkday(iso, cal);
  const step = n >= 0 ? 1 : -1;
  for (let left = Math.abs(n); left > 0; ) {
    d = addDaysIso(d, step);
    if (isWorkday(d, cal)) left -= 1;
  }
  return d;
}

/** Working days inside [start, end], both inclusive. 0 when end < start. */
export function workdaysInclusive(start: string, end: string, cal: WorkCalendar): number {
  if (end < start) return 0;
  const span = daysBetween(start, end) + 1;
  if (cal.workWeekends) return span;
  let count = 0;
  for (let i = 0, d = start; i < span; i += 1, d = addDaysIso(d, 1)) if (!isWeekend(d)) count += 1;
  return count;
}

/** Signed working days from a to b (b later → positive). */
export function workdayDiff(a: string, b: string, cal: WorkCalendar): number {
  return b >= a ? workdaysInclusive(a, b, cal) - 1 : -(workdaysInclusive(b, a, cal) - 1);
}

export const endFromDuration = (start: string, duration: number, cal: WorkCalendar): string =>
  shiftWorkdays(start, Math.max(1, Math.round(duration)) - 1, cal);

export const startFromDuration = (end: string, duration: number, cal: WorkCalendar): string =>
  shiftWorkdays(end, -(Math.max(1, Math.round(duration)) - 1), cal);

export const DEFAULT_PHASE_DAYS = (weight: number): number => clamp(Math.round(weight * 3), 1, 60);

export function phaseWindow(p: Pick<ProjectPhase, 'planned_start' | 'planned_end'>): Win | null {
  return p.planned_start && p.planned_end ? { start: p.planned_start, end: p.planned_end } : null;
}

export const phaseDuration = (w: Win, cal: WorkCalendar): number => Math.max(1, workdaysInclusive(w.start, w.end, cal));

export function currentWindows(phases: ProjectPhase[]): Map<string, Win> {
  const m = new Map<string, Win>();
  for (const p of phases) {
    const w = phaseWindow(p);
    if (w) m.set(p.id, w);
  }
  return m;
}

/** Completed or locked phases are never moved by the engine. */
const isFixed = (p: Pick<ProjectPhase, 'status' | 'locked'>) => p.status === 'completed' || p.locked === true;

// ------------------------------------------------------------------
// Dependency graph
// ------------------------------------------------------------------

/** The earliest start a successor may have so that this link is satisfied. */
export function requiredStart(dep: Pick<PhaseDependency, 'dep_type' | 'lag_days'>, pred: Win, duration: number, cal: WorkCalendar): string {
  switch (dep.dep_type) {
    case 'FS':
      return shiftWorkdays(pred.end, 1 + dep.lag_days, cal);
    case 'SS':
      return shiftWorkdays(pred.start, dep.lag_days, cal);
    case 'FF':
      return startFromDuration(shiftWorkdays(pred.end, dep.lag_days, cal), duration, cal);
    case 'SF':
      return startFromDuration(shiftWorkdays(pred.start, dep.lag_days, cal), duration, cal);
  }
}

interface Graph {
  succ: Map<string, PhaseDependency[]>;
  pred: Map<string, PhaseDependency[]>;
}

function buildGraph(phases: Pick<ProjectPhase, 'id'>[], deps: PhaseDependency[]): Graph {
  const ids = new Set(phases.map((p) => p.id));
  const succ = new Map<string, PhaseDependency[]>();
  const pred = new Map<string, PhaseDependency[]>();
  for (const d of deps) {
    if (!ids.has(d.predecessor_id) || !ids.has(d.successor_id) || d.predecessor_id === d.successor_id) continue;
    (succ.get(d.predecessor_id) ?? succ.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d);
    (pred.get(d.successor_id) ?? pred.set(d.successor_id, []).get(d.successor_id)!).push(d);
  }
  return { succ, pred };
}

const byOrder = (a: Pick<ProjectPhase, 'sort_order' | 'id'>, b: Pick<ProjectPhase, 'sort_order' | 'id'>) =>
  a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Kahn topological order (stable by sort_order). `cyclic` = some phases could not be ordered. */
export function topoOrder(phases: ProjectPhase[], deps: PhaseDependency[]): { order: string[]; cyclic: boolean } {
  const g = buildGraph(phases, deps);
  const sorted = [...phases].sort(byOrder);
  const rank = new Map(sorted.map((p, i) => [p.id, i]));
  const indeg = new Map(sorted.map((p) => [p.id, (g.pred.get(p.id) ?? []).length]));
  const ready = sorted.filter((p) => indeg.get(p.id) === 0).map((p) => p.id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const d of g.succ.get(id) ?? []) {
      const n = (indeg.get(d.successor_id) ?? 0) - 1;
      indeg.set(d.successor_id, n);
      if (n === 0) ready.push(d.successor_id);
    }
  }
  return { order, cyclic: order.length < phases.length };
}

/** True if adding predecessor → successor would close a loop (or links a phase to itself). */
export function wouldCreateCycle(deps: PhaseDependency[], predecessorId: string, successorId: string): boolean {
  if (predecessorId === successorId) return true;
  const next = new Map<string, string[]>();
  for (const d of deps) (next.get(d.predecessor_id) ?? next.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d.successor_id);
  const seen = new Set<string>();
  const stack = [successorId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === predecessorId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

function descendants(g: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const d of g.succ.get(stack.pop()!) ?? []) {
      if (!out.has(d.successor_id)) {
        out.add(d.successor_id);
        stack.push(d.successor_id);
      }
    }
  }
  return out;
}

function diffWindows(phases: ProjectPhase[], next: Map<string, Win>): ScheduleChange[] {
  const out: ScheduleChange[] = [];
  for (const p of phases) {
    const w = next.get(p.id);
    if (!w) continue;
    if (w.start !== p.planned_start || w.end !== p.planned_end) {
      out.push({ id: p.id, start: w.start, end: w.end, prevStart: p.planned_start, prevEnd: p.planned_end });
    }
  }
  return out;
}

/** One-click chain: finish-to-start links between consecutive phases that are not linked yet. */
export function sequentialLinks(
  phases: ProjectPhase[],
  deps: PhaseDependency[],
): Pick<PhaseDependency, 'predecessor_id' | 'successor_id' | 'dep_type' | 'lag_days'>[] {
  const sorted = [...phases].sort(byOrder);
  const out: Pick<PhaseDependency, 'predecessor_id' | 'successor_id' | 'dep_type' | 'lag_days'>[] = [];
  const all = [...deps];
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1].id;
    const b = sorted[i].id;
    if (all.some((d) => (d.predecessor_id === a && d.successor_id === b) || (d.predecessor_id === b && d.successor_id === a))) continue;
    if (wouldCreateCycle(all, a, b)) continue;
    out.push({ predecessor_id: a, successor_id: b, dep_type: 'FS', lag_days: 0 });
    all.push({ id: `tmp-${i}`, project_id: '', predecessor_id: a, successor_id: b, dep_type: 'FS', lag_days: 0 });
  }
  return out;
}

// ------------------------------------------------------------------
// Materials → schedule constraints
// ------------------------------------------------------------------

/** When the material can be on site. null = already delivered/installed (no constraint). */
export function materialArrival(m: Pick<ProjectMaterial, 'status' | 'expected_date' | 'lead_time_days'>, today: string): string | null {
  if (m.status === 'delivered' || m.status === 'installed') return null;
  const lead = Math.max(0, m.lead_time_days ?? 0);
  const fromLead = addDaysIso(today, lead);
  // Ordered: the supplier's date, never in the past. Planned: cannot land before an order placed today.
  if (m.status === 'ordered') return maxIso(m.expected_date ?? fromLead, today);
  return m.expected_date && m.expected_date > fromLead ? m.expected_date : fromLead;
}

/** Earliest start per phase imposed by materials that are not on site yet. */
export function materialStartConstraints(materials: ProjectMaterial[], today: string, cal: WorkCalendar): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of materials) {
    if (!m.phase_id) continue;
    const arrival = materialArrival(m, today);
    if (!arrival || arrival <= today) continue;
    const start = nextWorkday(arrival, cal);
    out.set(m.phase_id, maxIso(out.get(m.phase_id) ?? start, start));
  }
  return out;
}

// ------------------------------------------------------------------
// Auto-schedule & manual moves
// ------------------------------------------------------------------

export interface AutoScheduleInput {
  phases: ProjectPhase[];
  deps: PhaseDependency[];
  cal: WorkCalendar;
  /** Project start date, if any. Never schedules before today. */
  anchor: string | null;
  today: string;
  materialStart?: Map<string, string>;
}

/**
 * Forward pass: every movable phase starts as early as its links, its
 * materials and the calendar allow. Completed, locked and in-progress phases
 * keep their dates; phases without dates get a duration from their weight.
 */
export function autoSchedule(input: AutoScheduleInput): ScheduleResult {
  const { phases, deps, cal, anchor, today, materialStart } = input;
  const { order, cyclic } = topoOrder(phases, deps);
  if (cyclic) return { windows: currentWindows(phases), changes: [], cyclic: true };

  const g = buildGraph(phases, deps);
  const byId = new Map(phases.map((p) => [p.id, p]));
  const floor = nextWorkday(maxIso(anchor ?? today, today), cal);
  const win = new Map<string, Win>();

  for (const id of order) {
    const p = byId.get(id)!;
    const cur = phaseWindow(p);
    if (cur && (isFixed(p) || p.status === 'in_progress')) {
      win.set(id, cur);
      continue;
    }
    const dur = cur ? phaseDuration(cur, cal) : DEFAULT_PHASE_DAYS(p.weight);
    let start = floor;
    for (const d of g.pred.get(id) ?? []) {
      const pw = win.get(d.predecessor_id);
      if (pw) start = maxIso(start, requiredStart(d, pw, dur, cal));
    }
    const mat = materialStart?.get(id);
    if (mat) start = maxIso(start, mat);
    start = nextWorkday(start, cal);
    win.set(id, { start, end: endFromDuration(start, dur, cal) });
  }
  return { windows: win, changes: diffWindows(phases, win), cyclic: false };
}

/**
 * Sets one phase's dates (drag, resize, keyboard or form) and pushes later
 * phases forward where their links require it. Never pulls anything earlier
 * and never touches completed or locked phases — links they break are reported
 * by detectConflicts instead.
 */
export function setPhaseWindow(
  phases: ProjectPhase[],
  deps: PhaseDependency[],
  cal: WorkCalendar,
  id: string,
  start: string,
  end: string,
): ScheduleResult {
  const win = currentWindows(phases);
  const p = phases.find((x) => x.id === id);
  const fail = (blocked: MoveBlock): ScheduleResult => ({ windows: win, changes: [], cyclic: false, blocked });
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return fail('invalid');
  if (p.status === 'completed') return fail('completed');
  if (p.locked === true) return fail('locked');

  const s = nextWorkday(start, cal);
  const e = maxIso(prevWorkday(end, cal), s);
  win.set(id, { start: s, end: e });

  const g = buildGraph(phases, deps);
  const reach = descendants(g, id);
  const byId = new Map(phases.map((x) => [x.id, x]));
  const { order, cyclic } = topoOrder(phases, deps);
  if (cyclic) return { windows: win, changes: diffWindows(phases, win), cyclic: true };

  for (const sid of order) {
    if (!reach.has(sid)) continue;
    const sp = byId.get(sid)!;
    const w = win.get(sid);
    if (!w || isFixed(sp)) continue;
    const dur = phaseDuration(w, cal);
    let need = w.start;
    for (const d of g.pred.get(sid) ?? []) {
      const pw = win.get(d.predecessor_id);
      if (pw) need = maxIso(need, requiredStart(d, pw, dur, cal));
    }
    if (need > w.start) win.set(sid, { start: need, end: endFromDuration(need, dur, cal) });
  }
  return { windows: win, changes: diffWindows(phases, win), cyclic: false };
}

/** Drag/keyboard snapping: forward drags land on the next working day, backward on the previous. */
export function snapDate(orig: string, deltaDays: number, cal: WorkCalendar): string {
  const t = addDaysIso(orig, deltaDays);
  return deltaDays >= 0 ? nextWorkday(t, cal) : prevWorkday(t, cal);
}

// ------------------------------------------------------------------
// Critical path
// ------------------------------------------------------------------

export interface PathNode {
  es: string;
  ef: string;
  ls: string;
  lf: string;
  /** Working days the phase can slip without moving the project finish. */
  floatDays: number;
  critical: boolean;
}

export interface CriticalPathResult {
  nodes: Map<string, PathNode>;
  finish: string | null;
  criticalIds: string[];
  cyclic: boolean;
}

/**
 * Float is measured against the dates as scheduled (a data-driven CPM): the
 * critical path is the chain of zero-float phases that ends on the latest
 * finish. A deliberate gap between two linked phases therefore gives the
 * earlier one float.
 */
export function criticalPath(phases: ProjectPhase[], deps: PhaseDependency[], windows: Map<string, Win>, cal: WorkCalendar): CriticalPathResult {
  const scheduled = phases.filter((p) => windows.has(p.id));
  const empty: CriticalPathResult = { nodes: new Map(), finish: null, criticalIds: [], cyclic: false };
  if (scheduled.length === 0) return empty;
  const { order, cyclic } = topoOrder(scheduled, deps);
  if (cyclic) return { ...empty, cyclic: true };

  const g = buildGraph(scheduled, deps);
  let finish = '';
  for (const p of scheduled) finish = maxIso(finish, windows.get(p.id)!.end);

  const nodes = new Map<string, PathNode>();
  for (const id of [...order].reverse()) {
    const w = windows.get(id)!;
    const dur = phaseDuration(w, cal);
    let lf = finish;
    for (const d of g.succ.get(id) ?? []) {
      const n = nodes.get(d.successor_id);
      if (!n) continue;
      let cand: string;
      if (d.dep_type === 'FS') cand = shiftWorkdays(n.ls, -(1 + d.lag_days), cal);
      else if (d.dep_type === 'FF') cand = shiftWorkdays(n.lf, -d.lag_days, cal);
      else cand = endFromDuration(shiftWorkdays(d.dep_type === 'SS' ? n.ls : n.lf, -d.lag_days, cal), dur, cal);
      lf = minIso(lf, cand);
    }
    const ls = startFromDuration(lf, dur, cal);
    const floatDays = workdayDiff(w.start, ls, cal);
    nodes.set(id, { es: w.start, ef: w.end, ls, lf, floatDays, critical: floatDays <= 0 });
  }
  const criticalIds = order.filter((id) => nodes.get(id)!.critical);
  return { nodes, finish, criticalIds, cyclic: false };
}

// ------------------------------------------------------------------
// Conflicts
// ------------------------------------------------------------------

export type ConflictSeverity = 'error' | 'warning' | 'info';
export type ConflictKind =
  | 'dependency'
  | 'crew_overlap'
  | 'crew_time_off'
  | 'crew_busy'
  | 'blackout'
  | 'material_late'
  | 'material_order_soon'
  | 'target_overrun'
  | 'overdue'
  | 'unscheduled';

export interface ScheduleConflict {
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  phaseIds: string[];
  message: string;
  hint?: string;
}

/** Another commitment of a crew member: a phase in another project, a work-order visit or a job. */
export interface CrewBooking {
  id: string;
  technician_id: string;
  kind: 'phase' | 'work_order' | 'job';
  label: string;
  start: string;
  end: string;
}

export interface TimeOffRange {
  technician_id: string;
  start_date: string;
  end_date: string;
  kind: string;
}

export interface BlackoutRange {
  label: string;
  start_date: string;
  end_date: string;
}

export interface ConflictInput {
  project: Pick<InstallProject, 'status' | 'target_end_date'>;
  phases: ProjectPhase[];
  deps: PhaseDependency[];
  windows: Map<string, Win>;
  crew: PhaseCrewRow[];
  techNames: Map<string, string>;
  bookings: CrewBooking[];
  timeOff: TimeOffRange[];
  blackouts: BlackoutRange[];
  materials: ProjectMaterial[];
  today: string;
  cal: WorkCalendar;
}

const SEVERITY_RANK: Record<ConflictSeverity, number> = { error: 0, warning: 1, info: 2 };

function overlapDays(a: Win, b: Win, cal: WorkCalendar): { range: Win; days: number } | null {
  const start = maxIso(a.start, b.start);
  const end = minIso(a.end, b.end);
  if (end < start) return null;
  const days = workdaysInclusive(start, end, cal);
  return days > 0 ? { range: { start, end }, days } : null;
}

const span = (w: Win) => (w.start === w.end ? formatDate(w.start) : `${formatDate(w.start)} – ${formatDate(w.end)}`);

export function projectedFinish(windows: Map<string, Win>): string | null {
  let end: string | null = null;
  for (const w of windows.values()) end = end === null ? w.end : maxIso(end, w.end);
  return end;
}

export function detectConflicts(i: ConflictInput): ScheduleConflict[] {
  const { project, phases, deps, windows, crew, techNames, bookings, timeOff, blackouts, materials, today, cal } = i;
  if (project.status === 'completed' || project.status === 'cancelled') return [];

  const out: ScheduleConflict[] = [];
  const byId = new Map(phases.map((p) => [p.id, p]));
  const open = (p: ProjectPhase) => p.status !== 'completed';
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Phase';
  const tech = (id: string) => techNames.get(id) ?? 'A crew member';
  const crewByPhase = new Map<string, string[]>();
  for (const c of crew) (crewByPhase.get(c.phase_id) ?? crewByPhase.set(c.phase_id, []).get(c.phase_id)!).push(c.technician_id);

  // Dependencies
  for (const d of deps) {
    const pw = windows.get(d.predecessor_id);
    const sw = windows.get(d.successor_id);
    const sp = byId.get(d.successor_id);
    if (!pw || !sw || !sp || !byId.has(d.predecessor_id)) continue;
    const need = requiredStart(d, pw, phaseDuration(sw, cal), cal);
    if (sw.start >= need) continue;
    const gap = workdayDiff(sw.start, need, cal);
    const rel = d.dep_type === 'FS' || d.dep_type === 'FF' ? 'finishes' : 'starts';
    out.push({
      id: `dependency:${d.id}`,
      kind: 'dependency',
      severity: 'error',
      phaseIds: [d.predecessor_id, d.successor_id],
      message: `“${sp.name}” starts ${plural(gap, 'working day')} before “${nameOf(d.predecessor_id)}” ${rel} allows (${DEP_TYPE_LABEL[d.dep_type]}${d.lag_days ? `, ${d.lag_days > 0 ? '+' : ''}${d.lag_days}d` : ''}).`,
      hint: sp.locked ? 'The phase is locked — unlock it or change the link.' : 'Move the phase later or change the link.',
    });
  }

  // Crew inside this project, and against other projects / work orders / jobs
  const phases2 = phases.filter((p) => open(p) && windows.has(p.id));
  for (let a = 0; a < phases2.length; a += 1) {
    for (let b = a + 1; b < phases2.length; b += 1) {
      const pa = phases2[a];
      const pb = phases2[b];
      const shared = (crewByPhase.get(pa.id) ?? []).filter((t) => (crewByPhase.get(pb.id) ?? []).includes(t));
      if (!shared.length) continue;
      const ov = overlapDays(windows.get(pa.id)!, windows.get(pb.id)!, cal);
      if (!ov) continue;
      for (const t of shared) {
        out.push({
          id: `crew_overlap:${pa.id}:${pb.id}:${t}`,
          kind: 'crew_overlap',
          severity: 'error',
          phaseIds: [pa.id, pb.id],
          message: `${tech(t)} is on both “${pa.name}” and “${pb.name}” for ${plural(ov.days, 'working day')} (${span(ov.range)}).`,
          hint: 'Assign someone else or stagger the phases.',
        });
      }
    }
  }
  for (const p of phases2) {
    const w = windows.get(p.id)!;
    for (const t of crewByPhase.get(p.id) ?? []) {
      for (const b of bookings.filter((x) => x.technician_id === t && x.kind === 'phase')) {
        const ov = overlapDays(w, b, cal);
        if (ov) {
          out.push({
            id: `crew_overlap:${p.id}:${b.id}:${t}`,
            kind: 'crew_overlap',
            severity: 'error',
            phaseIds: [p.id],
            message: `${tech(t)} is also on “${b.label}” for ${plural(ov.days, 'working day')} of “${p.name}” (${span(ov.range)}).`,
            hint: 'Assign someone else or stagger the phases.',
          });
        }
      }
      for (const kind of ['work_order', 'job'] as const) {
        const hits = bookings.filter((x) => x.technician_id === t && x.kind === kind && overlapDays(w, x, cal));
        if (hits.length) {
          out.push({
            id: `crew_busy:${p.id}:${t}:${kind}`,
            kind: 'crew_busy',
            severity: 'warning',
            phaseIds: [p.id],
            message: `${tech(t)} also has ${plural(hits.length, kind === 'job' ? 'scheduled job' : 'work-order visit')} during “${p.name}”.`,
          });
        }
      }
      for (const off of timeOff.filter((x) => x.technician_id === t)) {
        const ov = overlapDays(w, { start: off.start_date, end: off.end_date }, cal);
        if (ov) {
          out.push({
            id: `crew_time_off:${p.id}:${t}:${off.start_date}`,
            kind: 'crew_time_off',
            severity: 'error',
            phaseIds: [p.id],
            message: `${tech(t)} is off (${off.kind}) for ${plural(ov.days, 'working day')} of “${p.name}” (${span(ov.range)}).`,
            hint: 'Swap the crew member or move the phase.',
          });
        }
      }
    }
    const closed = blackouts.map((b) => ({ b, ov: overlapDays(w, { start: b.start_date, end: b.end_date }, cal) })).filter((x) => x.ov);
    if (closed.length) {
      const days = closed.reduce((s, x) => s + x.ov!.days, 0);
      out.push({
        id: `blackout:${p.id}`,
        kind: 'blackout',
        severity: 'warning',
        phaseIds: [p.id],
        message: `“${p.name}” runs through ${plural(days, 'company blackout day')} (${closed.map((x) => x.b.label).join(', ')}).`,
      });
    }
  }

  // Materials
  for (const m of materials) {
    const w = m.phase_id ? windows.get(m.phase_id) : undefined;
    const p = m.phase_id ? byId.get(m.phase_id) : undefined;
    if (!w || !p || !open(p)) continue;
    const arrival = materialArrival(m, today);
    if (!arrival) continue;
    const late = daysBetween(w.start, arrival);
    if (late > 0) {
      out.push({
        id: `material_late:${m.id}`,
        kind: 'material_late',
        severity: 'error',
        phaseIds: [p.id],
        message: `“${m.description}” arrives ${formatDate(arrival)} — ${plural(late, 'day')} after “${p.name}” starts (${formatDate(w.start)}).`,
        hint: m.status === 'planned' ? 'Order now, pick a faster supplier or start the phase later.' : 'Chase the supplier or start the phase later.',
      });
    } else if (m.status === 'planned') {
      const orderBy = addDaysIso(w.start, -Math.max(0, m.lead_time_days ?? 0));
      if (daysBetween(today, orderBy) <= 3) {
        out.push({
          id: `material_order_soon:${m.id}`,
          kind: 'material_order_soon',
          severity: 'warning',
          phaseIds: [p.id],
          message: `Order “${m.description}” by ${formatDate(orderBy)} to be on site for “${p.name}”.`,
        });
      }
    }
  }

  // Target, overdue, unscheduled
  const finish = projectedFinish(windows);
  if (project.target_end_date && finish && finish > project.target_end_date) {
    const over = daysBetween(project.target_end_date, finish);
    out.push({
      id: 'target_overrun',
      kind: 'target_overrun',
      severity: 'error',
      phaseIds: [],
      message: `Projected finish ${formatDate(finish)} is ${plural(over, 'day')} after the ${formatDate(project.target_end_date)} target.`,
      hint: 'Shorten a critical-path phase, overlap phases or move the target.',
    });
  }
  for (const p of phases) {
    const w = windows.get(p.id);
    if (!w || !open(p)) continue;
    if (w.end < today) {
      out.push({ id: `overdue:${p.id}`, kind: 'overdue', severity: 'warning', phaseIds: [p.id], message: `“${p.name}” was due ${formatDate(w.end)} (${plural(daysBetween(w.end, today), 'day')} ago) and is not complete.` });
    } else if (p.status === 'not_started' && w.start < today) {
      out.push({ id: `overdue:${p.id}`, kind: 'overdue', severity: 'warning', phaseIds: [p.id], message: `“${p.name}” was scheduled to start ${formatDate(w.start)} but has not started.` });
    }
  }
  const undated = phases.filter((p) => open(p) && !windows.has(p.id));
  if (undated.length) {
    out.push({ id: 'unscheduled', kind: 'unscheduled', severity: 'info', phaseIds: undated.map((p) => p.id), message: `${plural(undated.length, 'phase')} without dates: ${undated.map((p) => p.name).join(', ')}.`, hint: 'Use Auto-schedule or set dates.' });
  }

  const order = new Map(phases.map((p, idx) => [p.id, idx]));
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (order.get(a.phaseIds[0] ?? '') ?? 999) - (order.get(b.phaseIds[0] ?? '') ?? 999) ||
      (a.id < b.id ? -1 : 1),
  );
}

export function conflictsByPhase(conflicts: ScheduleConflict[]): Map<string, ConflictSeverity> {
  const m = new Map<string, ConflictSeverity>();
  for (const c of conflicts) {
    if (c.severity === 'info') continue;
    for (const id of c.phaseIds) {
      const cur = m.get(id);
      if (!cur || SEVERITY_RANK[c.severity] < SEVERITY_RANK[cur]) m.set(id, c.severity);
    }
  }
  return m;
}

export function conflictCounts(conflicts: ScheduleConflict[]): Record<ConflictSeverity, number> {
  const n: Record<ConflictSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const c of conflicts) n[c.severity] += 1;
  return n;
}

// ------------------------------------------------------------------
// Timeline geometry (Gantt)
// ------------------------------------------------------------------

export type Zoom = 'day' | 'week' | 'month';
/** Pixels per calendar day. */
export const ZOOM_PX: Record<Zoom, number> = { day: 40, week: 16, month: 5 };

export interface TimelineRange {
  start: string;
  end: string;
  days: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (iso: string) => iso.split('-').map(Number) as [number, number, number];

export const mondayOnOrBefore = (iso: string): string => addDaysIso(iso, -((weekday(iso) + 6) % 7));

export function timelineRange(wins: Win[], today: string, opts: { padDays?: number; minDays?: number } = {}): TimelineRange {
  const pad = opts.padDays ?? 7;
  const minDays = opts.minDays ?? 28;
  let min = today;
  let max = today;
  for (const w of wins) {
    min = minIso(min, w.start);
    max = maxIso(max, w.end);
  }
  const start = mondayOnOrBefore(addDaysIso(min, -pad));
  let end = addDaysIso(max, pad);
  if (daysBetween(start, end) + 1 < minDays) end = addDaysIso(start, minDays - 1);
  return { start, end, days: daysBetween(start, end) + 1 };
}

export const xForDate = (r: TimelineRange, iso: string, px: number): number => daysBetween(r.start, iso) * px;

export function barGeometry(r: TimelineRange, w: Win, px: number): { left: number; width: number } {
  return { left: xForDate(r, w.start, px), width: (daysBetween(w.start, w.end) + 1) * px };
}

/** The calendar day under a pixel offset, clamped to the range. */
export const dateForOffset = (r: TimelineRange, x: number, px: number): string => addDaysIso(r.start, clamp(Math.floor(x / px), 0, r.days - 1));

export interface HeaderTick {
  key: string;
  label: string;
  left: number;
  width: number;
}

export function headerTicks(r: TimelineRange, zoom: Zoom): { top: HeaderTick[]; bottom: HeaderTick[] } {
  const px = ZOOM_PX[zoom];
  const top: HeaderTick[] = [];
  const bottom: HeaderTick[] = [];
  const group = (list: HeaderTick[], key: string, label: string, left: number, width: number) => {
    const last = list[list.length - 1];
    if (last && last.key === key) last.width += width;
    else list.push({ key, label, left, width });
  };
  for (let i = 0; i < r.days; i += 1) {
    const iso = addDaysIso(r.start, i);
    const [y, m, d] = ymd(iso);
    const left = i * px;
    if (zoom === 'month') {
      group(top, String(y), String(y), left, px);
      group(bottom, `${y}-${m}`, MONTHS[m - 1], left, px);
    } else {
      group(top, `${y}-${m}`, `${MONTHS[m - 1]} ${y}`, left, px);
      if (zoom === 'day') bottom.push({ key: iso, label: String(d), left, width: px });
      else if (i % 7 === 0) bottom.push({ key: iso, label: `${MONTHS[m - 1]} ${d}`, left, width: 7 * px });
    }
  }
  return { top, bottom };
}

// ------------------------------------------------------------------
// Customer-facing progress
// ------------------------------------------------------------------

export type CustomerPhaseState = 'done' | 'active' | 'next' | 'upcoming' | 'delayed';

export const CUSTOMER_STATE_LABEL: Record<CustomerPhaseState, string> = {
  done: 'Complete',
  active: 'In progress',
  next: 'Up next',
  upcoming: 'Coming up',
  delayed: 'Waiting',
};

/** Friendly per-phase state for the customer view: exactly one "next" phase, and only if nothing is active. */
export function customerPhaseStates(phases: ProjectPhase[], percentOf: (p: ProjectPhase) => number): Map<string, { state: CustomerPhaseState; percent: number }> {
  const sorted = [...phases].sort(byOrder);
  const anyActive = sorted.some((p) => p.status === 'in_progress');
  let nextTaken = anyActive;
  const out = new Map<string, { state: CustomerPhaseState; percent: number }>();
  for (const p of sorted) {
    let state: CustomerPhaseState = 'upcoming';
    if (p.status === 'completed') state = 'done';
    else if (p.status === 'blocked') state = 'delayed';
    else if (p.status === 'in_progress') state = 'active';
    else if (!nextTaken) {
      state = 'next';
      nextTaken = true;
    }
    out.set(p.id, { state, percent: percentOf(p) });
  }
  return out;
}

export function customerHeadline(input: { status: InstallProject['status']; progress: number; schedule: ScheduleHealth; finish: string | null; showDates: boolean }): string {
  const { status, progress, schedule, finish, showDates } = input;
  if (status === 'completed') return 'Your project is complete.';
  if (status === 'cancelled') return 'This project has been cancelled.';
  if (status === 'planning') return 'Your project is being planned.';
  if (status === 'on_hold') return 'Your project is on hold for now.';
  const eta = showDates && finish ? ` Estimated completion: ${formatDate(finish)}.` : '';
  const lead = schedule.state === 'late' || schedule.state === 'at_risk' ? 'Your project is running a little behind' : 'Your project is on track';
  return `${lead} — ${progress}% complete.${eta}`;
}
