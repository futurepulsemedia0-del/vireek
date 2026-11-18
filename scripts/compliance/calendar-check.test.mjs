import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_OVERDUE,
  REPO_ROOT,
  dayNumber,
  evaluateReviews,
  isSafeRelativePath,
  loadCalendar,
  parseArgs,
  renderIssueBody,
  renderMarkdown,
  run,
  validateCalendar,
} from './calendar-check.mjs';

const entry = (o = {}) => ({
  id: 'sample-law',
  regulation: 'Sample Law',
  category: 'privacy',
  jurisdiction: 'US',
  applies_to_features: ['Feature A'],
  owner: 'jane-doe',
  flags: ['[COUNSEL]'],
  last_reviewed: null,
  next_review: '2026-12-15',
  sources: [{ path: 'docs/x.md', quote: 'Sample Law' }],
  ...o,
});
// One valid entry per category so the "every category covered" rule passes.
const cal = (over = {}) => ({
  schema: 'vireek.regulatory-calendar/v1',
  disclaimer: 'Not legal advice.',
  entries: CATEGORIES.map((c) => entry({ id: `law-${c}`, category: c })),
  ...over,
});
const readText = (p) => (p === 'docs/x.md' ? 'text mentioning Sample Law here' : null);
const check = (c, o = {}) => validateCalendar(c, { readText, today: '2026-11-12', ...o });
const withEntry = (patch, i = 0) => {
  const c = cal();
  c.entries[i] = entry({ id: c.entries[i].id, category: c.entries[i].category, ...patch });
  return c;
};

describe('dayNumber', () => {
  it('accepts real dates and rejects impossible or malformed ones', () => {
    expect(dayNumber('2026-11-12')).toBeGreaterThan(0);
    expect(dayNumber('2028-02-29')).not.toBeNull();
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-1', '26-11-12', '', null, undefined, 20261112]) {
      expect(dayNumber(bad)).toBeNull();
    }
  });
  it('is one apart for consecutive days across a month boundary', () => {
    expect(dayNumber('2026-12-01') - dayNumber('2026-11-30')).toBe(1);
  });
});

describe('validateCalendar', () => {
  it('accepts a well-formed calendar', () => {
    expect(check(cal()).errors).toEqual([]);
  });
  it('rejects a wrong schema, missing disclaimer and empty entries', () => {
    expect(check(cal({ schema: 'x' })).errors.join('\n')).toContain('schema');
    expect(check(cal({ disclaimer: '' })).errors.join('\n')).toContain('disclaimer');
    expect(check(cal({ entries: [] })).errors.join('\n')).toContain('non-empty');
    expect(check(null).errors).toHaveLength(1);
  });
  it('requires every category to be covered', () => {
    const c = cal();
    c.entries = c.entries.filter((e) => e.category !== 'labor');
    expect(check(c).errors.join('\n')).toContain('category "labor"');
  });
  it('rejects duplicate ids, bad ids and unknown fields', () => {
    const c = cal();
    c.entries[1] = entry({ id: c.entries[0].id, category: 'ai' });
    expect(check(c).errors.join('\n')).toContain('duplicate id');
    expect(check(withEntry({ id: 'Bad_ID' })).errors.join('\n')).toContain('id must match');
    expect(check(withEntry({ surprise: 1 })).errors.join('\n')).toContain('unknown field "surprise"');
  });
  it('requires [COUNSEL] in flags and rejects unknown flags', () => {
    expect(check(withEntry({ flags: [] })).errors.join('\n')).toContain('[COUNSEL]');
    expect(check(withEntry({ flags: ['[VERIFY]'] })).errors.join('\n')).toContain('[COUNSEL]');
    expect(check(withEntry({ flags: ['[COUNSEL]', '[OK]'] })).errors.join('\n')).toContain('only');
    expect(check(withEntry({ flags: ['[COUNSEL]', '[VERIFY]'] })).errors).toEqual([]);
  });
  it('validates dates, review ordering and last_reviewed_by', () => {
    expect(check(withEntry({ next_review: '2026-02-30' })).errors.join('\n')).toContain('next_review');
    expect(check(withEntry({ last_reviewed: 'yesterday' })).errors.join('\n')).toContain('last_reviewed');
    const missing = withEntry({});
    delete missing.entries[0].last_reviewed;
    expect(check(missing).errors.join('\n')).toContain('last_reviewed is required');
    expect(check(withEntry({ last_reviewed: '2026-11-01', next_review: '2026-10-01', last_reviewed_by: 'counsel' })).errors.join('\n')).toContain('before last_reviewed');
    expect(check(withEntry({ last_reviewed: '2026-11-01', next_review: '2027-05-01' })).errors.join('\n')).toContain('last_reviewed_by');
    expect(check(withEntry({ last_reviewed: '2027-01-01', next_review: '2027-05-01', last_reviewed_by: 'counsel' })).errors.join('\n')).toContain('in the future');
    expect(check(withEntry({ last_reviewed: '2026-11-01', next_review: '2027-05-01', last_reviewed_by: 'counsel' })).errors).toEqual([]);
    expect(check(withEntry({ last_reviewed_by: 'counsel' })).errors.join('\n')).toContain('last_reviewed_by must be absent');
  });
  it('validates review_interval_days and applies_to_features', () => {
    expect(check(withEntry({ review_interval_days: 3 })).errors.join('\n')).toContain('review_interval_days');
    expect(check(withEntry({ review_interval_days: 90 })).errors).toEqual([]);
    expect(check(withEntry({ applies_to_features: [] })).errors.join('\n')).toContain('applies_to_features');
  });
  it('requires sources that really exist in repo docs', () => {
    expect(check(withEntry({ sources: [] })).errors.join('\n')).toContain('sources');
    expect(check(withEntry({ sources: [{ path: 'docs/missing.md', quote: 'x' }] })).errors.join('\n')).toContain('does not exist');
    expect(check(withEntry({ sources: [{ path: 'docs/x.md', quote: 'Not In The Doc' }] })).errors.join('\n')).toContain('not found');
    expect(check(withEntry({ sources: [{ path: 'docs/x.md', quote: '' }] })).errors.join('\n')).toContain('quote is required');
  });
  it('rejects unsafe source paths', () => {
    for (const p of ['../secrets.env', '/etc/passwd', 'docs//x.md', 'docs\\x.md']) {
      expect(isSafeRelativePath(p)).toBe(false);
      expect(check(withEntry({ sources: [{ path: p, quote: 'x' }] })).errors.join('\n')).toContain('safe repo-relative path');
    }
    expect(isSafeRelativePath('docs/x.md')).toBe(true);
  });
  it('treats @OWNER_ placeholders as a warning, or an error with strict', () => {
    const c = withEntry({ owner: '@OWNER_COMPLIANCE' });
    expect(check(c).errors).toEqual([]);
    expect(check(c).warnings.join('\n')).toContain('placeholder');
    expect(check(c, { strict: true }).errors.join('\n')).toContain('placeholder');
  });
});

