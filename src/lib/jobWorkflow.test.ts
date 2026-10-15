import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AT_RISK_RATIO,
  DEFAULT_WORKFLOW_POLICIES,
  OTHER_REASON,
  RESUME_TARGETS,
  WORKFLOW_STATUSES,
  WORKFLOW_STATUS_BADGE,
  WORKFLOW_STATUS_DOT,
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_OPTIONS,
  WORKFLOW_STATUS_TRANSITIONS,
  computeSla,
  describePolicy,
  emptyWorkflowBuckets,
  formatDuration,
  holdAge,
  indexHoldsByJob,
  isWorkflowReasonError,
  isWorkflowRpcStatus,
  isWorkflowStatus,
  reasonLabel,
  reasonsFor,
  suggestResumeStatus,
  summarizeHolds,
  validateHoldInput,
  type JobHold,
  type WorkflowStatus,
} from './jobWorkflow';

const NOW = new Date('2027-06-10T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const H = 3_600_000;
const D = 24 * H;

function hold(over: Partial<JobHold> = {}): JobHold {
  return {
    id: 'h1',
    user_id: 'u1',
    job_id: 'j1',
    status: 'waiting_on_parts',
    reason_code: 'part_ordered',
    reason_note: null,
    previous_status: 'in_progress',
    expected_resume_at: null,
    started_at: iso(-1 * D),
    sla_minutes: 4320,
    sla_due_at: iso(2 * D),
    sla_breached_at: null,
    reminders_sent: 0,
    max_reminders: 5,
    next_reminder_at: null,
    last_reminded_at: null,
    resolved_at: null,
    resolved_to_status: null,
    resolution_note: null,
    created_at: iso(-1 * D),
    ...over,
  };
}

describe('workflow statuses', () => {
  it('exposes exactly the five new statuses and never the legacy ones', () => {
    expect([...WORKFLOW_STATUSES]).toEqual(['on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed']);
    for (const legacy of ['scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show']) {
      expect(isWorkflowStatus(legacy)).toBe(false);
    }
  });

  it('isWorkflowStatus rejects non-strings and unknown values', () => {
    expect(isWorkflowStatus('on_hold')).toBe(true);
    expect(isWorkflowStatus('ON_HOLD')).toBe(false);
    expect(isWorkflowStatus(undefined)).toBe(false);
    expect(isWorkflowStatus(null)).toBe(false);
    expect(isWorkflowStatus(3)).toBe(false);
  });

  it('provides label/dot/badge/transition/option entries for every status', () => {
    for (const s of WORKFLOW_STATUSES) {
      expect(WORKFLOW_STATUS_LABELS[s]).toBeTruthy();
      expect(WORKFLOW_STATUS_DOT[s]).toMatch(/^bg-/);
      expect(WORKFLOW_STATUS_BADGE[s]).toBeTruthy();
      expect(WORKFLOW_STATUS_TRANSITIONS[s]).toContain('scheduled');
      expect(WORKFLOW_STATUS_OPTIONS.some((o) => o.key === s)).toBe(true);
    }
  });

  it('only allows the way OUT of a hold without a dialog, and never into another workflow status', () => {
    for (const s of WORKFLOW_STATUSES) {
      for (const target of WORKFLOW_STATUS_TRANSITIONS[s]) expect(isWorkflowStatus(target)).toBe(false);
    }
  });

  it('emptyWorkflowBuckets returns independent arrays', () => {
    const a = emptyWorkflowBuckets();
    const b = emptyWorkflowBuckets();
    (a.on_hold as unknown[]).push(1);
    expect(b.on_hold).toHaveLength(0);
    expect(Object.keys(a)).toEqual([...WORKFLOW_STATUSES]);
  });

  it('resume targets are live statuses only', () => {
    expect([...RESUME_TARGETS]).toEqual(['scheduled', 'en_route', 'in_progress']);
  });
});

describe('reasons', () => {
  it('every status has reasons and "Other" is always last', () => {
    for (const s of WORKFLOW_STATUSES) {
      const list = reasonsFor(s);
      expect(list.length).toBeGreaterThan(1);
      expect(list[list.length - 1].code).toBe(OTHER_REASON);
      expect(new Set(list.map((r) => r.code)).size).toBe(list.length);
    }
  });

  it('labels known codes and falls back to a readable form for unknown ones', () => {
    expect(reasonLabel('waiting_on_parts', 'part_backordered')).toBe('Part back-ordered');
    expect(reasonLabel('on_hold', 'something_new')).toBe('something new');
  });
});

describe('validateHoldInput', () => {
  const base = { status: 'on_hold' as WorkflowStatus, reasonCode: 'weather', note: '', expectedResumeAt: '' };

  it('accepts a valid hold and trims the note', () => {
    const r = validateHoldInput({ ...base, note: '  rain delay  ' }, NOW);
    expect(r).toEqual({ ok: true, value: { status: 'on_hold', reasonCode: 'weather', note: 'rain delay', expectedResumeAt: null } });
  });

  it('requires a status and a reason', () => {
    expect(validateHoldInput({ ...base, status: null }, NOW)).toMatchObject({ ok: false, errors: { status: expect.any(String) } });
    expect(validateHoldInput({ ...base, reasonCode: '' }, NOW)).toMatchObject({ ok: false, errors: { reason: 'A reason is required.' } });
  });

  it('rejects a reason that belongs to a different status', () => {
    const r = validateHoldInput({ ...base, reasonCode: 'part_ordered' }, NOW);
    expect(r).toMatchObject({ ok: false, errors: { reason: expect.stringMatching(/valid reason/) } });
  });

  it('"Other" needs a real note (3+ characters after trimming)', () => {
    expect(validateHoldInput({ ...base, reasonCode: OTHER_REASON, note: '  ' }, NOW)).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(validateHoldInput({ ...base, reasonCode: OTHER_REASON, note: 'ab' }, NOW)).toMatchObject({ ok: false });
    expect(validateHoldInput({ ...base, reasonCode: OTHER_REASON, note: 'abc' }, NOW)).toMatchObject({ ok: true });
  });

  it('caps the note at 1000 characters', () => {
    expect(validateHoldInput({ ...base, note: 'x'.repeat(1001) }, NOW)).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(validateHoldInput({ ...base, note: 'x'.repeat(1000) }, NOW)).toMatchObject({ ok: true });
  });

  it('validates the expected-resume time', () => {
    expect(validateHoldInput({ ...base, expectedResumeAt: 'nonsense' }, NOW)).toMatchObject({ ok: false, errors: { resume: expect.any(String) } });
    expect(validateHoldInput({ ...base, expectedResumeAt: iso(-2 * H) }, NOW)).toMatchObject({ ok: false, errors: { resume: expect.any(String) } });
    const ok = validateHoldInput({ ...base, expectedResumeAt: iso(3 * H) }, NOW);
    expect(ok).toMatchObject({ ok: true, value: { expectedResumeAt: iso(3 * H) } });
  });

  it('reports several problems at once', () => {
    const r = validateHoldInput({ status: 'on_hold', reasonCode: OTHER_REASON, note: '', expectedResumeAt: 'bad' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['note', 'resume']);
  });
});

describe('SLA', () => {
  it('is "none" without a due time', () => {
    expect(computeSla(hold({ sla_due_at: null }), NOW)).toMatchObject({ state: 'none', remainingMs: null, label: 'No SLA' });
  });

  it('is on track early in the window', () => {
    const sla = computeSla(hold({ started_at: iso(-1 * H), sla_due_at: iso(23 * H) }), NOW);
    expect(sla.state).toBe('on_track');
    expect(sla.label).toBe('23h left');
  });

  it('is at risk once 75% of the window is used', () => {
    const start = iso(-76 * H);
    const due = iso(24 * H); // 100h window, 76% used
    expect(computeSla(hold({ started_at: start, sla_due_at: due }), NOW).state).toBe('at_risk');
    const justBelow = computeSla(hold({ started_at: iso(-74 * H), sla_due_at: iso(26 * H) }), NOW);
    expect(justBelow.state).toBe('on_track');
    expect(AT_RISK_RATIO).toBe(0.75);
  });

  it('is breached after the due time and says by how much', () => {
    const sla = computeSla(hold({ started_at: iso(-3 * D), sla_due_at: iso(-5 * H) }), NOW);
    expect(sla.state).toBe('breached');
    expect(sla.remainingMs).toBe(-5 * H);
    expect(sla.label).toBe('Overdue by 5h');
  });

  it('freezes the clock when the hold was resolved', () => {
    const resolvedInTime = computeSla(hold({ started_at: iso(-3 * D), sla_due_at: iso(-1 * D), resolved_at: iso(-2 * D) }), NOW);
    expect(resolvedInTime.state).toBe('on_track');
    const resolvedLate = computeSla(hold({ started_at: iso(-3 * D), sla_due_at: iso(-2 * D), resolved_at: iso(-1 * D) }), NOW);
    expect(resolvedLate.state).toBe('breached');
  });

  it('tolerates garbage dates', () => {
    expect(computeSla(hold({ sla_due_at: 'x' }), NOW).state).toBe('none');
  });

  it('is exactly due at the boundary (not yet breached)', () => {
    expect(computeSla(hold({ started_at: iso(-1 * D), sla_due_at: NOW.toISOString() }), NOW).state).toBe('at_risk');
  });
});

describe('formatting', () => {
  it('formats durations with the two largest units', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_000)).toBe('<1m');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(5 * H + 10 * 60_000)).toBe('5h 10m');
    expect(formatDuration(5 * H)).toBe('5h');
    expect(formatDuration(3 * D + 4 * H + 30 * 60_000)).toBe('3d 4h');
    expect(formatDuration(2 * D)).toBe('2d');
    expect(formatDuration(-5000)).toBe('<1m');
  });

  it('formats hold age', () => {
    expect(holdAge({ started_at: iso(-26 * H) }, NOW)).toBe('1d 2h');
  });

  it('describes a policy in plain language', () => {
    expect(describePolicy(DEFAULT_WORKFLOW_POLICIES.waiting_on_parts)).toBe('Resolve within 5 days · reminder after 1 day, then every 1 day');
    expect(describePolicy(DEFAULT_WORKFLOW_POLICIES.needs_follow_up)).toBe('Resolve within 1 day · reminder after 4 hours, then every 8 hours');
    expect(describePolicy({ ...DEFAULT_WORKFLOW_POLICIES.on_hold, enabled: false })).toBe('Resolve within 3 days · no reminders');
    expect(describePolicy({ slaMinutes: null, remindAfterMinutes: null, remindEveryMinutes: null, maxReminders: 0, enabled: true })).toBe('No SLA timer · no reminders');
  });
});

