import { describe, expect, it } from 'vitest';
import type { Job, ReviewRequest, TeamMember } from '@/lib/supabase';
import { computeSkillGraph } from '@/lib/technicianSkillGraph';
import { SIM_SCORE_MAX, type SimDifficulty } from '@/lib/technicianSimulator';
import { APPRENTICESHIP_LESSONS } from '@/lib/apprenticeshipLessons';
import {
  COMPETENCIES,
  computeApprenticeship,
  estimateLevel,
  inferTrades,
  requiredScore,
  type ApprenticeshipInput,
  type SimEvidenceRow,
} from '@/lib/technicianApprenticeship';

const NOW = new Date('2026-09-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

const tech = {
  id: 't1',
  member_name: 'Sam',
  member_email: 'sam@x.com',
  skills: [],
} as unknown as TeamMember;
const mentor = {
  id: 't2',
  member_name: 'Mia',
  member_email: 'mia@x.com',
  skills: [],
} as unknown as TeamMember;

let jobSeq = 0;
function job(
  techId: string,
  serviceType: string,
  completedDaysAgo: number,
  extra: Partial<Job> = {},
): Job {
  jobSeq += 1;
  return {
    id: `j${jobSeq}`,
    assigned_technician_id: techId,
    service_type: serviceType,
    job_status: 'completed',
    completed_at: daysAgo(completedDaysAgo),
    scheduled_datetime: daysAgo(completedDaysAgo + 0.04),
    duration_minutes: 60,
    is_rework: false,
    rework_of_job_id: null,
    ...extra,
  } as unknown as Job;
}

function sim(
  difficulty: SimDifficulty,
  submittedDaysAgo: number,
  pct = 0.9,
  passed = true,
): SimEvidenceRow {
  const breakdown = Object.fromEntries(
    Object.entries(SIM_SCORE_MAX).map(([k, max]) => [k, Math.round(max * pct)]),
  ) as SimEvidenceRow['breakdown'];
  return {
    technician_id: 't1',
    trade: 'hvac',
    difficulty,
    score: Math.round(pct * 100),
    passed,
    submitted_at: daysAgo(submittedDaysAgo),
    breakdown,
  };
}

function build(
  over: Partial<ApprenticeshipInput> & { jobs?: Job[]; reviews?: ReviewRequest[] } = {},
) {
  const jobs = over.jobs ?? [];
  const reviews = over.reviews ?? [];
  const technicians = [tech, mentor];
  const graph = computeSkillGraph(jobs, reviews, technicians, NOW);
  return computeApprenticeship({
    technician: tech,
    jobs,
    reviews,
    graph,
    simRows: [],
    completedLessonIds: new Set<string>(),
    targetLevel: 3,
    trades: ['hvac'],
    now: NOW,
    ...over,
  });
}

const hvacHistory = (recentClean = 0) => [
  ...Array.from({ length: 6 }, (_, i) => job('t1', 'Refrigerant leak repair', 60 + i)),
  ...Array.from({ length: 6 }, (_, i) => job('t1', 'Furnace repair', 70 + i)),
  ...Array.from({ length: recentClean }, (_, i) =>
    job('t1', i % 2 ? 'Furnace repair' : 'Refrigerant leak repair', 1 + i * 0.1),
  ),
];

const allLessons = new Set(APPRENTICESHIP_LESSONS.map((l) => l.id));

describe('framework', () => {
  it('holds safety at 80 from Journeyman up, and never above the level bar below that', () => {
    const safety = COMPETENCIES.find((c) => c.id === 'safety_compliance')!;
    expect(requiredScore(safety, 2)).toBe(55);
    expect(requiredScore(safety, 3)).toBe(80);
    expect(requiredScore(safety, 4)).toBe(85);
  });

  it('estimates level and blocks Journeyman+ without safety', () => {
    expect(estimateLevel(90, 60)).toBe(2);
    expect(estimateLevel(90, 90)).toBe(4);
    expect(estimateLevel(20, 90)).toBe(0);
  });

  it('covers every competency with at least one lesson', () => {
    for (const c of COMPETENCIES)
      expect(APPRENTICESHIP_LESSONS.some((l) => l.competencyId === c.id)).toBe(true);
  });

  it('infers trades from job history', () => {
    const graph = computeSkillGraph(hvacHistory(), [], [tech, mentor], NOW);
    expect(inferTrades(tech, graph)).toEqual(['hvac']);
  });
});

describe('gap analysis', () => {
  it('reports what is missing, worst first, with unevidenced competencies as gaps', () => {
    const a = build({ jobs: hvacHistory() });
    expect(a.status).toBe('closing_gaps');
    expect(a.readiness).toBeLessThan(a.targetReadiness);
    expect(a.gapPoints).toBeGreaterThan(0);
    const ids = a.gaps.map((g) => g.id);
    expect(ids).toContain('safety_compliance');
    expect(a.gaps.find((g) => g.id === 'safety_compliance')!.critical).toBe(true);
    expect(a.gaps.find((g) => g.id === 'safety_compliance')!.score).toBeNull();
    for (let i = 1; i < a.gaps.length; i++)
      expect(a.gaps[i - 1].impactPoints).toBeGreaterThanOrEqual(a.gaps[i].impactPoints);
  });

  it('only scopes technical competencies to the selected trades', () => {
    const a = build({ jobs: hvacHistory(), trades: ['electrical'] });
    expect(a.competencies.some((c) => c.id === 'electrical_fault')).toBe(true);
    expect(a.competencies.some((c) => c.id === 'hvac_refrigerant')).toBe(false);
  });

  it('starts every pathway at the first unfinished stage', () => {
    const a = build({ jobs: hvacHistory() });
    const p = a.pathways.find((x) => x.competencyId === 'diagnostic_reasoning')!;
    expect(p.stages.map((s) => s.id)).toEqual([
      'job',
      'learning',
      'simulation',
      'assessment',
      'certification',
      'real_job',
    ]);
    expect(p.stages.filter((s) => s.state === 'active')).toHaveLength(1);
    expect(a.next).not.toBeNull();
  });

  it('suggests the strongest teammate as mentor for a technical gap', () => {
    const jobs = [
      ...Array.from({ length: 6 }, (_, i) => job('t2', 'Refrigerant leak repair', 40 + i)),
      ...hvacHistory().slice(6),
    ];
    const a = build({ jobs });
    const p = a.pathways.find((x) => x.competencyId === 'hvac_refrigerant')!;
    expect(p.mentor?.name).toBe('Mia');
    expect(p.stages[0].state).toBe('active');
  });
});

describe('certification pipeline', () => {
  const strongSims = (difficulty: SimDifficulty) => [
    sim(difficulty, 12),
    sim(difficulty, 11),
    sim(difficulty, 10),
  ];

  it('needs an assessment at the level difficulty even when scores are strong', () => {
    const a = build({
      jobs: hvacHistory(),
      simRows: strongSims('foundation'),
      completedLessonIds: allLessons,
    });
    expect(a.gaps).toHaveLength(0);
    expect(a.status).toBe('needs_assessment');
  });

  it('moves to proving on real jobs once assessed', () => {
    const a = build({
      jobs: hvacHistory(),
      simRows: strongSims('professional'),
      completedLessonIds: allLessons,
    });
    expect(a.status).toBe('proving_on_jobs');
    const p = a.pathways.find((x) => x.competencyId === 'hvac_refrigerant')!;
    expect(p.stages.find((s) => s.id === 'certification')!.state).toBe('done');
    expect(p.activeStage).toBe('real_job');
  });

  it('certifies after clean, well-rated jobs following the assessment', () => {
    const a = build({
      jobs: hvacHistory(6),
      simRows: strongSims('professional'),
      completedLessonIds: allLessons,
    });
    expect(a.status).toBe('certified');
    expect(a.next).toBeNull();
    expect(a.stageProgressPct).toBe(100);
  });

  it('does not count reworked or low-rated jobs as proof', () => {
    const jobs = hvacHistory(6);
    const recent = jobs.slice(12);
    const reviews = recent.map((j) => ({ job_id: j.id, rating: 2 }) as unknown as ReviewRequest);
    const a = build({
      jobs,
      reviews,
      simRows: strongSims('professional'),
      completedLessonIds: allLessons,
    });
    expect(a.status).not.toBe('certified');
  });

  it('never lets learning alone certify anyone', () => {
    const a = build({ jobs: hvacHistory(6), completedLessonIds: allLessons });
    expect(a.status).toBe('closing_gaps');
  });

  it('ignores failed attempts as assessments', () => {
    const rows = [sim('professional', 5, 0.9, false), sim('professional', 4, 0.9, false)];
    const a = build({ jobs: hvacHistory(), simRows: rows, completedLessonIds: allLessons });
    const p = a.pathways.find((x) => x.competencyId === 'hvac_refrigerant')!;
    expect(p.stages.find((s) => s.id === 'assessment')!.state).not.toBe('done');
  });
});
