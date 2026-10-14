import { describe, expect, it } from 'vitest';
import { normalizeField, normalizeTemplates } from './formSchema';
import type { FormField, FormTemplate } from './formSchema';
import {
  buildSubmission,
  evaluateCondition,
  hasBlockingErrors,
  loadDraft,
  noteKey,
  outOfRange,
  photoBounds,
  validateSubmission,
  visibleFields,
} from './formLogic';
import type { FormAttachments } from './formLogic';

const tpl = (fields: FormField[]): FormTemplate => ({ id: 't1', slug: 'inspection', title: 'Inspection', version: 3, fields });
const blob = () => new Blob(['x'], { type: 'image/jpeg' });
const none: FormAttachments = { photos: {}, signatures: {} };

describe('normalizeField (schema v2)', () => {
  it('accepts the new field types and their options', () => {
    const f = normalizeField({
      id: 'psi', type: 'number', label: 'Pressure', min: 40, max: 80, unit: 'psi',
      show_if: { match: 'any', conditions: [{ field: 'a', op: 'equals', value: 'yes' }, { field: 'b', op: 'bogus' }] },
    });
    expect(f?.min).toBe(40);
    expect(f?.unit).toBe('psi');
    // the malformed condition is dropped, the valid one kept
    expect(f?.show_if).toEqual({ match: 'any', conditions: [{ field: 'a', op: 'equals', value: 'yes' }] });
    expect(normalizeField({ id: 'p', type: 'photo', label: 'P', min_photos: 99, max_photos: 0 })).toMatchObject({ min_photos: 10, max_photos: 1 });
    expect(normalizeField({ id: 'pf', type: 'pass_fail', label: 'PF', allow_na: true, note_on_fail: true })).toMatchObject({ allow_na: true, note_on_fail: true });
    expect(normalizeField({ id: 's', type: 'signature', label: 'Sign' })?.type).toBe('signature');
  });

  it('still drops fields a device cannot render', () => {
    expect(normalizeField({ id: 'x', type: 'select', label: 'X', options: [] })).toBeNull();
    expect(normalizeField({ id: 'x', type: 'hologram', label: 'X' })).toBeNull();
    expect(normalizeField({ type: 'text', label: 'no id' })).toBeNull();
  });

  it('drops show_if entirely when no valid condition remains', () => {
    const f = normalizeField({ id: 'x', type: 'text', label: 'X', show_if: { match: 'all', conditions: [{ op: 'equals' }] } });
    expect(f?.show_if).toBeUndefined();
  });

  it('keeps legacy templates working', () => {
    const out = normalizeTemplates([{ id: '1', slug: 's', title: 'T', schema: { fields: [{ id: 'a', type: 'text', label: 'A' }] } }]);
    expect(out[0].fields[0].id).toBe('a');
    expect(normalizeTemplates('junk')).toEqual([]);
  });
});

describe('evaluateCondition', () => {
  it('compares text, booleans and numbers sensibly', () => {
    expect(evaluateCondition({ field: 'a', op: 'equals', value: 'yes' }, { a: 'yes' })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'not_equals', value: 'yes' }, { a: 'no' })).toBe(true);
    expect(evaluateCondition({ field: 'c', op: 'equals', value: true }, { c: true })).toBe(true);
    expect(evaluateCondition({ field: 'c', op: 'equals', value: true }, {})).toBe(false);
    expect(evaluateCondition({ field: 'n', op: 'equals', value: 10 }, { n: '10.0' })).toBe(true);
    expect(evaluateCondition({ field: 'n', op: 'greater_than', value: 50 }, { n: '60' })).toBe(true);
    expect(evaluateCondition({ field: 'n', op: 'less_than', value: 50 }, { n: '' })).toBe(false);
    expect(evaluateCondition({ field: 'n', op: 'greater_than', value: 50 }, { n: 'abc' })).toBe(false);
  });

  it('handles is_filled / is_empty', () => {
    expect(evaluateCondition({ field: 'a', op: 'is_filled' }, { a: '  ' })).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'is_filled' }, { a: 'x' })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'is_empty' }, {})).toBe(true);
  });
});

