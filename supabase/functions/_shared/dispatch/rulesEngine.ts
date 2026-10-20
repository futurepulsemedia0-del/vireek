// Dispatch Rules Engine — PURE (no I/O, no imports) so the exact same code ranks technicians in the
// edge function (dispatch-auto-assign) and in the browser (Dispatch Board explanations, simulator).
// Hard gates that live in the database (time off, capacity lock, credentials) are NOT re-implemented
// here: assign_technician_to_job() still enforces them when the winner is written.

export type RuleType = 'skill_match' | 'zone' | 'vip_priority' | 'max_drive_time' | 'tech_preference' | 'overtime_limit';
export type RuleMode = 'require' | 'score';

export const RULE_TYPES: RuleType[] = ['skill_match', 'zone', 'vip_priority', 'max_drive_time', 'tech_preference', 'overtime_limit'];

export interface DispatchRule {
  id: string;
  rule_type: RuleType;
  name: string;
  enabled: boolean;
  /** require = hard filter (fails => technician is excluded); score = weighted bonus/penalty. */
  mode: RuleMode;
  /** 0–100 points at full effect (score mode). */
  weight: number;
  params: Record<string, unknown>;
  position: number;
}

export interface EngineTechnician {
  id: string;
  name: string;
  skills: string[];
  service_area: string | null;
  territory_id: string | null;
  lat: number | null;
  lon: number | null;
  max_jobs_per_day: number;
  /** 0–1 (1 = never reworked) or null when there is not enough history. */
  quality: number | null;
}

export interface EngineJob {
  id: string;
  service_type: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  duration_minutes: number | null;
  customer_id: string | null;
  is_vip: boolean;
}

export interface EngineTerritory {
  id: string;
  name: string;
  center_latitude: number;
  center_longitude: number;
  radius_miles: number;
}

export interface EnginePreference {
  technician_id: string;
  customer_id: string | null;
  service_type: string | null;
  preference: 'prefer' | 'avoid' | 'require';
}

export interface DayLoad {
  jobs: number;
  minutes: number;
}

export interface EngineInput {
  job: EngineJob;
  technicians: EngineTechnician[];
  rules: DispatchRule[];
  territories: EngineTerritory[];
  preferences: EnginePreference[];
  /** technician id -> that technician's load on the job's day (the job itself excluded). */
  loads: Record<string, DayLoad>;
}

export type FactorOutcome = 'pass' | 'fail' | 'bonus' | 'penalty' | 'neutral';

export interface RuleFactor {
  rule_id: string;
  rule_type: RuleType | 'capacity';
  label: string;
  outcome: FactorOutcome;
  points: number;
  detail: string;
}

export interface RankedTechnician {
  technician_id: string;
  technician_name: string;
  eligible: boolean;
  score: number;
  /** 1-based among eligible technicians; null when excluded. */
  rank: number | null;
  factors: RuleFactor[];
  blocked_by: string[];
  summary: string;
}

export interface RankResult {
  ranked: RankedTechnician[];
  best: RankedTechnician | null;
  /** Score gap between #1 and #2 (null when fewer than two eligible). Small = close call. */
  margin: number | null;
  rules_applied: number;
}

