import { describe, it, expect, vi } from 'vitest';

// The pure helpers under test never touch the network.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  SOP_LIMITS,
  buildStoragePath,
  completionToCsv,
  csvCell,
  describeAssignment,
  describeSopError,
  dueDateToIso,
  dueState,
  emptyAssignment,
  emptyQuestion,
  emptySopForm,
  formToPayload,
  hasErrors,
  isQuizComplete,
  isSafeHref,
  isoToDueDate,
  normalizeItemKey,
  parseInline,
  parseMarkdown,
  sanitizeFileName,
  sortTraining,
  summarizeBySop,
  summarizeCompletion,
  validateForPublish,
  validateSopFile,
  validateSopForm,
  type SopFormState,
  type TrainingStatus,
} from './sop';

const validForm = (patch: Partial<SopFormState> = {}): SopFormState => ({
  ...emptySopForm(),
  title: 'Refrigerant handling',
  body_md: '# Steps',
  assignments: [emptyAssignment()],
  ...patch,
});

describe('validateSopForm', () => {
  it('accepts a minimal valid draft', () => {
    expect(hasErrors(validateSopForm(validForm()))).toBe(false);
  });

  it('requires a title and caps its length', () => {
    expect(validateSopForm(validForm({ title: '   ' })).title).toBeTruthy();
    expect(validateSopForm(validForm({ title: 'x'.repeat(SOP_LIMITS.title + 1) })).title).toBeTruthy();
  });

  it('rejects an out-of-range pass mark', () => {
    expect(validateSopForm(validForm({ pass_score_pct: 0 })).pass_score_pct).toBeTruthy();
    expect(validateSopForm(validForm({ pass_score_pct: 101 })).pass_score_pct).toBeTruthy();
    expect(validateSopForm(validForm({ pass_score_pct: 80.5 })).pass_score_pct).toBeTruthy();
  });

  it('validates quiz questions one by one', () => {
    const q = { ...emptyQuestion(), prompt: 'Vent it?', options: ['Yes', 'No'], correct_index: 1 };
    expect(validateSopForm(validForm({ quiz: [q] })).quiz).toBeUndefined();
    expect(validateSopForm(validForm({ quiz: [{ ...q, prompt: ' ' }] })).quiz).toMatch(/Question 1 needs text/);
    expect(validateSopForm(validForm({ quiz: [{ ...q, options: ['Yes', ' '] }] })).quiz).toMatch(/empty answers/);
    expect(validateSopForm(validForm({ quiz: [{ ...q, options: ['Yes', 'yes'] }] })).quiz).toMatch(/duplicate/);
    expect(validateSopForm(validForm({ quiz: [{ ...q, correct_index: 2 }] })).quiz).toMatch(/correct answer/);
  });

  it('requires a target for each assignment kind', () => {
    const base = emptyAssignment();
    expect(validateSopForm(validForm({ assignments: [{ ...base, target_type: 'role', target_role: '' }] })).assignments).toBeTruthy();
    expect(validateSopForm(validForm({ assignments: [{ ...base, target_type: 'member', target_member_id: '' }] })).assignments).toBeTruthy();
    expect(validateSopForm(validForm({ assignments: [{ ...base, target_type: 'custom_role', target_custom_role_id: '' }] })).assignments).toBeTruthy();
    expect(validateSopForm(validForm({ assignments: [{ ...base, target_type: 'everyone' }] })).assignments).toBeUndefined();
  });
});

describe('validateForPublish', () => {
  it('needs content and an assignment', () => {
    expect(validateForPublish(validForm())).toBeNull();
    expect(validateForPublish(validForm({ body_md: '  ' }))).toMatch(/Write the procedure/);
    expect(validateForPublish(validForm({ body_md: '', file_path: 'owner/sop/f.pdf' }))).toBeNull();
    expect(validateForPublish(validForm({ assignments: [] }))).toMatch(/Assign/);
  });
});