describe('holds helpers', () => {
  it('indexes only OPEN holds by job', () => {
    const open = hold({ id: 'a', job_id: 'j1' });
    const closed = hold({ id: 'b', job_id: 'j2', resolved_at: iso(-H) });
    const map = indexHoldsByJob([open, closed]);
    expect(map.get('j1')?.id).toBe('a');
    expect(map.has('j2')).toBe(false);
  });

  it('summarizes open holds by status and SLA health', () => {
    const holds = [
      hold({ id: '1', job_id: 'a', status: 'on_hold' }),
      hold({ id: '2', job_id: 'b', status: 'waiting_on_parts', started_at: iso(-3 * D), sla_due_at: iso(-1 * H) }),
      hold({ id: '3', job_id: 'c', status: 'waiting_on_parts', started_at: iso(-76 * H), sla_due_at: iso(24 * H) }),
      hold({ id: '4', job_id: 'd', status: 'needs_follow_up', resolved_at: iso(-H) }),
    ];
    const s = summarizeHolds(holds, NOW);
    expect(s.total).toBe(3);
    expect(s.breached).toBe(1);
    expect(s.atRisk).toBe(1);
    expect(s.byStatus).toMatchObject({ on_hold: 1, waiting_on_parts: 2, needs_follow_up: 0 });
  });

  it('resumes to in_progress only when the job was in progress before', () => {
    expect(suggestResumeStatus('in_progress')).toBe('in_progress');
    expect(suggestResumeStatus('en_route')).toBe('scheduled');
    expect(suggestResumeStatus('scheduled')).toBe('scheduled');
    expect(suggestResumeStatus(null)).toBe('scheduled');
    expect(suggestResumeStatus(undefined)).toBe('scheduled');
  });
});

