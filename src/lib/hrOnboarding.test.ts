import { describe, it, expect } from 'vitest';
import {
  addDays,
  averageRating,
  buildReviewReminders,
  buildStoragePath,
  diffDays,
  documentState,
  groupTasksByCategory,
  isValidIsoDate,
  normalizeDocument,
  normalizeOnboarding,
  normalizeRatings,
  normalizeReview,
  normalizeTask,
  normalizeTemplate,
  normalizeTemplateItem,
  onboardingProgress,
  parseOffset,
  relativeDays,
  reviewDueDate,
  reviewDueState,
  safeFileName,
  suggestOverall,
  summarizeHr,
  taskDueState,
  validateDocument,
  validateDocumentFile,
  validateReview,
  validateScheduleReview,
  validateStartOnboarding,
  validateTask,
  validateTemplate,
  validateTemplateItem,
  type HrDocument,
  type Onboarding,
  type OnboardingTask,
  type Review,
  type ReviewDraft,
} from './hrOnboarding';

const TODAY = '2026-06-15';

function task(over: Partial<OnboardingTask> = {}): OnboardingTask {
  return {
    id: 't1',
    onboarding_id: 'o1',
    employee_id: 'e1',
    title: 'Sign offer letter',
    description: null,
    category: 'paperwork',
    due_date: '2026-06-20',
    required: true,
    status: 'pending',
    completed_at: null,
    notes: null,
    document_type: null,
    sort_order: 10,
    ...over,
  };
}

function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1',
    employee_id: 'e1',
    onboarding_id: 'o1',
    kind: 'day_30',
    due_date: '2026-06-20',
    status: 'scheduled',
    reviewed_on: null,
    overall_rating: null,
    ratings: {},
    strengths: null,
    improvements: null,
    goals: null,
    notes: null,
    completed_at: null,
    ...over,
  };
}

function doc(over: Partial<HrDocument> = {}): HrDocument {
  return {
    id: 'd1',
    employee_id: 'e1',
    onboarding_id: 'o1',
    task_id: null,
    doc_type: 'license',
    title: 'Driver licence',
    status: 'received',
    expires_on: null,
    storage_path: 'owner/e1/d1-license.pdf',
    file_name: 'license.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1000,
    notes: null,
    received_at: null,
    verified_at: null,
    created_at: '',
    ...over,
  };
}

function onboarding(over: Partial<Onboarding> = {}): Onboarding {
  return { id: 'o1', employee_id: 'e1', template_id: 't', template_name: 'Field technician', start_date: '2026-06-01', status: 'active', completed_at: null, created_at: '', ...over };
}

describe('dates', () => {
  it('validates real calendar days only', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-2-3')).toBe(false);
    expect(isValidIsoDate(20260101)).toBe(false);
  });

  it('adds days across month and year boundaries without timezone drift', () => {
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(diffDays('2026-06-15', '2026-06-18')).toBe(3);
    expect(diffDays('2026-06-15', '2026-06-10')).toBe(-5);
  });

  it('describes relative days', () => {
    expect(relativeDays('2026-06-15', TODAY)).toBe('today');
    expect(relativeDays('2026-06-16', TODAY)).toBe('in 1 day');
    expect(relativeDays('2026-06-18', TODAY)).toBe('in 3 days');
    expect(relativeDays('2026-06-14', TODAY)).toBe('1 day overdue');
    expect(relativeDays('2026-06-10', TODAY)).toBe('5 days overdue');
  });

  it('puts the 30/60/90-day reviews at the right offsets from the start date', () => {
    expect(reviewDueDate('2026-06-01', 'day_30')).toBe('2026-07-01');
    expect(reviewDueDate('2026-06-01', 'day_60')).toBe('2026-07-31');
    expect(reviewDueDate('2026-06-01', 'day_90')).toBe('2026-08-30');
  });
});