describe('evaluateReviews', () => {
  const mk = (id, next) => entry({ id, next_review: next });
  it('is overdue only when next_review is strictly before today', () => {
    const r = evaluateReviews([mk('a-law', '2026-11-11'), mk('b-law', '2026-11-12')], '2026-11-12');
    expect(r.overdue.map((e) => e.id)).toEqual(['a-law']);
    expect(r.overdue[0].daysOverdue).toBe(1);
    expect(r.dueSoon.map((e) => e.id)).toEqual(['b-law']);
  });
  it('flags due-soon inside the window and ignores later reviews', () => {
    const r = evaluateReviews([mk('a-law', '2026-11-26'), mk('b-law', '2026-11-27')], '2026-11-12', 14);
    expect(r.dueSoon.map((e) => e.id)).toEqual(['a-law']);
    expect(r.overdue).toEqual([]);
  });
  it('sorts by date then id and survives month/year boundaries', () => {
    const r = evaluateReviews([mk('z-law', '2026-12-31'), mk('b-law', '2026-12-31'), mk('a-law', '2026-12-30')], '2027-01-02');
    expect(r.overdue.map((e) => e.id)).toEqual(['a-law', 'b-law', 'z-law']);
    expect(r.overdue[0].daysOverdue).toBe(3);
  });
  it('throws on an invalid today', () => {
    expect(() => evaluateReviews([], 'nope')).toThrow();
  });
});

describe('rendering', () => {
  it('is deterministic and escapes table pipes', () => {
    const c = cal();
    c.entries[0].regulation = 'A | B';
    expect(renderMarkdown(c)).toBe(renderMarkdown(c));
    expect(renderMarkdown(c)).toContain('A \\| B');
    expect(renderMarkdown(c)).toContain('GENERATED from docs/compliance/regulatory-calendar.json');
  });
  it('builds an issue body listing overdue and due-soon entries', () => {
    const r = evaluateReviews([entry({ id: 'old-law', next_review: '2026-11-01' }), entry({ id: 'soon-law', next_review: '2026-11-20' })], '2026-11-12');
    const body = renderIssueBody(r, '2026-11-12');
    expect(body).toContain('1 review(s) overdue');
    expect(body).toContain('old-law');
    expect(body).toContain('11 day(s) overdue');
    expect(body).toContain('soon-law');
  });
});

