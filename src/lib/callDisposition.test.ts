import { describe, it, expect } from 'vitest';
import sql from '../../supabase/migrations/20271021000000_call_dispositions.sql?raw';
import {
  DISPOSITIONS,
  DISPOSITION_OUTCOMES,
  buildBreakdown,
  callerLabel,
  defaultFollowUp,
  describeDispositionError,
  emptyDispositionDraft,
  followUpIsActive,
  parseSummary,
  requiresFollowUp,
  selectOutcome,
  shouldSendFollowUp,
  suggestDisposition,
  toFollowUpPayload,
  validateDisposition,
  type DispositionOutcome,
} from './callDisposition';

const NOW = new Date(2026, 9, 20, 9, 0, 0); // local time, Tue 20 Oct 2026 09:00

const sqlList = (fn: string): string[] => {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  const body = sql.slice(start, sql.indexOf('$$;', start));
  const list = /IN \(([^)]*)\)/.exec(body)?.[1] ?? '';
  return list.match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [];
};

describe('rule table', () => {
  it('has exactly the seven outcomes the product defines', () => {
    expect([...DISPOSITION_OUTCOMES].sort()).toEqual(
      ['booked', 'existing_customer_issue', 'no_answer', 'quoted', 'spam', 'vendor', 'wrong_number'],
    );
  });

  it('requires a follow-up only for quoted, existing-customer issues and no answer', () => {
    const required = DISPOSITION_OUTCOMES.filter(requiresFollowUp).sort();
    expect(required).toEqual(['existing_customer_issue', 'no_answer', 'quoted']);
    expect(DISPOSITIONS.spam.followUp).toBe('none');
    expect(DISPOSITIONS.wrong_number.followUp).toBe('none');
    expect(DISPOSITIONS.booked.followUp).toBe('optional');
  });

  it('mirrors the SQL helper functions (drift guard)', () => {
    expect(sqlList('call_disposition_valid_outcome').sort()).toEqual([...DISPOSITION_OUTCOMES].sort());
    expect(sqlList('call_disposition_requires_follow_up').sort()).toEqual(DISPOSITION_OUTCOMES.filter(requiresFollowUp).sort());
  });

  it('every required outcome can prefill a non-empty title', () => {
    for (const o of DISPOSITION_OUTCOMES.filter((x) => DISPOSITIONS[x].followUp !== 'none')) {
      expect(DISPOSITIONS[o].followUpTitle('Dana').length).toBeGreaterThan(0);
    }
  });
});

describe('follow-up drafts', () => {
  it('labels the caller by name, then phone, then a fallback', () => {
    expect(callerLabel({ caller_name: ' Dana ', caller_phone: '+1555' })).toBe('Dana');
    expect(callerLabel({ caller_name: '', caller_phone: '+1555' })).toBe('+1555');
    expect(callerLabel({ caller_name: null, caller_phone: null })).toBe('caller');
  });

  it('prefills a due time rounded up to 5 minutes', () => {
    const f = defaultFollowUp('no_answer', 'Dana', 'u1', new Date(2026, 9, 20, 9, 1, 30));
    expect(f.title).toBe('Call back Dana');
    expect(f.priority).toBe('normal');
    expect(f.assignedTo).toBe('u1');
    expect(f.dueLocal).toBe('2026-10-20T11:05');
  });

  it('selecting a required outcome turns the follow-up on; optional stays off; none stays off', () => {
    const base = emptyDispositionDraft('u1');
    expect(selectOutcome(base, 'quoted', 'Dana', 'u1', NOW).followUpOn).toBe(true);
    expect(selectOutcome(base, 'booked', 'Dana', 'u1', NOW).followUpOn).toBe(false);
    expect(selectOutcome(base, 'spam', 'Dana', 'u1', NOW).followUpOn).toBe(false);
  });

  it('keeps the note when switching outcome', () => {
    const d = selectOutcome({ ...emptyDispositionDraft('u1'), note: 'wants Friday' }, 'quoted', 'Dana', 'u1', NOW);
    expect(selectOutcome(d, 'booked', 'Dana', 'u1', NOW).note).toBe('wants Friday');
  });

  it('does not force a second task when one already exists', () => {
    const d = selectOutcome(emptyDispositionDraft('u1'), 'quoted', 'Dana', 'u1', NOW, true);
    expect(d.followUpOn).toBe(false);
    expect(shouldSendFollowUp(d, true)).toBe(false);
    expect(validateDisposition(d, true)).toEqual({});
  });
});