describe('normalizers', () => {
  it('drops rows without the fields the UI depends on', () => {
    expect(normalizeTask(null)).toBeNull();
    expect(normalizeTask({ id: 'x' })).toBeNull();
    expect(normalizeDocument({ id: 'x', employee_id: 'e' })).toBeNull();
    expect(normalizeReview({ id: 'x', employee_id: 'e', kind: 'bogus', due_date: '2026-01-01' })).toBeNull();
    expect(normalizeOnboarding({ id: 'x', employee_id: 'e', start_date: 'soon' })).toBeNull();
    expect(normalizeTemplateItem({ id: 'x', template_id: 't', title: '  ' })).toBeNull();
  });

  it('falls back to safe defaults for unknown enum values', () => {
    const t = normalizeTask({ id: 'a', onboarding_id: 'o', employee_id: 'e', title: 'T', category: 'weird', status: 'weird', due_date: 'nope' });
    expect(t?.category).toBe('other');
    expect(t?.status).toBe('pending');
    expect(t?.due_date).toBeNull();
    expect(t?.required).toBe(true);
  });

  it('clamps template item offsets and attaches sorted items to the template', () => {
    const a = normalizeTemplateItem({ id: 'a', template_id: 't1', title: 'B item', due_offset_days: 9999, sort_order: 2 });
    const b = normalizeTemplateItem({ id: 'b', template_id: 't1', title: 'A item', due_offset_days: -4, sort_order: 1 });
    const other = normalizeTemplateItem({ id: 'c', template_id: 't2', title: 'Other', sort_order: 0 });
    expect(a?.due_offset_days).toBe(365);
    expect(b?.due_offset_days).toBe(0);
    const tpl = normalizeTemplate({ id: 't1', name: 'Field technician' }, [a!, b!, other!]);
    expect(tpl?.items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('keeps only whole-number ratings between 1 and 5 for known competencies', () => {
    expect(normalizeRatings({ quality: 4, safety: 6, teamwork: 2.5, unknown: 3, initiative: '5' })).toEqual({ quality: 4 });
    expect(normalizeRatings([1, 2])).toEqual({});
    expect(normalizeRatings(null)).toEqual({});
  });

  it('rejects an out-of-range overall rating', () => {
    expect(normalizeReview({ id: 'r', employee_id: 'e', kind: 'day_30', due_date: '2026-01-01', overall_rating: 9 })?.overall_rating).toBeNull();
    expect(normalizeReview({ id: 'r', employee_id: 'e', kind: 'day_30', due_date: '2026-01-01', overall_rating: 4 })?.overall_rating).toBe(4);
  });
});

describe('tasks & progress', () => {
  it('classifies due states', () => {
    expect(taskDueState(task({ status: 'done' }), TODAY)).toBe('done');
    expect(taskDueState(task({ status: 'skipped' }), TODAY)).toBe('skipped');
    expect(taskDueState(task({ due_date: null }), TODAY)).toBe('no_date');
    expect(taskDueState(task({ due_date: '2026-06-14' }), TODAY)).toBe('overdue');
    expect(taskDueState(task({ due_date: '2026-06-15' }), TODAY)).toBe('due_today');
    expect(taskDueState(task({ due_date: '2026-06-18' }), TODAY)).toBe('due_soon');
    expect(taskDueState(task({ due_date: '2026-06-19' }), TODAY)).toBe('upcoming');
  });

  it('counts done and skipped as handled and completes when no REQUIRED task is pending', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'skipped' }),
      task({ id: 'c', required: false, status: 'pending' }),
      task({ id: 'd', required: true, status: 'pending', due_date: '2026-06-01' }),
    ];
    const p = onboardingProgress(tasks, TODAY);
    expect(p).toEqual({ total: 4, done: 1, skipped: 1, pending: 2, requiredPending: 1, overdue: 1, percent: 50, complete: false });
    const done = onboardingProgress(tasks.filter((t) => t.id !== 'd'), TODAY);
    expect(done.complete).toBe(true);
    expect(done.requiredPending).toBe(0);
  });

  it('an onboarding with no tasks is never "complete" and has 0 percent', () => {
    expect(onboardingProgress([], TODAY)).toEqual({ total: 0, done: 0, skipped: 0, pending: 0, requiredPending: 0, overdue: 0, percent: 0, complete: false });
  });

  it('groups by category in a fixed order and sorts inside a group', () => {
    const groups = groupTasksByCategory([
      task({ id: 'v', category: 'vehicle', sort_order: 5 }),
      task({ id: 'p2', category: 'paperwork', sort_order: 20, title: 'B' }),
      task({ id: 'p1', category: 'paperwork', sort_order: 10, title: 'A' }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['paperwork', 'vehicle']);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['p1', 'p2']);
  });
});

describe('reviews & reminders', () => {
  it('classifies review due states around the 7-day window', () => {
    expect(reviewDueState(review({ status: 'completed' }), TODAY).state).toBe('completed');
    expect(reviewDueState(review({ status: 'skipped' }), TODAY).state).toBe('skipped');
    expect(reviewDueState(review({ due_date: '2026-06-14' }), TODAY)).toEqual({ state: 'overdue', days: -1 });
    expect(reviewDueState(review({ due_date: '2026-06-15' }), TODAY)).toEqual({ state: 'due_soon', days: 0 });
    expect(reviewDueState(review({ due_date: '2026-06-22' }), TODAY).state).toBe('due_soon');
    expect(reviewDueState(review({ due_date: '2026-06-23' }), TODAY).state).toBe('upcoming');
  });

  it('builds reminders from scheduled reviews only, overdue first', () => {
    const list = buildReviewReminders(
      [
        review({ id: 'far', due_date: '2026-09-01' }),
        review({ id: 'soon', due_date: '2026-06-20' }),
        review({ id: 'late', due_date: '2026-06-01' }),
        review({ id: 'done', due_date: '2026-06-02', status: 'completed' }),
        review({ id: 'skipped', due_date: '2026-06-03', status: 'skipped' }),
      ],
      TODAY,
    );
    expect(list.map((r) => r.id)).toEqual(['late', 'soon']);
  });

  it('averages competency ratings and suggests a bounded overall rating', () => {
    expect(averageRating({})).toBeNull();
    expect(averageRating({ quality: 4, safety: 5 })).toBe(4.5);
    expect(suggestOverall({ quality: 4, safety: 5 })).toBe(5);
    expect(suggestOverall({ quality: 1 })).toBe(1);
    expect(suggestOverall({})).toBeNull();
  });
});