describe('formToPayload', () => {
  it('trims, de-duplicates and nulls fields that do not apply to the target type', () => {
    const payload = formToPayload(
      validForm({
        title: '  Title  ',
        template_ids: ['a', 'a', 'b'],
        checklist_links: [
          { template_id: 'a', item_label: ' Recover ' },
          { template_id: '', item_label: 'dropped' },
          { template_id: 'a', item_label: '   ' },
        ],
        assignments: [{ ...emptyAssignment(), target_type: 'role', target_role: 'technician', target_member_id: 'stale', due_date: '2030-05-01' }],
      }),
    ) as { title: string; template_ids: string[]; checklist_links: unknown[]; assignments: unknown[] };
    expect(payload.title).toBe('Title');
    expect(payload.template_ids).toEqual(['a', 'b']);
    expect(payload.checklist_links).toEqual([{ template_id: 'a', item_label: 'Recover' }]);
    expect(payload.assignments[0]).toEqual({
      target_type: 'role',
      target_role: 'technician',
      target_custom_role_id: null,
      target_member_id: null,
      due_at: '2030-05-01T23:59:59.000Z',
    });
  });

  it('never sends a client-side key to the server', () => {
    const q = { ...emptyQuestion(), prompt: 'p', options: ['a', 'b'], correct_index: 0 };
    const payload = formToPayload(validForm({ quiz: [q] })) as { quiz: Array<Record<string, unknown>> };
    expect(Object.keys(payload.quiz[0]).sort()).toEqual(['correct_index', 'explanation', 'options', 'prompt']);
  });
});

describe('due dates', () => {
  it('round-trips a date and treats the whole due day as on time', () => {
    expect(dueDateToIso('2030-05-01')).toBe('2030-05-01T23:59:59.000Z');
    expect(isoToDueDate('2030-05-01T23:59:59.000Z')).toBe('2030-05-01');
    expect(dueDateToIso('')).toBeNull();
    expect(dueDateToIso('not-a-date')).toBeNull();
    expect(isoToDueDate(null)).toBe('');
  });

  it('classifies due state', () => {
    const now = new Date('2030-05-10T12:00:00Z');
    expect(dueState(null, now)).toBe('none');
    expect(dueState('2030-05-09T00:00:00Z', now)).toBe('overdue');
    expect(dueState('2030-05-12T00:00:00Z', now)).toBe('soon');
    expect(dueState('2030-06-12T00:00:00Z', now)).toBe('ok');
    expect(dueState('garbage', now)).toBe('none');
  });
});

describe('completion summaries', () => {
  const row = (sop_id: string, status: TrainingStatus) => ({ sop_id, status });

  it('computes counts and a whole-number percentage', () => {
    const s = summarizeCompletion([row('a', 'completed'), row('a', 'completed'), row('a', 'overdue'), row('a', 'needs_reack')]);
    expect(s).toEqual({ total: 4, completed: 2, overdue: 1, needsReack: 1, pending: 2, pct: 50 });
  });

  it('is 0% (not NaN) when nobody is assigned', () => {
    expect(summarizeCompletion([]).pct).toBe(0);
  });

  it('groups by SOP', () => {
    const m = summarizeBySop([row('a', 'completed'), row('b', 'not_started'), row('b', 'completed')]);
    expect(m.get('a')?.pct).toBe(100);
    expect(m.get('b')?.pct).toBe(50);
  });

  it('sorts the most urgent training first, then by due date, then title', () => {
    const rows = [
      { status: 'completed' as const, due_at: null, title: 'A' },
      { status: 'not_started' as const, due_at: '2030-02-01T00:00:00Z', title: 'C' },
      { status: 'not_started' as const, due_at: '2030-01-01T00:00:00Z', title: 'B' },
      { status: 'overdue' as const, due_at: '2020-01-01T00:00:00Z', title: 'Z' },
    ];
    expect(sortTraining(rows).map((r) => r.title)).toEqual(['Z', 'B', 'C', 'A']);
  });
});

describe('quiz helpers', () => {
  it('requires every question to be answered', () => {
    expect(isQuizComplete([0, 1], 2)).toBe(true);
    expect(isQuizComplete([0, null], 2)).toBe(false);
    expect(isQuizComplete([0], 2)).toBe(false);
    expect(isQuizComplete([], 0)).toBe(true);
  });
});

describe('item keys', () => {
  it('match the database lower(btrim(label)) rule', () => {
    expect(normalizeItemKey('  Recover Refrigerant ')).toBe('recover refrigerant');
  });
});