describe('validation', () => {
  it('asks for an outcome first', () => {
    expect(validateDisposition(emptyDispositionDraft()).outcome).toBeTruthy();
  });

  it('blocks a required outcome with no follow-up title', () => {
    const d = selectOutcome(emptyDispositionDraft('u1'), 'quoted', 'Dana', 'u1', NOW);
    expect(validateDisposition({ ...d, followUp: { ...d.followUp, title: '   ' } }).title).toBeTruthy();
    expect(validateDisposition(d)).toEqual({});
  });

  it('does not require a task for spam or wrong number', () => {
    for (const o of ['spam', 'wrong_number'] as DispositionOutcome[]) {
      const d = selectOutcome(emptyDispositionDraft(), o, 'x', null, NOW);
      expect(validateDisposition(d)).toEqual({});
      expect(shouldSendFollowUp(d, false)).toBe(false);
      expect(followUpIsActive(d)).toBe(false);
    }
  });

  it('only validates the task of an optional outcome when the toggle is on', () => {
    const d = selectOutcome(emptyDispositionDraft(), 'booked', 'Dana', null, NOW);
    const cleared = { ...d, followUp: { ...d.followUp, title: '' } };
    expect(validateDisposition(cleared)).toEqual({});
    expect(validateDisposition({ ...cleared, followUpOn: true }).title).toBeTruthy();
  });

  it('rejects over-long notes and titles', () => {
    const d = selectOutcome(emptyDispositionDraft(), 'quoted', 'Dana', null, NOW);
    expect(validateDisposition({ ...d, note: 'x'.repeat(2001) }).note).toBeTruthy();
    expect(validateDisposition({ ...d, followUp: { ...d.followUp, title: 'x'.repeat(201) } }).title).toBeTruthy();
  });

  it('flags an unparseable due date', () => {
    const d = selectOutcome(emptyDispositionDraft(), 'quoted', 'Dana', null, NOW);
    expect(validateDisposition({ ...d, followUp: { ...d.followUp, dueLocal: 'nope' } }).dueLocal).toBeTruthy();
  });
});

describe('RPC payload', () => {
  it('trims, nulls empty fields and converts local time to ISO', () => {
    const p = toFollowUpPayload(
      { title: '  Call back Dana ', description: '  ', priority: 'high', dueLocal: '2026-10-20T11:05', assignedTo: 'u2' },
      'Sam',
    );
    expect(p).toEqual({
      title: 'Call back Dana',
      description: null,
      priority: 'high',
      due_at: new Date(2026, 9, 20, 11, 5).toISOString(),
      assigned_to: 'u2',
      assigned_to_name: 'Sam',
    });
  });

  it('sends no assignee name for an unassigned task and null for a blank due date', () => {
    const p = toFollowUpPayload({ title: 'x', description: '', priority: 'normal', dueLocal: '', assignedTo: null }, 'Sam');
    expect(p.assigned_to_name).toBeNull();
    expect(p.due_at).toBeNull();
  });
});

describe('suggestDisposition', () => {
  it('trusts existing signals first', () => {
    expect(suggestDisposition({ status: 'spam' })?.outcome).toBe('spam');
    expect(suggestDisposition({ booking_outcome: 'booked' })?.outcome).toBe('booked');
    expect(suggestDisposition({ status: 'booked' })?.outcome).toBe('booked');
  });

  it('reads the summary for the rest', () => {
    expect(suggestDisposition({ summary: 'Caller dialed the wrong number.', transcript: 'x' })?.outcome).toBe('wrong_number');
    expect(suggestDisposition({ summary: 'A sales rep pitching SEO services.', transcript: 'x' })?.outcome).toBe('vendor');
    expect(suggestDisposition({ summary: 'Asked how much a water heater costs.', transcript: 'x', duration_seconds: 90 })?.outcome).toBe('quoted');
    expect(suggestDisposition({ intent: 'Question about my last invoice', transcript: 'x', duration_seconds: 90 })?.outcome).toBe('existing_customer_issue');
  });

  it('suggests no answer for voicemails and instant hang-ups', () => {
    expect(suggestDisposition({ is_voicemail: true })?.outcome).toBe('no_answer');
    expect(suggestDisposition({ transcript: '', duration_seconds: 4 })?.outcome).toBe('no_answer');
    expect(suggestDisposition({ transcript: 'Hello there', duration_seconds: 4, summary: 'Short hello.' })).toBeNull();
  });

  it('returns null when nothing is clear', () => {
    expect(suggestDisposition({ summary: 'Caller chatted about the weather.', transcript: 'x', duration_seconds: 120 })).toBeNull();
  });
});

