import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES, normalizeTemplates, sortForService, toAnswers, validateValues, type FormTemplate,
} from './forms';

const hvac: FormTemplate = { id: 'a', slug: 'hvac_tuneup', title: 'HVAC', trade: 'hvac', version: 1, fields: [{ id: 'x', type: 'text', label: 'X' }] };
const plumbing: FormTemplate = { id: 'b', slug: 'plumbing_completion', title: 'Plumbing', trade: 'plumbing', version: 1, fields: [{ id: 'x', type: 'text', label: 'X' }] };
const general: FormTemplate = { id: 'c', slug: 'job_completion', title: 'General', trade: 'general', version: 1, fields: [{ id: 'x', type: 'text', label: 'X' }] };

describe('normalizeTemplates', () => {
  it('keeps valid templates and drops malformed fields / templates', () => {
    const out = normalizeTemplates([
      {
        id: '1', slug: 's', title: 'T', version: 2,
        schema: { fields: [
          { id: 'a', type: 'text', label: 'A', required: true },
          { id: 'b', type: 'select', label: 'B', options: [] }, // select without options → dropped
          { id: 'c', type: 'bogus', label: 'C' }, // unknown type → dropped
          { type: 'text', label: 'no id' }, // no id → dropped
        ] },
      },
      { id: '2', slug: 'empty', title: 'No fields', schema: { fields: [] } }, // no usable fields → dropped
      null,
      'junk',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fields.map((f) => f.id)).toEqual(['a']);
    expect(out[0].version).toBe(2);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeTemplates(undefined)).toEqual([]);
    expect(normalizeTemplates({})).toEqual([]);
  });
});

describe('sortForService', () => {
  it('puts the matching trade first and keeps the rest in order', () => {
    expect(sortForService([general, plumbing, hvac], 'AC repair').map((t) => t.slug)).toEqual(['hvac_tuneup', 'job_completion', 'plumbing_completion']);
    expect(sortForService([general, plumbing, hvac], 'Drain cleaning').map((t) => t.slug)).toEqual(['plumbing_completion', 'job_completion', 'hvac_tuneup']);
  });
  it('keeps the original order when the service type is unknown', () => {
    expect(sortForService([general, plumbing, hvac], null).map((t) => t.slug)).toEqual(['job_completion', 'plumbing_completion', 'hvac_tuneup']);
  });
});

describe('validateValues / toAnswers', () => {
  const t = BUILTIN_TEMPLATES[0]; // job_completion: work_performed, system_tested, follow_up_needed required

  it('flags every missing required field', () => {
    expect(Object.keys(validateValues(t, {})).sort()).toEqual(['follow_up_needed', 'system_tested', 'work_performed']);
  });

  it('accepts a complete form', () => {
    expect(validateValues(t, { work_performed: 'Replaced capacitor', system_tested: true, follow_up_needed: 'no' })).toEqual({});
  });

  it('requires checkbox = true, yes/no choice, and a real number', () => {
    const tpl: FormTemplate = {
      id: 'n', slug: 'n', title: 'N', version: 1,
      fields: [
        { id: 'c', type: 'checkbox', label: 'C', required: true },
        { id: 'y', type: 'yes_no', label: 'Y', required: true },
        { id: 'n', type: 'number', label: 'N', required: true },
      ],
    };
    expect(Object.keys(validateValues(tpl, { c: false, y: 'maybe', n: 'abc' })).sort()).toEqual(['c', 'n', 'y']);
    expect(validateValues(tpl, { c: true, y: 'yes', n: '12.5' })).toEqual({});
  });

  it('packages answers: trims text, converts numbers, ignores unknown keys and empty values', () => {
    const tpl: FormTemplate = {
      id: 'n', slug: 'n', title: 'N', version: 1,
      fields: [
        { id: 't', type: 'text', label: 'T' },
        { id: 'n', type: 'number', label: 'N' },
        { id: 'c', type: 'checkbox', label: 'C' },
        { id: 'e', type: 'text', label: 'E' },
      ],
    };
    expect(toAnswers(tpl, { t: '  hi  ', n: '42', c: true, e: '   ', injected: 'x' } as never)).toEqual({ t: 'hi', n: 42, c: true });
  });
});