describe('visibleFields', () => {
  const t = tpl([
    { id: 'leak', type: 'pass_fail', label: 'Leak test' },
    { id: 'detail', type: 'textarea', label: 'Detail', required: true, show_if: { match: 'all', conditions: [{ field: 'leak', op: 'equals', value: 'fail' }] } },
    { id: 'photo', type: 'photo', label: 'Photo', required: true, show_if: { match: 'all', conditions: [{ field: 'detail', op: 'is_filled' }] } },
  ]);

  it('shows dependent fields only when the logic matches', () => {
    expect(visibleFields(t, {}).map((f) => f.id)).toEqual(['leak']);
    expect(visibleFields(t, { leak: 'fail' }).map((f) => f.id)).toEqual(['leak', 'detail']);
    expect(visibleFields(t, { leak: 'fail', detail: 'drip' }).map((f) => f.id)).toEqual(['leak', 'detail', 'photo']);
  });

  it('hides a whole chain when the root is hidden, even if stale values remain', () => {
    // user answered "fail", typed detail, then flipped back to "pass"
    expect(visibleFields(t, { leak: 'pass', detail: 'drip' }).map((f) => f.id)).toEqual(['leak']);
  });

  it('supports match = any', () => {
    const any = tpl([
      { id: 'a', type: 'yes_no', label: 'A' },
      { id: 'b', type: 'yes_no', label: 'B' },
      { id: 'c', type: 'text', label: 'C', show_if: { match: 'any', conditions: [{ field: 'a', op: 'equals', value: 'yes' }, { field: 'b', op: 'equals', value: 'yes' }] } },
    ]);
    expect(visibleFields(any, { a: 'no', b: 'yes' }).map((f) => f.id)).toContain('c');
    expect(visibleFields(any, { a: 'no', b: 'no' }).map((f) => f.id)).not.toContain('c');
  });
});

describe('validateSubmission', () => {
  it('ignores required fields that are hidden', () => {
    const t = tpl([
      { id: 'leak', type: 'pass_fail', label: 'Leak', required: true },
      { id: 'detail', type: 'textarea', label: 'Detail', required: true, show_if: { match: 'all', conditions: [{ field: 'leak', op: 'equals', value: 'fail' }] } },
    ]);
    expect(validateSubmission(t, { leak: 'pass' }).errors).toEqual({});
    expect(validateSubmission(t, { leak: 'fail' }).errors).toHaveProperty('detail');
    expect(validateSubmission(t, {}).errors).toHaveProperty('leak');
  });

  it('requires a note when a pass/fail item fails and the field asks for it', () => {
    const t = tpl([{ id: 'pf', type: 'pass_fail', label: 'Belt', note_on_fail: true }]);
    expect(validateSubmission(t, { pf: 'fail' }).errors.pf).toMatch(/note/i);
    expect(validateSubmission(t, { pf: 'fail', [noteKey('pf')]: 'frayed' }).errors).toEqual({});
    expect(validateSubmission(t, { pf: 'na' }).errors).toHaveProperty('pf'); // N/A not allowed
    const na = tpl([{ id: 'pf', type: 'pass_fail', label: 'Belt', allow_na: true }]);
    expect(validateSubmission(na, { pf: 'na' }).errors).toEqual({});
  });

  it('warns, but does not block, on out-of-range numbers', () => {
    const t = tpl([{ id: 'psi', type: 'number', label: 'PSI', required: true, min: 40, max: 80, unit: 'psi' }]);
    const r = validateSubmission(t, { psi: '95' });
    expect(hasBlockingErrors(r)).toBe(false);
    expect(r.warnings.psi).toMatch(/expected range/);
    expect(validateSubmission(t, { psi: '60' }).warnings).toEqual({});
    expect(validateSubmission(t, { psi: 'abc' }).errors).toHaveProperty('psi');
    expect(validateSubmission(t, { psi: '' }).errors).toHaveProperty('psi');
    expect(outOfRange({ id: 'x', type: 'number', label: 'x', min: 1 }, 0)).toBe(true);
  });

  it('enforces photo bounds and defaults the minimum to 1 when required', () => {
    const t = tpl([{ id: 'ph', type: 'photo', label: 'Photos', required: true, max_photos: 2 }]);
    expect(photoBounds(t.fields[0])).toEqual({ min: 1, max: 2 });
    expect(validateSubmission(t, {}, none).errors).toHaveProperty('ph');
    const two = { photos: { ph: [{ id: '1', blob: blob() }, { id: '2', blob: blob() }] }, signatures: {} };
    expect(validateSubmission(t, {}, two).errors).toEqual({});
    const three = { photos: { ph: [1, 2, 3].map((n) => ({ id: String(n), blob: blob() })) }, signatures: {} };
    expect(validateSubmission(t, {}, three).errors).toHaveProperty('ph');
    const optional = tpl([{ id: 'ph', type: 'photo', label: 'Photos' }]);
    expect(validateSubmission(optional, {}, none).errors).toEqual({});
  });

  it('requires a signature and a signer name', () => {
    const t = tpl([{ id: 'sig', type: 'signature', label: 'Customer', required: true }]);
    expect(validateSubmission(t, {}, none).errors).toHaveProperty('sig');
    const nameless = { photos: {}, signatures: { sig: { method: 'drawn' as const, data: 'data:image/png;base64,AA==', signerName: ' ' } } };
    expect(validateSubmission(t, {}, nameless).errors.sig).toMatch(/name/i);
    const ok = { photos: {}, signatures: { sig: { method: 'typed' as const, data: 'Sam', typedFont: 'caveat', signerName: 'Sam' } } };
    expect(validateSubmission(t, {}, ok).errors).toEqual({});
  });

  it('rejects a select answer that is not one of the options', () => {
    const t = tpl([{ id: 's', type: 'select', label: 'S', options: ['A', 'B'] }]);
    expect(validateSubmission(t, { s: 'C' }).errors).toHaveProperty('s');
    expect(validateSubmission(t, { s: 'A' }).errors).toEqual({});
  });
});