describe('parseArgs', () => {
  it('parses flags and reports bad input', () => {
    expect(parseArgs(['--write', '--strict', '--today', '2026-11-12', '--warn-days', '30']).warnDays).toBe(30);
    expect(parseArgs(['--today', '2026-02-30']).errors.join()).toContain('--today');
    expect(parseArgs(['--warn-days', 'x']).errors.join()).toContain('--warn-days');
    expect(parseArgs(['--report-file']).errors.join()).toContain('needs a value');
    expect(parseArgs(['--nope']).errors.join()).toContain('unknown argument');
  });
});

describe('the real registry in this repository', () => {
  const real = loadCalendar();
  it('validates (all sources exist in the docs, all six categories covered)', () => {
    expect(validateCalendar(real, { today: '2026-11-12' }).errors).toEqual([]);
  });
  it('marks every entry [COUNSEL] and has no review in the past at seed time', () => {
    expect(real.entries.every((e) => e.flags.includes('[COUNSEL]'))).toBe(true);
    expect(evaluateReviews(real.entries, '2026-11-12').overdue).toEqual([]);
  });
  it('has a readable .md that is exactly the rendering of the JSON', () => {
    expect(readFileSync(join(REPO_ROOT, 'docs/compliance/regulatory-calendar.md'), 'utf8')).toBe(renderMarkdown(real));
  });
});

describe('CLI run() against a temp copy of the registry', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-'));
    cpSync(join(REPO_ROOT, 'docs'), join(root, 'docs'), { recursive: true });
    return root;
  };
  const exec = (root, args) => {
    const out = [];
    const errs = [];
    const code = run(args, { root, log: (m) => out.push(m), err: (m) => errs.push(m) });
    return { code, out: out.join('\n'), err: errs.join('\n') };
  };

  it('passes before the first review date', () => {
    const root = setup();
    try {
      expect(exec(root, ['--today', '2026-11-12']).code).toBe(EXIT_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('exits 3 and writes an issue body once a review is overdue', () => {
    const root = setup();
    try {
      const report = join(root, 'issue.md');
      const r = exec(root, ['--today', '2026-12-03', '--report-file', report]);
      expect(r.code).toBe(EXIT_OVERDUE);
      expect(r.out).toContain('OVERDUE: eu-ai-act-art50');
      expect(readFileSync(report, 'utf8')).toContain('eu-ai-act-art50');
      expect(exec(root, ['--today', '2026-12-03', '--allow-overdue']).code).toBe(EXIT_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('--json reports overdue ids', () => {
    const root = setup();
    try {
      const r = exec(root, ['--today', '2027-01-01', '--json']);
      expect(r.code).toBe(EXIT_OVERDUE);
      expect(JSON.parse(r.out).overdue.length).toBe(30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('exits 1 when the .md is stale, and --write repairs it', () => {
    const root = setup();
    try {
      writeFileSync(join(root, 'docs/compliance/regulatory-calendar.md'), 'stale');
      const stale = exec(root, ['--today', '2026-11-12']);
      expect(stale.code).toBe(EXIT_INVALID);
      expect(stale.err).toContain('stale');
      expect(exec(root, ['--today', '2026-11-12', '--write']).code).toBe(EXIT_OK);
      expect(exec(root, ['--today', '2026-11-12']).code).toBe(EXIT_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('exits 1 on a broken registry, a cited-text mismatch, and malformed JSON', () => {
    const root = setup();
    try {
      const p = join(root, 'docs/compliance/regulatory-calendar.json');
      const good = JSON.parse(readFileSync(p, 'utf8'));
      good.entries[0].sources[0].quote = 'text that is not in the doc';
      writeFileSync(p, JSON.stringify(good));
      expect(exec(root, ['--today', '2026-11-12']).code).toBe(EXIT_INVALID);
      writeFileSync(p, '{ not json');
      const r = exec(root, ['--today', '2026-11-12']);
      expect(r.code).toBe(EXIT_INVALID);
      expect(r.err).toContain('cannot read');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('exits 1 on bad usage and on --strict while owners are placeholders', () => {
    const root = setup();
    try {
      expect(exec(root, ['--bogus']).code).toBe(EXIT_INVALID);
      expect(exec(root, ['--today', '2026-11-12', '--strict']).code).toBe(EXIT_INVALID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('executable entry point', () => {
  it('runs as a script and returns the overdue exit code', () => {
    const script = join(REPO_ROOT, 'scripts/compliance/calendar-check.mjs');
    const ok = spawnSync(process.execPath, [script, '--today', '2026-11-12'], { encoding: 'utf8' });
    expect(ok.status).toBe(EXIT_OK);
    const late = spawnSync(process.execPath, [script, '--today', '2027-06-01'], { encoding: 'utf8' });
    expect(late.status).toBe(EXIT_OVERDUE);
    expect(late.stdout).toContain('OVERDUE');
  });
});