describe('documents', () => {
  it('derives the document state, including expiry warnings', () => {
    expect(documentState(doc({ status: 'requested' }), TODAY)).toBe('requested');
    expect(documentState(doc({ status: 'received' }), TODAY)).toBe('received');
    expect(documentState(doc({ status: 'verified' }), TODAY)).toBe('verified');
    expect(documentState(doc({ status: 'verified', expires_on: '2026-06-14' }), TODAY)).toBe('expired');
    expect(documentState(doc({ status: 'verified', expires_on: '2026-07-15' }), TODAY)).toBe('expiring');
    expect(documentState(doc({ status: 'verified', expires_on: '2026-07-16' }), TODAY)).toBe('verified');
  });

  it('validates uploads: empty, too big, wrong type', () => {
    expect(validateDocumentFile({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toBe('This file is empty.');
    expect(validateDocumentFile({ name: 'a.pdf', size: 11 * 1024 * 1024, type: 'application/pdf' })).toBe('Files can be at most 10 MB.');
    expect(validateDocumentFile({ name: 'a.exe', size: 10, type: 'application/x-msdownload' })).toBe('Use a PDF, PNG, JPEG, WebP or HEIC file.');
    expect(validateDocumentFile({ name: 'a.pdf', size: 10, type: 'application/pdf' })).toBeNull();
  });

  it('builds storage-safe paths that start with the owner folder', () => {
    expect(safeFileName('../../Résumé final (1).PDF')).toBe('Resume_final_1_.PDF');
    expect(safeFileName('   ')).toBe('document');
    expect(safeFileName('日本語')).toBe('document');
    const path = buildStoragePath('owner-id', 'emp-id', 'doc-id', 'My W-4.pdf');
    expect(path).toBe('owner-id/emp-id/doc-id-My_W-4.pdf');
    expect(path.split('/')[0]).toBe('owner-id');
  });
});

describe('validation', () => {
  it('start onboarding: required fields, busy employee and the one-year window', () => {
    expect(validateStartOnboarding({ employee_id: '', template_id: '', start_date: '' }, TODAY)).toEqual({
      employee_id: 'Choose an employee.',
      template_id: 'Choose a template.',
      start_date: 'Enter a valid start date.',
    });
    expect(validateStartOnboarding({ employee_id: 'e1', template_id: 't', start_date: TODAY }, TODAY, new Set(['e1'])).employee_id).toBe('This employee already has an active onboarding.');
    expect(validateStartOnboarding({ employee_id: 'e1', template_id: 't', start_date: '2028-01-01' }, TODAY).start_date).toBe('The start date must be within a year of today.');
    expect(validateStartOnboarding({ employee_id: 'e1', template_id: 't', start_date: addDays(TODAY, 366) }, TODAY)).toEqual({});
    expect(validateStartOnboarding({ employee_id: 'e1', template_id: 't', start_date: addDays(TODAY, 367) }, TODAY).start_date).toBeTruthy();
  });

  it('template: name required, length-limited and unique (case-insensitive)', () => {
    expect(validateTemplate({ name: '  ', description: '' }).name).toBe('Name is required.');
    expect(validateTemplate({ name: 'x'.repeat(81), description: '' }).name).toBe('Name must be 80 characters or fewer.');
    expect(validateTemplate({ name: 'field technician', description: '' }, ['Field Technician']).name).toBe('A template with this name already exists.');
    expect(validateTemplate({ name: 'New', description: 'x'.repeat(501) }).description).toBe('Description must be 500 characters or fewer.');
    expect(validateTemplate({ name: 'New', description: '' }, ['Other'])).toEqual({});
  });

  it('template item and offsets', () => {
    expect(parseOffset('0')).toBe(0);
    expect(parseOffset(' 14 ')).toBe(14);
    expect(parseOffset('365')).toBe(365);
    expect(parseOffset('366')).toBeNull();
    expect(parseOffset('-1')).toBeNull();
    expect(parseOffset('2.5')).toBeNull();
    expect(parseOffset('')).toBeNull();
    const ok = { title: 'Issue boots', description: '', category: 'uniform' as const, due_offset_days: '2', required: true, document_type: '' as const };
    expect(validateTemplateItem(ok)).toEqual({});
    expect(validateTemplateItem({ ...ok, title: '', due_offset_days: 'abc' })).toEqual({
      title: 'Title is required.',
      due_offset_days: 'Enter whole days from 0 to 365.',
    });
  });

  it('task: optional but valid due date', () => {
    const ok = { title: 'Order uniform', description: '', category: 'uniform' as const, required: true, document_type: '' as const, due_date: '' };
    expect(validateTask(ok)).toEqual({});
    expect(validateTask({ ...ok, due_date: '2026-13-01' }).due_date).toBe('Enter a valid due date.');
    expect(validateTask({ ...ok, title: 'x'.repeat(121) }).title).toBe('Title must be 120 characters or fewer.');
  });

  it('document request', () => {
    const ok = { employee_id: 'e1', doc_type: 'w4' as const, title: 'W-4', expires_on: '', notes: '' };
    expect(validateDocument(ok)).toEqual({});
    expect(validateDocument({ ...ok, employee_id: '', title: ' ', expires_on: 'x' })).toEqual({
      employee_id: 'Choose an employee.',
      title: 'Title is required.',
      expires_on: 'Enter a valid expiry date.',
    });
  });

  it('completed review needs a 1-5 overall rating and a non-future review date', () => {
    const ok: ReviewDraft = { overall_rating: 4, reviewed_on: TODAY, ratings: { quality: 4 }, strengths: '', improvements: '', goals: '', notes: '' };
    expect(validateReview(ok, TODAY)).toEqual({});
    expect(validateReview({ ...ok, overall_rating: null }, TODAY).overall_rating).toBe('Give an overall rating from 1 to 5.');
    expect(validateReview({ ...ok, overall_rating: 6 }, TODAY).overall_rating).toBeTruthy();
    expect(validateReview({ ...ok, overall_rating: 3.5 }, TODAY).overall_rating).toBeTruthy();
    expect(validateReview({ ...ok, reviewed_on: '' }, TODAY).reviewed_on).toBe('Enter the review date.');
    expect(validateReview({ ...ok, reviewed_on: '2026-06-16' }, TODAY).reviewed_on).toBe('The review date cannot be in the future.');
    expect(validateReview({ ...ok, ratings: { quality: 9 } }, TODAY).ratings).toBe('Ratings must be 1 to 5.');
    expect(validateReview({ ...ok, notes: 'x'.repeat(4001) }, TODAY).notes).toBe('Private notes must be 4000 characters or fewer.');
  });

  it('scheduling a review only allows annual / check-in kinds', () => {
    expect(validateScheduleReview({ employee_id: 'e1', kind: 'annual', due_date: TODAY })).toEqual({});
    expect(validateScheduleReview({ employee_id: 'e1', kind: 'ad_hoc', due_date: TODAY })).toEqual({});
    expect(validateScheduleReview({ employee_id: 'e1', kind: 'day_30', due_date: TODAY }).kind).toBeTruthy();
    expect(validateScheduleReview({ employee_id: '', kind: 'annual', due_date: '' })).toEqual({ employee_id: 'Choose an employee.', due_date: 'Enter a valid due date.' });
  });
});

describe('summary', () => {
  it('only counts overdue tasks of ACTIVE onboardings and splits document problems', () => {
    const s = summarizeHr(
      {
        onboardings: [onboarding({ id: 'o1' }), onboarding({ id: 'o2', status: 'completed' }), onboarding({ id: 'o3', status: 'cancelled' })],
        tasks: [
          task({ id: 'a', onboarding_id: 'o1', due_date: '2026-06-01' }),
          task({ id: 'b', onboarding_id: 'o2', due_date: '2026-06-01' }),
          task({ id: 'c', onboarding_id: 'o1', due_date: '2026-06-30' }),
          task({ id: 'd', onboarding_id: 'o1', due_date: '2026-06-01', status: 'done' }),
        ],
        documents: [doc({ id: '1', status: 'requested', storage_path: null }), doc({ id: '2', expires_on: '2026-06-20' }), doc({ id: '3', expires_on: '2026-06-01' }), doc({ id: '4' })],
        reviews: [review({ id: 'x', due_date: '2026-06-18' }), review({ id: 'y', due_date: '2026-12-01' })],
      },
      TODAY,
    );
    expect(s).toEqual({ activeOnboardings: 1, overdueTasks: 1, openDocuments: 1, expiringDocuments: 2, reviewsDue: 1 });
  });
});