describe('buildSubmission', () => {
  const t = tpl([
    { id: 'leak', type: 'pass_fail', label: 'Leak', note_on_fail: true },
    { id: 'detail', type: 'textarea', label: 'Detail', show_if: { match: 'all', conditions: [{ field: 'leak', op: 'equals', value: 'fail' }] } },
    { id: 'psi', type: 'number', label: 'PSI', min: 40, max: 80 },
    { id: 'ok', type: 'checkbox', label: 'OK' },
    { id: 'ph', type: 'photo', label: 'Photos' },
    { id: 'sig', type: 'signature', label: 'Sign' },
  ]);

  it('packages answers, drops hidden fields and builds deterministic refs', () => {
    const attachments: FormAttachments = {
      photos: { ph: [{ id: 'a', blob: blob() }, { id: 'b', blob: blob() }] },
      signatures: { sig: { method: 'drawn', data: 'data:image/png;base64,AA==', signerName: ' Sam ' } },
    };
    const built = buildSubmission(
      t,
      { leak: 'pass', detail: 'stale text', psi: '95', ok: true, [noteKey('leak')]: 'ignored' },
      attachments,
      'ref1'
    );
    expect(built.data.answers).toEqual({
      leak: 'pass',
      psi: 95,
      ok: true,
      ph: ['ref1:ph:1', 'ref1:ph:2'],
      sig: 'ref1:sig',
      sig__signer: 'Sam',
    });
    expect(built.data.answers).not.toHaveProperty('detail'); // hidden → dropped
    expect(built.data.summary).toMatchObject({ passed: 1, failed: 0, out_of_range: 1, photos: 2, visible_fields: 5 });
    expect(built.data).toMatchObject({ template_id: 't1', slug: 'inspection', version: 3, schema_version: 2, submission_ref: 'ref1' });
    expect(built.photos.map((p) => p.ref)).toEqual(['ref1:ph:1', 'ref1:ph:2']);
    expect(built.signatures[0].ref).toBe('ref1:sig');
    // a retry with the same ref yields identical refs (server can de-duplicate)
    expect(buildSubmission(t, { leak: 'pass' }, attachments, 'ref1').photos.map((p) => p.ref)).toEqual(['ref1:ph:1', 'ref1:ph:2']);
  });

  it('records the failure note and counts failures', () => {
    const built = buildSubmission(t, { leak: 'fail', detail: 'dripping', [noteKey('leak')]: ' loose fitting ' }, none, 'r');
    expect(built.data.answers).toMatchObject({ leak: 'fail', leak__note: 'loose fitting', detail: 'dripping' });
    expect(built.data.summary.failed).toBe(1);
  });
});

describe('drafts', () => {
  it('returns {} when storage is unavailable or corrupt', () => {
    // No localStorage in a plain Node/Vitest "node" environment: must not throw.
    expect(loadDraft('missing-key')).toEqual({});
  });
});
