import { describe, expect, it, vi } from 'vitest';

// The module imports the Supabase client at load time; only pure helpers are tested here.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  createField,
  defaultCondition,
  describeFormError,
  duplicateField,
  eligibleSources,
  emptyBuilderState,
  filterManaged,
  fromTemplate,
  groupManagedTemplates,
  insertField,
  lintBuilder,
  moveFieldBy,
  moveFieldToGap,
  operatorsFor,
  parseOptions,
  removeField,
  renameFieldId,
  slugify,
  snapshotOf,
  stateToTemplate,
  toSchema,
  uniqueTemplateSlug,
} from './formBuilder';
import type { BuilderField, BuilderState, RawTemplateRow } from './formBuilder';

function build(...types: Array<Parameters<typeof createField>[0]>): BuilderField[] {
  let fields: BuilderField[] = [];
  for (const t of types) fields = insertField(fields, createField(t, fields), fields.length);
  return fields;
}

function state(fields: BuilderField[], over: Partial<BuilderState> = {}): BuilderState {
  return { ...emptyBuilderState(), title: 'Rooftop inspection', fields, ...over };
}

describe('slugs and ids', () => {
  it('slugifies, strips accents and keeps within the limit', () => {
    expect(slugify('Pré-Start Checklist!', new Set(), 60, 'form')).toBe('pre_start_checklist');
    expect(slugify('!!!', new Set(), 60, 'form')).toBe('form');
    expect(slugify('a'.repeat(100), new Set(), 40, 'x')).toHaveLength(40);
  });

  it('suffixes to avoid collisions and respects the max length', () => {
    expect(slugify('Safety', new Set(['safety']), 60, 'form')).toBe('safety_2');
    expect(slugify('Safety', new Set(['safety', 'safety_2']), 60, 'form')).toBe('safety_3');
    const long = 'x'.repeat(40);
    expect(slugify(long, new Set([long]), 40, 'f')).toHaveLength(40);
  });

  it('never reuses a taken template slug (including built-in defaults)', () => {
    expect(uniqueTemplateSlug('HVAC tune-up', new Set(['hvac_tune_up']))).toBe('hvac_tune_up_2');
    expect(uniqueTemplateSlug('A', new Set())).toBe('a_form'); // min length 2
  });

  it('creates fields with unique ids and sensible defaults', () => {
    const fields = build('pass_fail', 'pass_fail', 'select', 'photo');
    expect(new Set(fields.map((f) => f.id)).size).toBe(4);
    expect(fields[0].noteOnFail).toBe(true);
    expect(fields[2].optionsText).toContain('Option 1');
    expect(fields[3].type).toBe('photo');
  });
});

describe('ordering', () => {
  const fields = build('text', 'number', 'photo', 'signature');
  const ids = (list: BuilderField[]) => list.map((f) => f.id);

  it('moves a field into a drop gap (accounting for its own removal)', () => {
    const [a, b, c, d] = fields;
    expect(ids(moveFieldToGap(fields, a.key, 3))).toEqual([b.id, c.id, a.id, d.id]); // gap after c
    expect(ids(moveFieldToGap(fields, d.key, 0))).toEqual([d.id, a.id, b.id, c.id]);
    expect(moveFieldToGap(fields, b.key, 1)).toBe(fields); // gap right before itself: no-op
    expect(moveFieldToGap(fields, b.key, 2)).toBe(fields); // gap right after itself: no-op
  });

  it('moves by one step and stops at the edges', () => {
    const [a, b] = fields;
    expect(ids(moveFieldBy(fields, a.key, 1)).slice(0, 2)).toEqual([b.id, a.id]);
    expect(moveFieldBy(fields, a.key, -1)).toBe(fields);
    expect(moveFieldBy(fields, fields[3].key, 1)).toBe(fields);
  });

  it('inserts at a clamped index', () => {
    const extra = createField('text', fields);
    expect(insertField(fields, extra, 99)[4]).toBe(extra);
    expect(insertField(fields, extra, -5)[0]).toBe(extra);
  });

  it('duplicates a field right after the original with a fresh id and key', () => {
    const out = duplicateField(fields, fields[1].key);
    expect(out).toHaveLength(5);
    expect(out[2].id).not.toBe(fields[1].id);
    expect(out[2].key).not.toBe(fields[1].key);
    expect(out[2].label).toMatch(/\(copy\)$/);
  });
});

