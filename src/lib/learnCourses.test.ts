import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  courseProgress, getCourse, getModule, isLearnRole, LEARN_COURSES, LEARN_ROLES, PASS_PCT, recommendedCourse, scoreModule,
} from './learnCourses';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const appSource = read('src/App.tsx');
const en = JSON.parse(read('src/locales/en/learn.json')) as { courses: Record<string, string> };

describe('course data integrity', () => {
  it('has one course per role with unique module ids across all courses', () => {
    expect(LEARN_COURSES.map((c) => c.slug).sort()).toEqual([...LEARN_ROLES].sort());
    const ids = LEARN_COURSES.flatMap((c) => c.modules.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,64}$/); // same rule as the DB CHECK
  });

  it('every question is well-formed', () => {
    for (const c of LEARN_COURSES) for (const m of c.modules) {
      expect(m.questions.length, `${m.id} has questions`).toBeGreaterThan(0);
      expect(m.objectives.length).toBeGreaterThan(0);
      expect(m.steps.length).toBeGreaterThan(0);
      const qids = m.questions.map((q) => q.id);
      expect(new Set(qids).size).toBe(qids.length);
      for (const q of m.questions) {
        expect(q.options.length, `${m.id}/${q.id}`).toBeGreaterThanOrEqual(2);
        expect(new Set(q.options).size, `${m.id}/${q.id} duplicate options`).toBe(q.options.length);
        expect(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length, `${m.id}/${q.id} correct index`).toBe(true);
        expect(q.explain.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('every module points at a real route in App.tsx', () => {
    for (const c of LEARN_COURSES) for (const m of c.modules) expect(appSource, `${m.id} → ${m.route}`).toContain(`path="${m.route}"`);
  });

  it('every course has a translated title', () => {
    for (const c of LEARN_COURSES) expect(en.courses[c.slug], c.slug).toBeTruthy();
  });

  it('can find courses and modules, and rejects unknown ones', () => {
    expect(getCourse('owner')?.slug).toBe('owner');
    expect(getModule('technician', 'tech-today')?.route).toBe('/tech/today');
    expect(getModule('owner', 'tech-today')).toBeUndefined();
    expect(isLearnRole('admin')).toBe(false);
  });
});

describe('docs/academy stays in sync with the data', () => {
  for (const c of LEARN_COURSES) {
    it(`${c.slug}-course.md lists every module, route, question and answer`, () => {
      const doc = read(`docs/academy/${c.slug}-course.md`);
      expect(doc).toContain(`# ${c.title}`);
      c.modules.forEach((m, i) => {
        expect(doc, `${m.id} heading`).toContain(`## Module ${i + 1}: ${m.title}`);
        expect(doc, `${m.id} route`).toContain(`\`${m.route}\``);
        expect(doc, `${m.id} id`).toContain(`\`${m.id}\``);
        m.questions.forEach((q, k) => {
          expect(doc, `${m.id}/${q.id} prompt`).toContain(`**${i + 1}.${k + 1}** ${q.prompt}`);
          for (const opt of q.options) expect(doc).toContain(opt);
          expect(doc, `${m.id}/${q.id} answer key`).toContain(`| ${i + 1}.${k + 1} | ${'ABCD'[q.correct]} | ${q.explain} |`);
        });
      });
      expect(doc).toContain('## Completion record');
    });
  }
});

describe('scoreModule', () => {
  const mod = getModule('dispatcher', 'dispatch-board')!; // 3 questions
  const allRight = mod.questions.map((q) => q.correct);

  it('passes at 100%', () => expect(scoreModule(mod, allRight)).toMatchObject({ correct: 3, total: 3, pct: 100, passed: true, wrongQuestionIds: [] }));
  it('fails below the pass mark and lists wrong questions', () => {
    const wrong = [...allRight]; wrong[0] = (wrong[0] + 1) % mod.questions[0].options.length;
    const s = scoreModule(mod, wrong);
    expect(s).toMatchObject({ correct: 2, pct: 67, passed: false, wrongQuestionIds: ['q1'] });
  });
  it('counts unanswered as wrong', () => expect(scoreModule(mod, [null, undefined]).pct).toBe(0));
  it('PASS_PCT is 80 and mirrored in the SQL function', () => {
    expect(PASS_PCT).toBe(80);
    expect(read('supabase/migrations/20290308000000_learn_completions.sql')).toContain('p_score_pct < 80');
  });
  it('a module with no questions can never pass', () => {
    expect(scoreModule({ ...mod, questions: [] }, []).passed).toBe(false);
  });
});

describe('courseProgress / recommendedCourse', () => {
  const course = getCourse('owner')!;
  it('computes progress from completed module ids and ignores foreign ids', () => {
    expect(courseProgress(course, new Set())).toEqual({ completed: 0, total: 4, percent: 0, done: false });
    expect(courseProgress(course, new Set(['owner-team-permissions', 'tech-today']))).toMatchObject({ completed: 1, percent: 25, done: false });
    expect(courseProgress(course, new Set(course.modules.map((m) => m.id)))).toMatchObject({ percent: 100, done: true });
  });
  it('recommends by role heuristics', () => {
    expect(recommendedCourse({ isOwner: true, canViewAllJobs: false, canManageTeam: false })).toBe('owner');
    expect(recommendedCourse({ isOwner: false, canViewAllJobs: true, canManageTeam: false })).toBe('dispatcher');
    expect(recommendedCourse({ isOwner: false, canViewAllJobs: false, canManageTeam: true })).toBe('dispatcher');
    expect(recommendedCourse({ isOwner: false, canViewAllJobs: false, canManageTeam: false })).toBe('technician');
  });
});