describe('error detection', () => {
  it('recognises the database refusal for a missing reason', () => {
    expect(isWorkflowReasonError('JOB_WORKFLOW_REASON_REQUIRED: a reason is required to move this job to on_hold')).toBe(true);
    expect(isWorkflowReasonError('something else')).toBe(false);
    expect(isWorkflowReasonError(null)).toBe(false);
    expect(isWorkflowReasonError(undefined)).toBe(false);
  });

  it('recognises RPC statuses', () => {
    for (const s of ['ok', 'unchanged', 'invalid', 'invalid_transition', 'forbidden', 'not_found', 'slot_conflict']) {
      expect(isWorkflowRpcStatus(s)).toBe(true);
    }
    expect(isWorkflowRpcStatus('weird')).toBe(false);
    expect(isWorkflowRpcStatus(1)).toBe(false);
  });
});

// ------------------------------------------------------------
// Contract with the migration: the TypeScript and SQL halves must agree.
// ------------------------------------------------------------
describe('migration contract', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270610000000_job_workflow_statuses.sql'), 'utf8');
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

  it('lists the same statuses', () => {
    const fn = /FUNCTION public\.is_job_workflow_status[\s\S]*?\$\$;/.exec(sql)?.[0] ?? '';
    const found = [...fn.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(found.sort()).toEqual([...WORKFLOW_STATUSES].sort());
  });

  it('lists the same reason codes for every status', () => {
    const fn = /FUNCTION public\.is_job_workflow_reason_valid[\s\S]*?\$\$;/.exec(sql)?.[0] ?? '';
    for (const status of WORKFLOW_STATUSES) {
      const block = new RegExp(`WHEN '${status}' THEN ARRAY\\[([^\\]]*)\\]`).exec(fn)?.[1] ?? '';
      const codes = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      const expected = reasonsFor(status).filter((r) => r.code !== OTHER_REASON).map((r) => r.code);
      expect(codes.sort(), status).toEqual(expected.sort());
    }
  });

  it('uses the same default SLA / reminder policy', () => {
    for (const status of WORKFLOW_STATUSES) {
      const row = new RegExp(`\\('${status}',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`).exec(sql);
      expect(row, status).not.toBeNull();
      const p = DEFAULT_WORKFLOW_POLICIES[status];
      expect([Number(row![1]), Number(row![2]), Number(row![3]), Number(row![4])]).toEqual([
        p.slaMinutes,
        p.remindAfterMinutes,
        p.remindEveryMinutes,
        p.maxReminders,
      ]);
    }
  });

  it('is additive only — no destructive statements, legacy status column untouched', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE|DATABASE)/i);
    expect(code).not.toMatch(/TRUNCATE/i);
    expect(code).not.toMatch(/ALTER\s+TABLE\s+jobs/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN/i);
    expect(code).not.toMatch(/RENAME/i);
  });

  it('enables RLS on both new tables and pins search_path on every SECURITY DEFINER function', () => {
    expect(sql).toMatch(/ALTER TABLE job_holds ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE job_workflow_policies ENABLE ROW LEVEL SECURITY/);
    const definers = code.match(/SECURITY DEFINER/g)?.length ?? 0;
    const pinned = code.match(/SECURITY DEFINER\s+SET search_path = public/g)?.length ?? 0;
    expect(definers).toBeGreaterThan(0);
    expect(pinned).toBe(definers);
  });
});