describe('analytics summary', () => {
  const raw = {
    total_calls: 20,
    tagged: 10,
    ai_reviewed: 4,
    ai_agreed: 3,
    by_outcome: [
      { outcome: 'booked', total: 4, ai_count: 1, with_task: 2, tasks_done: 1 },
      { outcome: 'quoted', total: 2, ai_count: 0, with_task: 2, tasks_done: 0 },
      { outcome: 'no_answer', total: 2, ai_count: 2, with_task: 1, tasks_done: 0 },
      { outcome: 'spam', total: 2, ai_count: 0, with_task: 0, tasks_done: 0 },
      { outcome: 'not_a_real_outcome', total: 99 },
    ],
  };

  it('drops unknown outcomes and coerces garbage numbers', () => {
    const s = parseSummary({ ...raw, tagged: '10', ai_agreed: 99 });
    expect(s.by_outcome.map((r) => r.outcome)).not.toContain('not_a_real_outcome');
    expect(s.tagged).toBe(10);
    expect(s.ai_agreed).toBe(s.ai_reviewed);
    expect(parseSummary(null)).toEqual({ total_calls: 0, tagged: 0, ai_reviewed: 0, ai_agreed: 0, by_outcome: [] });
  });

  it('computes shares, close rate, noise, coverage and AI agreement', () => {
    const b = buildBreakdown(parseSummary(raw));
    expect(b.rows[0]).toMatchObject({ outcome: 'booked', count: 4, pct: 40 });
    expect(b.untagged).toBe(10);
    expect(b.taggedPct).toBe(50);
    expect(b.closeRate).toBe(67); // 4 / (4 + 2)
    expect(b.noiseRate).toBe(20); // 2 / 10
    expect(b.followUpCoverage).toBe(75); // required: quoted(2) + no_answer(2) = 4, with tasks 2 + 1 = 3
    expect(b.aiAgreement).toBe(75);
  });

  it('returns null rates instead of dividing by zero', () => {
    const b = buildBreakdown(parseSummary({ total_calls: 3 }));
    expect(b.rows).toEqual([]);
    expect(b.closeRate).toBeNull();
    expect(b.noiseRate).toBeNull();
    expect(b.followUpCoverage).toBeNull();
    expect(b.aiAgreement).toBeNull();
    expect(b.untagged).toBe(3);
  });
});

describe('error messages', () => {
  it('turns database errors into actionable copy', () => {
    expect(describeDispositionError(new Error('follow_up_required'))).toMatch(/follow-up/i);
    expect(describeDispositionError({ message: 'call_not_found' })).toMatch(/could not be found/i);
    expect(describeDispositionError({ message: 'new row violates row-level security policy' })).toMatch(/permission/i);
    expect(describeDispositionError('boom')).toMatch(/try again/i);
  });
});

describe('call_dispositions migration contract', () => {
  it('enables RLS and scopes every policy to the account owner', () => {
    expect(sql).toContain('ALTER TABLE public.call_dispositions ENABLE ROW LEVEL SECURITY');
    for (const p of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toContain(`CREATE POLICY "call_dispositions_${p}"`);
    }
    expect(sql.match(/user_id = public\.get_account_owner_id\(\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql).toMatch(/call_dispositions_delete[\s\S]*tasks_can_view_all\(\)/);
  });

  it('never lets a write target a call outside the account', () => {
    expect(sql).toMatch(/call_dispositions_insert[\s\S]*c\.user_id = public\.get_account_owner_id\(\)/);
    expect(sql).toMatch(/call_dispositions_update[\s\S]*c\.user_id = public\.get_account_owner_id\(\)/);
  });

  it('keeps one disposition per call and cascades with the call', () => {
    expect(sql).toContain('CONSTRAINT call_dispositions_one_per_call UNIQUE (call_id)');
    expect(sql).toMatch(/call_id uuid NOT NULL REFERENCES public\.calls\(id\) ON DELETE CASCADE/);
  });

  it('runs both RPCs as SECURITY INVOKER so RLS keeps applying', () => {
    for (const fn of ['set_call_disposition', 'call_disposition_summary']) {
      const start = sql.indexOf(`FUNCTION public.${fn}(`);
      const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('AS $$', start)));
      expect(body).toContain('SECURITY INVOKER');
      expect(body).not.toContain('SECURITY DEFINER');
      expect(body).toContain('auth.uid() IS NULL');
    }
  });

  it('grants the RPCs to signed-in users only', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_call_disposition(uuid, text, text, jsonb) FROM PUBLIC, anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_call_disposition(uuid, text, text, jsonb) TO authenticated');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.call_disposition_summary(timestamptz, timestamptz) FROM PUBLIC, anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.call_disposition_summary(timestamptz, timestamptz) TO authenticated');
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|PUBLIC)/);
  });

  it('enforces the follow-up rule in the database, for staff rows only', () => {
    expect(sql).toMatch(/NEW\.source = 'staff'[\s\S]*call_disposition_requires_follow_up\(NEW\.outcome\)[\s\S]*follow_up_task_id IS NULL/);
    expect(sql).toContain("RAISE EXCEPTION 'follow_up_required'");
  });

  it('never blocks deleting the linked task (trigger fires on outcome/source/note only)', () => {
    expect(sql).toContain('BEFORE UPDATE OF outcome, source, note ON public.call_dispositions');
    expect(sql).toContain('follow_up_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL');
  });

  it('caps the analytics range and clamps nothing client-side', () => {
    expect(sql).toContain("p_to - p_from > interval '400 days'");
  });
});