export const DEFAULT_PARAMS = {
  max_drive_minutes: 45,
  avg_speed_mph: 30,
  circuity: 1.3,
  max_daily_minutes: 600,
  default_job_minutes: 60,
} as const;

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}h${String(Math.round(minutes % 60)).padStart(2, '0')}m`;
const unknownBlocks = (rule: DispatchRule) => rule.params.unknown_policy === 'block';

export function driveMinutes(tech: EngineTechnician, job: EngineJob, rule?: DispatchRule): number | null {
  if (tech.lat == null || tech.lon == null || job.lat == null || job.lon == null) return null;
  const miles = haversineMiles(tech.lat, tech.lon, job.lat, job.lon);
  const speed = num(rule?.params.avg_speed_mph, DEFAULT_PARAMS.avg_speed_mph);
  const circuity = num(rule?.params.circuity, DEFAULT_PARAMS.circuity);
  return (miles * circuity * 60) / speed;
}

function factor(rule: DispatchRule, outcome: FactorOutcome, points: number, detail: string): RuleFactor {
  return { rule_id: rule.id, rule_type: rule.rule_type, label: rule.name, outcome, points: round1(points), detail };
}

/** Pass/fail for require-mode rules, bonus (or 0) for score-mode rules. */
function gate(rule: DispatchRule, ok: boolean, okDetail: string, failDetail: string): RuleFactor {
  if (rule.mode === 'require') return factor(rule, ok ? 'pass' : 'fail', 0, ok ? okDetail : failDetail);
  return ok ? factor(rule, 'bonus', rule.weight, okDetail) : factor(rule, 'neutral', 0, failDetail);
}

function unknownFactor(rule: DispatchRule, detail: string): RuleFactor {
  return rule.mode === 'require' && unknownBlocks(rule)
    ? factor(rule, 'fail', 0, `${detail} — cannot verify`)
    : factor(rule, 'neutral', 0, `${detail} — not scored`);
}

function evalSkill(rule: DispatchRule, tech: EngineTechnician, job: EngineJob): RuleFactor {
  if (!job.service_type) return factor(rule, 'neutral', 0, 'Job has no service type');
  const ok = tech.skills.some((s) => norm(s) === norm(job.service_type));
  return gate(rule, ok, `Skilled in ${job.service_type}`, `No listed skill for ${job.service_type}`);
}

function evalZone(rule: DispatchRule, tech: EngineTechnician, job: EngineJob, territories: EngineTerritory[]): RuleFactor {
  const territory = tech.territory_id ? territories.find((t) => t.id === tech.territory_id) : undefined;
  if (territory && job.lat != null && job.lon != null) {
    const miles = haversineMiles(territory.center_latitude, territory.center_longitude, job.lat, job.lon);
    const ok = miles <= territory.radius_miles;
    return gate(rule, ok, `Inside zone ${territory.name}`, `Outside zone ${territory.name} (${round1(miles)} mi from center, radius ${territory.radius_miles} mi)`);
  }
  if (tech.service_area && job.address) {
    const ok = norm(job.address).includes(norm(tech.service_area));
    return gate(rule, ok, `Covers ${tech.service_area}`, `Address is outside ${tech.service_area}`);
  }
  return unknownFactor(rule, 'No zone data for this job or technician');
}

function evalVip(rule: DispatchRule, tech: EngineTechnician, job: EngineJob): RuleFactor {
  if (!job.is_vip) return factor(rule, 'neutral', 0, 'Not a VIP job');
  const minQ = typeof rule.params.min_quality === 'number' ? clamp(rule.params.min_quality, 0, 1) : 0;
  if (rule.mode === 'require') {
    if (tech.quality == null) return factor(rule, 'pass', 0, 'VIP job — no track record yet, allowed');
    const ok = tech.quality >= minQ;
    const q = Math.round(tech.quality * 100);
    return factor(rule, ok ? 'pass' : 'fail', 0, ok ? `VIP job — ${q}% clean-completion rate` : `VIP job needs ≥${Math.round(minQ * 100)}% clean-completion rate (has ${q}%)`);
  }
  const q = tech.quality ?? 0.5;
  const pts = rule.weight * q;
  return factor(rule, 'bonus', pts, tech.quality == null ? 'VIP job — no track record yet (neutral)' : `VIP job — ${Math.round(q * 100)}% clean-completion rate`);
}

function evalDrive(rule: DispatchRule, tech: EngineTechnician, job: EngineJob): RuleFactor {
  const drive = driveMinutes(tech, job, rule);
  if (drive == null) return unknownFactor(rule, 'Missing technician or job location');
  const max = num(rule.params.max_minutes, DEFAULT_PARAMS.max_drive_minutes);
  const label = `~${Math.round(drive)} min drive`;
  if (rule.mode === 'require') {
    const ok = drive <= max;
    return factor(rule, ok ? 'pass' : 'fail', 0, ok ? `${label} (limit ${max})` : `${label} exceeds ${max} min limit`);
  }
  const pts = clamp(rule.weight * (1 - drive / max), -rule.weight, rule.weight);
  return factor(rule, pts >= 0 ? 'bonus' : 'penalty', pts, `${label} (limit ${max})`);
}

function evalPreference(rule: DispatchRule, tech: EngineTechnician, job: EngineJob, prefs: EnginePreference[], technicians: EngineTechnician[]): RuleFactor {
  const matches = (p: EnginePreference) =>
    (p.customer_id === null || p.customer_id === job.customer_id) &&
    (p.service_type === null || norm(p.service_type) === norm(job.service_type)) &&
    !(p.customer_id === null && p.service_type === null);
  const applicable = prefs.filter(matches);
  const required = new Set(applicable.filter((p) => p.preference === 'require').map((p) => p.technician_id));
  if (required.size > 0) {
    const ok = required.has(tech.id);
    const names = technicians.filter((t) => required.has(t.id)).map((t) => t.name).join(', ') || 'another technician';
    return factor(rule, ok ? 'pass' : 'fail', 0, ok ? 'Required technician for this customer/service' : `Customer/service requires ${names}`);
  }
  const mine = applicable.filter((p) => p.technician_id === tech.id);
  if (mine.some((p) => p.preference === 'avoid')) {
    return rule.mode === 'require' ? factor(rule, 'fail', 0, 'Marked "avoid" for this customer/service') : factor(rule, 'penalty', -rule.weight, 'Marked "avoid" for this customer/service');
  }
  if (mine.some((p) => p.preference === 'prefer')) {
    return rule.mode === 'require' ? factor(rule, 'pass', 0, 'Preferred for this customer/service') : factor(rule, 'bonus', rule.weight, 'Preferred for this customer/service');
  }
  return factor(rule, 'neutral', 0, 'No preference set');
}

function evalOvertime(rule: DispatchRule, tech: EngineTechnician, job: EngineJob, load: DayLoad): RuleFactor {
  const max = num(rule.params.max_daily_minutes, DEFAULT_PARAMS.max_daily_minutes);
  const jobMin = job.duration_minutes && job.duration_minutes > 0 ? job.duration_minutes : num(rule.params.default_job_minutes, DEFAULT_PARAMS.default_job_minutes);
  const projected = load.minutes + jobMin;
  const detail = `Day would reach ${hhmm(projected)} (limit ${hhmm(max)})`;
  if (rule.mode === 'require') return factor(rule, projected <= max ? 'pass' : 'fail', 0, detail);
  const soft = max * 0.8;
  if (projected <= soft) return factor(rule, 'neutral', 0, detail);
  const pts = -rule.weight * clamp((projected - soft) / (max - soft), 0, 1);
  return factor(rule, 'penalty', pts, detail);
}

export function rankTechnicians(input: EngineInput): RankResult {
  const { job, technicians, territories, preferences, loads } = input;
  const rules = input.rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const evaluated: RankedTechnician[] = technicians.map((tech) => {
    const load = loads[tech.id] ?? { jobs: 0, minutes: 0 };
    const capacity = tech.max_jobs_per_day > 0 ? tech.max_jobs_per_day : 6;
    const factors: RuleFactor[] = [];

    // Built-in: capacity (mirrors the DB gate so the explanation is truthful) + load-balancing base score.
    const atCapacity = load.jobs >= capacity;
    factors.push({
      rule_id: 'builtin:capacity', rule_type: 'capacity', label: 'Daily capacity',
      outcome: atCapacity ? 'fail' : 'pass',
      points: atCapacity ? 0 : round1(((capacity - load.jobs) / capacity) * 10),
      detail: atCapacity ? `At capacity (${load.jobs}/${capacity} jobs)` : `${load.jobs}/${capacity} jobs that day`,
    });

    for (const rule of rules) {
      switch (rule.rule_type) {
        case 'skill_match': factors.push(evalSkill(rule, tech, job)); break;
        case 'zone': factors.push(evalZone(rule, tech, job, territories)); break;
        case 'vip_priority': factors.push(evalVip(rule, tech, job)); break;
        case 'max_drive_time': factors.push(evalDrive(rule, tech, job)); break;
        case 'tech_preference': factors.push(evalPreference(rule, tech, job, preferences, technicians)); break;
        case 'overtime_limit': factors.push(evalOvertime(rule, tech, job, load)); break;
      }
    }

    const blocked_by = factors.filter((f) => f.outcome === 'fail').map((f) => f.detail);
    const eligible = blocked_by.length === 0;
    const score = round1(factors.reduce((s, f) => s + f.points, 0));
    const positives = factors.filter((f) => f.points > 0 && f.rule_id !== 'builtin:capacity').sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.detail);
    const negatives = factors.filter((f) => f.points < 0).map((f) => f.detail);
    const summary = eligible
      ? [...positives, ...negatives.map((d) => `⚠ ${d}`)].join(' · ') || 'Eligible — no rule favors or penalizes this technician'
      : `Excluded: ${blocked_by.join('; ')}`;

    return { technician_id: tech.id, technician_name: tech.name, eligible, score, rank: null, factors, blocked_by, summary };
  });

  const jobsOf = (id: string) => loads[id]?.jobs ?? 0;
  evaluated.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible) {
      return b.score - a.score || jobsOf(a.technician_id) - jobsOf(b.technician_id) || a.technician_id.localeCompare(b.technician_id);
    }
    return a.blocked_by.length - b.blocked_by.length || a.technician_name.localeCompare(b.technician_name);
  });
  let rank = 0;
  for (const r of evaluated) if (r.eligible) r.rank = ++rank;

  const eligibleOnes = evaluated.filter((r) => r.eligible);
  return {
    ranked: evaluated,
    best: eligibleOnes[0] ?? null,
    margin: eligibleOnes.length >= 2 ? round1(eligibleOnes[0].score - eligibleOnes[1].score) : null,
    rules_applied: rules.length,
  };
}

/** Reduce a day's open jobs to per-technician load, excluding the job being placed. */
export function loadsForDay(
  openJobs: { id: string; technician_id: string; day: string; minutes: number }[],
  day: string,
  excludeJobId: string,
): Record<string, DayLoad> {
  const out: Record<string, DayLoad> = {};
  for (const j of openJobs) {
    if (j.day !== day || j.id === excludeJobId) continue;
    const cur = out[j.technician_id] ?? { jobs: 0, minutes: 0 };
    out[j.technician_id] = { jobs: cur.jobs + 1, minutes: cur.minutes + j.minutes };
  }
  return out;
}

/** Compact, size-bounded snapshot for the decision audit log (top N, factors without noise). */
export function snapshotForAudit(result: RankResult, limit = 5) {
  return result.ranked.slice(0, limit).map((r) => ({
    technician_id: r.technician_id,
    name: r.technician_name,
    eligible: r.eligible,
    rank: r.rank,
    score: r.score,
    summary: r.summary,
    factors: r.factors.filter((f) => f.outcome !== 'neutral').map((f) => ({ label: f.label, outcome: f.outcome, points: f.points, detail: f.detail })),
  }));
}
