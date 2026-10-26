import { describe, expect, it } from 'vitest';
import type { FormTemplate } from './formSchema';
import { buildSubmission, sourceKey } from './formLogic';

const template: FormTemplate = {
  id: 't1', slug: 'startup', title: 'Startup', version: 1,
  fields: [{ id: 'supply_temp', type: 'number', label: 'Supply temp', unit: '°F' }],
};
const none = { photos: {}, signatures: {} };
const SOURCE = 'bluetooth | Probe | 2027-01-05T10:00:00.000Z';

describe('instrument provenance on number answers', () => {
  it('stores where an instrument reading came from next to the number', () => {
    const { data } = buildSubmission(template, { supply_temp: '55.2', [sourceKey('supply_temp')]: SOURCE }, none, 'ref1');
    expect(data.answers.supply_temp).toBe(55.2);
    expect(data.answers[sourceKey('supply_temp')]).toBe(SOURCE);
  });

  it('stores nothing for a typed value, or when the number itself is empty', () => {
    expect(buildSubmission(template, { supply_temp: '55.2', [sourceKey('supply_temp')]: '' }, none, 'r').data.answers).toEqual({ supply_temp: 55.2 });
    expect(buildSubmission(template, { [sourceKey('supply_temp')]: SOURCE }, none, 'r').data.answers).toEqual({});
  });
});
