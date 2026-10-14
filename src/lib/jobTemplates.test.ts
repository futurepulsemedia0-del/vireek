import { describe, it, expect, vi } from 'vitest';

// The module under test imports the Supabase client at load time; these tests
// only exercise its pure helpers, so stub the client out.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  centsToInput,
  checklistProgress,
  describeTemplateError,
  emptyTemplateForm,
  filterTemplates,
  formServicesTotalCents,
  formToPayload,
  formatDuration,
  parseDollarsToCents,
  parsePositiveInt,
  parseQuantity,
  servicesTotalCents,
  templateToForm,
  validateTemplateForm,
} from './jobTemplates';
import type { JobTemplateDetail, JobTemplateFormState, JobTemplateSummary } from './jobTemplates';

function validForm(over: Partial<JobTemplateFormState> = {}): JobTemplateFormState {
  return {
    ...emptyTemplateForm(),
    name: 'AC tune-up',
    service_type: 'HVAC',
    duration_minutes: '90',
    price: '149.50',
    services: [{ key: 's1', service_name: 'Inspection', price_book_item_id: '', quantity: '1', unit_price: '99' }],
    parts: [{ key: 'p1', part_id: 'part-1', part_name: 'Filter', part_number: 'F-1', quantity: '2' }],
    checklist: [{ key: 'c1', label: 'Check refrigerant' }],
    ...over,
  };
}

function summary(over: Partial<JobTemplateSummary>): JobTemplateSummary {
  return {
    id: 't1',
    user_id: 'owner',
    name: 'Template',
    description: null,
    service_type: null,
    expected_duration_minutes: null,
    price_cents: 0,
    active: true,
    times_used: 0,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    service_count: 0,
    part_count: 0,
    checklist_count: 0,
    ...over,
  };
}

describe('money & number parsing', () => {
  it('parses dollars into integer cents without float drift', () => {
    expect(parseDollarsToCents('149.50')).toBe(14950);
    expect(parseDollarsToCents('$1,200')).toBe(120000);
    expect(parseDollarsToCents('0.1')).toBe(10);
    expect(parseDollarsToCents('19.99')).toBe(1999);
  });

  it('rejects malformed or negative money', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('12.345')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
  });

  it('parses quantities and whole numbers strictly', () => {
    expect(parseQuantity('1.5')).toBe(1.5);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('-1')).toBeNull();
    expect(parsePositiveInt('3')).toBe(3);
    expect(parsePositiveInt('3.5')).toBeNull();
    expect(parsePositiveInt('0')).toBeNull();
  });

  it('round-trips cents to an input string', () => {
    expect(centsToInput(14950)).toBe('149.50');
    expect(centsToInput(12000)).toBe('120');
    expect(centsToInput(0)).toBe('');
  });

  it('formats durations', () => {
    expect(formatDuration(null)).toBe('Not set');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 hr');
    expect(formatDuration(95)).toBe('1 hr 35 min');
  });

  it('totals service lines', () => {
    expect(servicesTotalCents([{ quantity: 2, unit_price_cents: 5000 }, { quantity: 1.5, unit_price_cents: 1000 }])).toBe(11500);
    const form = validForm({
      services: [
        { key: 'a', service_name: 'A', price_book_item_id: '', quantity: '2', unit_price: '50' },
        { key: 'b', service_name: 'B', price_book_item_id: '', quantity: 'oops', unit_price: '10' },
      ],
    });
    // The invalid row is ignored rather than poisoning the total.
    expect(formServicesTotalCents(form.services)).toBe(10000);
  });
});

describe('validateTemplateForm', () => {
  it('accepts a complete form', () => {
    expect(validateTemplateForm(validForm())).toEqual({});
  });

  it('requires a name', () => {
    expect(validateTemplateForm(validForm({ name: '   ' })).name).toBeTruthy();
  });

  it('bounds duration', () => {
    expect(validateTemplateForm(validForm({ duration_minutes: '2' })).duration_minutes).toBeTruthy();
    expect(validateTemplateForm(validForm({ duration_minutes: '99999' })).duration_minutes).toBeTruthy();
    expect(validateTemplateForm(validForm({ duration_minutes: '' })).duration_minutes).toBeUndefined();
  });

  it('flags blank service names, bad quantities and blank checklist items', () => {
    const svc = [{ key: 's', service_name: '', price_book_item_id: '', quantity: '1', unit_price: '10' }];
    expect(validateTemplateForm(validForm({ services: svc })).services).toBeTruthy();
    const qty = [{ key: 's', service_name: 'X', price_book_item_id: '', quantity: '0', unit_price: '10' }];
    expect(validateTemplateForm(validForm({ services: qty })).services).toBeTruthy();
    expect(validateTemplateForm(validForm({ checklist: [{ key: 'c', label: '  ' }] })).checklist).toBeTruthy();
  });

  it('flags non-integer part quantities', () => {
    const parts = [{ key: 'p', part_id: 'x', part_name: 'X', part_number: '', quantity: '1.5' }];
    expect(validateTemplateForm(validForm({ parts })).parts).toBeTruthy();
  });
});