describe('conditional logic editing', () => {
  it('only offers earlier, non-attachment fields as sources', () => {
    const fields = build('yes_no', 'photo', 'number', 'text');
    expect(eligibleSources(fields, fields[3].key).map((f) => f.type)).toEqual(['yes_no', 'number']);
    expect(eligibleSources(fields, fields[0].key)).toEqual([]);
  });

  it('offers operators that make sense for the source type', () => {
    expect(operatorsFor('number').map((o) => o.op)).toContain('greater_than');
    expect(operatorsFor('text').map((o) => o.op)).not.toContain('greater_than');
    expect(operatorsFor('checkbox')).toHaveLength(1);
  });

  it('defaults pass/fail conditions to "fail" and checkboxes to checked', () => {
    const [pf, cb] = build('pass_fail', 'checkbox');
    expect(defaultCondition(pf)).toEqual({ field: pf.id, op: 'equals', value: 'fail' });
    expect(defaultCondition(cb)).toEqual({ field: cb.id, op: 'equals', value: true });
  });

  it('removing a field strips conditions that depended on it', () => {
    const [a, b, c] = build('yes_no', 'text', 'text');
    const withLogic = [
      a,
      { ...b, showIf: { match: 'all' as const, conditions: [{ field: a.id, op: 'equals' as const, value: 'yes' }] } },
      { ...c, showIf: { match: 'all' as const, conditions: [{ field: a.id, op: 'equals' as const, value: 'yes' }, { field: b.id, op: 'is_filled' as const }] } },
    ];
    const { fields, affected } = removeField(withLogic, a.key);
    expect(affected).toBe(2);
    expect(fields[0].showIf).toBeNull(); // b lost its only condition
    expect(fields[1].showIf?.conditions).toEqual([{ field: b.id, op: 'is_filled' }]); // c keeps the other one
  });

  it('renaming an id rewrites every condition that referenced it', () => {
    const [a, b] = build('yes_no', 'text');
    const withLogic = [a, { ...b, showIf: { match: 'all' as const, conditions: [{ field: a.id, op: 'equals' as const, value: 'yes' }] } }];
    const out = renameFieldId(withLogic, a.key, 'needs_followup');
    expect(out[0].id).toBe('needs_followup');
    expect(out[1].showIf?.conditions[0].field).toBe('needs_followup');
  });
});

describe('lintBuilder', () => {
  it('passes a valid form', () => {
    expect(lintBuilder(state(build('pass_fail', 'number', 'photo', 'signature'))).count).toBe(0);
  });

  it('requires a title and at least one field', () => {
    const r = lintBuilder(state([], { title: ' ' }));
    expect(r.form.length).toBe(2);
  });

  it('flags duplicate ids, blank labels, bad ids', () => {
    const [a, b] = build('text', 'text');
    const r = lintBuilder(state([a, { ...b, id: a.id, label: '' }]));
    expect(r.fields[b.key].length).toBe(2);
    expect(lintBuilder(state([{ ...a, id: 'Bad Id!' }])).fields[a.key][0]).toMatch(/id/);
  });

  it('flags selects without options and inverted ranges', () => {
    const [sel, num, ph] = build('select', 'number', 'photo');
    expect(lintBuilder(state([{ ...sel, optionsText: '  \n ' }])).fields[sel.key][0]).toMatch(/option/i);
    expect(lintBuilder(state([{ ...num, min: '10', max: '5' }])).fields[num.key][0]).toMatch(/minimum/i);
    expect(lintBuilder(state([{ ...num, min: 'abc' }])).fields[num.key][0]).toMatch(/number/i);
    expect(lintBuilder(state([{ ...ph, minPhotos: '3', maxPhotos: '2' }])).fields[ph.key].length).toBeGreaterThan(0);
    expect(lintBuilder(state([{ ...ph, maxPhotos: '11' }])).fields[ph.key].length).toBeGreaterThan(0);
  });

  it('rejects conditions on later, missing or attachment fields', () => {
    const [a, b, c] = build('yes_no', 'text', 'photo');
    const cond = (field: string) => ({ match: 'all' as const, conditions: [{ field, op: 'equals' as const, value: 'yes' }] });
    // forward reference
    expect(lintBuilder(state([{ ...a, showIf: cond(b.id) }, b])).fields[a.key][0]).toMatch(/after|missing/);
    // missing field
    expect(lintBuilder(state([a, { ...b, showIf: cond('ghost') }])).fields[b.key][0]).toMatch(/missing/);
    // depends on a photo
    const bad = lintBuilder(state([c, { ...b, showIf: { match: 'all', conditions: [{ field: c.id, op: 'is_filled' }] } }]));
    expect(bad.fields[b.key].join(' ')).toMatch(/photo or signature/);
    // valid
    expect(lintBuilder(state([a, { ...b, showIf: cond(a.id) }])).count).toBe(0);
  });

  it('requires a value for comparisons but not for is_filled', () => {
    const [a, b] = build('number', 'text');
    const noValue = { match: 'all' as const, conditions: [{ field: a.id, op: 'greater_than' as const }] };
    expect(lintBuilder(state([a, { ...b, showIf: noValue }])).count).toBeGreaterThan(0);
    const filled = { match: 'all' as const, conditions: [{ field: a.id, op: 'is_filled' as const }] };
    expect(lintBuilder(state([a, { ...b, showIf: filled }])).count).toBe(0);
  });
});