describe('describeAssignment', () => {
  it('names each target kind', () => {
    const base = emptyAssignment();
    expect(describeAssignment({ ...base, target_type: 'everyone' })).toBe('Everyone on the team');
    expect(describeAssignment({ ...base, target_type: 'role', target_role: 'technician' })).toBe('Technicians');
    expect(describeAssignment({ ...base, target_type: 'member', target_member_id: 'm1' }, { members: [{ id: 'm1', name: 'Tom' }] })).toBe('Tom');
    expect(describeAssignment({ ...base, target_type: 'custom_role', target_custom_role_id: 'r1' }, { customRoles: [{ id: 'r1', name: 'Lead' }] })).toBe('Lead');
  });
});

describe('files', () => {
  it('sanitizes names so a path can never escape its folder', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFileName('My Safety Plan (v2).pdf')).toBe('My-Safety-Plan-v2.pdf');
    expect(sanitizeFileName('....')).toBe('file');
    expect(sanitizeFileName('')).toBe('file');
  });

  it('keeps the account id as the first folder (storage policy depends on it)', () => {
    const path = buildStoragePath('owner-1', null, 'a b.pdf', 'uuid-1');
    expect(path).toBe('owner-1/new/uuid-1-a-b.pdf');
    expect(path.split('/')[0]).toBe('owner-1');
    expect(buildStoragePath('owner-1', 'sop-9', 'x.pdf', 'u')).toBe('owner-1/sop-9/u-x.pdf');
  });

  it('validates size and type', () => {
    expect(validateSopFile({ size: 1024, type: 'application/pdf' })).toBeNull();
    expect(validateSopFile({ size: 0, type: 'application/pdf' })).toMatch(/empty/);
    expect(validateSopFile({ size: 60 * 1024 * 1024, type: 'application/pdf' })).toMatch(/50 MB/);
    expect(validateSopFile({ size: 10, type: 'application/x-msdownload' })).toMatch(/Upload a PDF/);
  });
});

describe('markdown renderer', () => {
  it('parses headings, lists, checklists and paragraphs', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** text\nmore\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] open\n- [x] done');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'ul', 'ol', 'check']);
    const check = blocks[4];
    expect(check.type === 'check' && check.items.map((i) => i.checked)).toEqual([false, true]);
    const para = blocks[1];
    expect(para.type === 'paragraph' && para.inline[1]).toEqual({ type: 'bold', text: 'bold' });
  });

  it('keeps raw HTML as inert text (the renderer never injects HTML)', () => {
    const [block] = parseMarkdown('<img src=x onerror=alert(1)>');
    expect(block).toEqual({ type: 'paragraph', inline: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] });
  });

  it('only allows http(s) and mailto links', () => {
    expect(isSafeHref('https://vireek.com/x')).toBe(true);
    expect(isSafeHref('mailto:a@b.co')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html;base64,AAAA')).toBe(false);
    const unsafe = parseInline('[x](javascript:alert(1))');
    expect(unsafe.some((n) => n.type === 'link')).toBe(false);
    expect(unsafe.map((n) => ('text' in n ? n.text : '')).join('')).toBe('[x](javascript:alert(1))');
    expect(parseInline('[ok](https://a.co)')).toEqual([{ type: 'link', text: 'ok', href: 'https://a.co' }]);
  });
});

describe('describeSopError', () => {
  it('maps database error codes to plain language', () => {
    expect(describeSopError({ code: '42501', message: 'not_permitted' })).toMatch(/permission/);
    expect(describeSopError({ message: 'quiz_not_passed' })).toMatch(/Pass the quiz/);
    expect(describeSopError({ message: 'assignment_required' })).toMatch(/Assign/);
    expect(describeSopError({ message: 'invalid_quiz' })).toMatch(/quiz/);
    expect(describeSopError({ message: '' }, 'fallback')).toBe('fallback');
    expect(describeSopError(new Error('plain'))).toBe('plain');
  });
});

describe('audit CSV export', () => {
  it('neutralizes spreadsheet formulas and escapes quotes/commas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('writes one header and one line per person with readable status', () => {
    const csv = completionToCsv([
      {
        sop_id: 's', title: 'Safety, basics', version: 2, user_id: 'u', team_member_id: null, full_name: 'Tom Tech', email: 't@x.co',
        role: 'technician', due_at: '2030-05-01T23:59:59Z', acknowledged_at: '2030-04-01T10:00:00Z', quiz_required: true, quiz_passed: true,
        best_score: 100, attempts: 2, status: 'completed',
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"Safety, basics",2,Tom Tech,t@x.co,technician,Completed,2030-05-01,2030-04-01T10:00:00Z,100,2');
  });
});