describe('formToPayload', () => {
  it('builds a normalised RPC payload', () => {
    const payload = formToPayload(validForm({ name: '  AC tune-up  ' }));
    expect(payload.name).toBe('AC tune-up');
    expect(payload.expected_duration_minutes).toBe(90);
    expect(payload.price_cents).toBe(14950);
    expect(payload.services).toEqual([
      { service_name: 'Inspection', price_book_item_id: null, quantity: 1, unit_price_cents: 9900 },
    ]);
    expect(payload.checklist).toEqual(['Check refrigerant']);
  });

  it('merges duplicate parts by summing quantity', () => {
    const parts = [
      { key: 'a', part_id: 'p1', part_name: 'Filter', part_number: '', quantity: '2' },
      { key: 'b', part_id: 'p1', part_name: 'Filter', part_number: '', quantity: '3' },
      { key: 'c', part_id: 'p2', part_name: 'Belt', part_number: '', quantity: '1' },
    ];
    expect(formToPayload(validForm({ parts })).parts).toEqual([
      { part_id: 'p1', quantity: 5 },
      { part_id: 'p2', quantity: 1 },
    ]);
  });

  it('treats an empty price/duration as unset', () => {
    const payload = formToPayload(validForm({ price: '', duration_minutes: '' }));
    expect(payload.price_cents).toBe(0);
    expect(payload.expected_duration_minutes).toBeNull();
  });

  it('throws the first validation message for an invalid form', () => {
    expect(() => formToPayload(validForm({ name: '' }))).toThrow('Give the template a name.');
  });
});

describe('templateToForm', () => {
  it('round-trips a detail row into the form and back to the same payload', () => {
    const detail: JobTemplateDetail = {
      ...summary({ name: 'Water heater swap', service_type: 'Plumbing', expected_duration_minutes: 180, price_cents: 120000 }),
      services: [{ service_name: 'Install', price_book_item_id: 'pb1', quantity: 1, unit_price_cents: 90000 }],
      parts: [{ part_id: 'p1', part_name: 'Heater 50gal', part_number: 'WH-50', quantity: 1 }],
      checklist: ['Shut off water', 'Test for leaks'],
    };
    const payload = formToPayload(templateToForm(detail));
    expect(payload.price_cents).toBe(120000);
    expect(payload.expected_duration_minutes).toBe(180);
    expect(payload.services[0].price_book_item_id).toBe('pb1');
    expect(payload.checklist).toEqual(['Shut off water', 'Test for leaks']);
  });
});

describe('filterTemplates', () => {
  const list = [
    summary({ id: '1', name: 'Drain cleaning', service_type: 'Plumbing', times_used: 2 }),
    summary({ id: '2', name: 'AC tune-up', service_type: 'HVAC', times_used: 9 }),
    summary({ id: '3', name: 'Old furnace check', service_type: 'HVAC', active: false, times_used: 1 }),
  ];

  it('filters by status and sorts most-used first', () => {
    expect(filterTemplates(list, '', 'active').map((t) => t.id)).toEqual(['2', '1']);
    expect(filterTemplates(list, '', 'archived').map((t) => t.id)).toEqual(['3']);
    expect(filterTemplates(list, '', 'all')).toHaveLength(3);
  });

  it('searches name, service type and description case-insensitively', () => {
    expect(filterTemplates(list, 'hvac', 'all').map((t) => t.id)).toEqual(['2', '3']);
    expect(filterTemplates(list, 'DRAIN', 'active').map((t) => t.id)).toEqual(['1']);
    expect(filterTemplates(list, 'nope', 'all')).toEqual([]);
  });
});

describe('checklistProgress', () => {
  it('computes progress and handles an empty list', () => {
    expect(checklistProgress([])).toEqual({ total: 0, done: 0, pct: 0 });
    expect(checklistProgress([{ completed_at: 'x' }, { completed_at: null }, { completed_at: 'y' }])).toEqual({
      total: 3,
      done: 2,
      pct: 67,
    });
  });
});

describe('describeTemplateError', () => {
  it('maps database errors to friendly messages', () => {
    expect(describeTemplateError({ code: '23505', message: 'duplicate key' })).toMatch(/already exists/);
    expect(describeTemplateError({ code: '42501', message: 'x' })).toMatch(/permission/);
    expect(describeTemplateError({ message: 'template_already_applied' })).toMatch(/already applied/);
    expect(describeTemplateError({ message: 'invalid_part' })).toMatch(/inventory/);
  });

  it('passes plain Error messages through and falls back otherwise', () => {
    expect(describeTemplateError(new Error('Enter a valid price.'))).toBe('Enter a valid price.');
    expect(describeTemplateError(null)).toBe('Something went wrong. Please try again.');
  });
});