describe('conversion', () => {
  it('round-trips through the schema', () => {
    const [pf, num, sel, ph] = build('pass_fail', 'number', 'select', 'photo');
    const fields: BuilderField[] = [
      { ...pf, required: true, allowNa: true, noteOnFail: true },
      { ...num, min: '40', max: '80', unit: ' psi ', showIf: { match: 'any', conditions: [{ field: pf.id, op: 'equals', value: 'fail' }] } },
      { ...sel, optionsText: 'A\nB\nA\n\n C ' },
      { ...ph, minPhotos: '1', maxPhotos: '4' },
    ];
    const schema = toSchema(state(fields));
    expect(schema.fields[1]).toMatchObject({ min: 40, max: 80, unit: 'psi' });
    expect(schema.fields[2].options).toEqual(['A', 'B', 'C']); // trimmed + de-duplicated
    expect(schema.fields[3]).toMatchObject({ min_photos: 1, max_photos: 4 });

    const back = fromTemplate({ title: 'T', description: null, trade: 'hvac', fields: schema.fields });
    expect(back.trade).toBe('hvac');
    expect(toSchema(back)).toEqual(schema);
  });

  it('coerces condition values to the source type', () => {
    const [num, cb, txt] = build('number', 'checkbox', 'text');
    const fields: BuilderField[] = [
      num,
      cb,
      { ...txt, showIf: { match: 'all', conditions: [{ field: num.id, op: 'greater_than', value: '50' }, { field: cb.id, op: 'equals', value: 'true' }] } },
    ];
    expect(toSchema(state(fields)).fields[2].show_if?.conditions).toEqual([
      { field: num.id, op: 'greater_than', value: 50 },
      { field: cb.id, op: 'equals', value: true },
    ]);
  });

  it('snapshot changes only when content changes', () => {
    const fields = build('text');
    const a = snapshotOf(state(fields));
    expect(snapshotOf(state(fields))).toBe(a);
    expect(snapshotOf(state(fields, { title: 'Other' }))).not.toBe(a);
    expect(snapshotOf(state([{ ...fields[0], label: 'Changed' }]))).not.toBe(a);
  });

  it('preview template drops fields a device could not render', () => {
    const [sel, txt] = build('select', 'text');
    const t = stateToTemplate(state([{ ...sel, optionsText: '' }, txt]), 's', 1);
    expect(t.fields.map((f) => f.id)).toEqual([txt.id]);
  });
});

describe('groupManagedTemplates / filterManaged', () => {
  const row = (over: Partial<RawTemplateRow>): RawTemplateRow => ({
    id: 'x', owner_id: null, slug: 's', title: 'T', description: null, trade: null, version: 1,
    schema: { fields: [{ id: 'a', type: 'text', label: 'A' }] }, is_active: true, updated_at: '2026-01-01T00:00:00Z', ...over,
  });

  it('prefers the account template (highest version) over a default with the same slug', () => {
    const out = groupManagedTemplates([
      row({ id: 'sys', slug: 'hvac', title: 'Default HVAC' }),
      row({ id: 'own1', owner_id: 'o', slug: 'hvac', title: 'Our HVAC', version: 1, is_active: false }),
      row({ id: 'own2', owner_id: 'o', slug: 'hvac', title: 'Our HVAC', version: 2 }),
      row({ id: 'sys2', slug: 'safety', title: 'Safety' }),
    ]);
    const hvac = out.find((t) => t.slug === 'hvac');
    expect(hvac).toMatchObject({ id: 'own2', version: 2, isSystem: false, overridesDefault: true, versions: 2, active: true });
    expect(out.find((t) => t.slug === 'safety')).toMatchObject({ isSystem: true, overridesDefault: false });
  });

  it('filters by tab and search', () => {
    const list = groupManagedTemplates([
      row({ id: '1', slug: 'a', title: 'Alpha default' }),
      row({ id: '2', owner_id: 'o', slug: 'b', title: 'Bravo custom', trade: 'hvac' }),
      row({ id: '3', owner_id: 'o', slug: 'c', title: 'Charlie archived', is_active: false }),
    ]);
    expect(filterManaged(list, '', 'default').map((t) => t.slug)).toEqual(['a']);
    expect(filterManaged(list, '', 'custom').map((t) => t.slug)).toEqual(['b']);
    expect(filterManaged(list, '', 'archived').map((t) => t.slug)).toEqual(['c']);
    expect(filterManaged(list, 'HVAC', 'all').map((t) => t.slug)).toEqual(['b']);
    expect(filterManaged(list, 'zzz', 'all')).toEqual([]);
  });
});

describe('helpers', () => {
  it('parses options one per line, de-duplicated', () => {
    expect(parseOptions(' A \nB\n\nA')).toEqual(['A', 'B']);
  });

  it('maps server errors to friendly messages', () => {
    expect(describeFormError({ code: '42501', message: 'x' })).toMatch(/permission/);
    expect(describeFormError({ message: 'invalid_schema: field "a" has an unknown type' })).toMatch(/unknown type/);
    expect(describeFormError({ code: '23505', message: 'dup' })).toMatch(/same moment/);
    expect(describeFormError(new Error('Fix the highlighted problems before publishing.'))).toMatch(/highlighted/);
  });
});
