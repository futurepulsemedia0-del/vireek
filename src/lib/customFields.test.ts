import { describe, it, expect } from 'vitest';
import {
  KEY_PATTERN,
  countActiveFilters,
  formatValue,
  isSameCustomData,
  matchesCustomFilters,
  normalizeOptions,
  sanitizeCustomData,
  slugifyKey,
  tableFields,
  validateCustomData,
  validateDefinitionInput,
  validateValue,
  type CustomFieldDef,
  type CustomFieldType,
} from './customFields';

let seq = 0;
function def(over: Partial<CustomFieldDef> & { field_type: CustomFieldType; key: string }): CustomFieldDef {
  seq++;
  return {
    id: `d${seq}`,
    user_id: 'owner',
    entity: 'customer',
    label: over.key,
    options: [],
    required: false,
    show_in_table: true,
    show_in_filters: true,
    sort_order: seq,
    archived_at: null,
    created_at: `2026-01-0${(seq % 9) + 1}T00:00:00Z`,
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const tier = def({ key: 'tier', label: 'Tier', field_type: 'select', options: ['Gold', 'Silver'] });
const sqft = def({ key: 'sqft', label: 'Square feet', field_type: 'number' });
const gate = def({ key: 'gate_code', label: 'Gate code', field_type: 'text' });
const install = def({ key: 'install_date', label: 'Install date', field_type: 'date' });
const pets = def({ key: 'has_pets', label: 'Has pets', field_type: 'boolean' });
const old = def({ key: 'legacy', label: 'Legacy', field_type: 'text', archived_at: '2026-02-01T00:00:00Z' });
const ALL = [tier, sqft, gate, install, pets, old];

describe('slugifyKey', () => {
  it('produces DB-safe keys that match the SQL constraint', () => {
    for (const label of ['Gate Code', '  Zoë’s Café!! ', '2nd floor', 'a'.repeat(100), '!!!']) {
      expect(KEY_PATTERN.test(slugifyKey(label))).toBe(true);
    }
    expect(slugifyKey('Gate Code')).toBe('gate_code');
    expect(slugifyKey('2nd floor')).toBe('f_2nd_floor');
  });

  it('falls back for non-Latin labels and de-duplicates', () => {
    expect(slugifyKey('کد دروازه')).toBe('field');
    expect(slugifyKey('کد دروازه', ['field'])).toBe('field_2');
    expect(slugifyKey('Gate Code', ['gate_code', 'gate_code_2'])).toBe('gate_code_3');
  });
});

describe('definitions', () => {
  it('normalizes options (trim, collapse, case-insensitive de-dupe)', () => {
    expect(normalizeOptions('Gold\n  silver \n\nGOLD\nBronze  tier')).toEqual(['Gold', 'silver', 'Bronze tier']);
  });

  it('validates labels, duplicates and select options', () => {
    expect(validateDefinitionInput({ label: '', field_type: 'text', options: [] })).toBeTruthy();
    expect(validateDefinitionInput({ label: 'x'.repeat(61), field_type: 'text', options: [] })).toBeTruthy();
    expect(validateDefinitionInput({ label: 'Tier', field_type: 'text', options: [] }, ['tier'])).toBe(
      'A field with this name already exists.',
    );
    expect(validateDefinitionInput({ label: 'Tier', field_type: 'select', options: [] })).toBe('Add at least one option.');
    expect(validateDefinitionInput({ label: 'Tier', field_type: 'select', options: ['A'] })).toBe(null);
    expect(validateDefinitionInput({ label: 'Notes', field_type: 'text', options: [] })).toBe(null);
  });
});

describe('validateValue', () => {
  it('treats blanks as null for every type', () => {
    for (const d of ALL) expect(validateValue(d, '')).toEqual({ ok: true, value: null });
  });
  it('coerces numbers from form strings and rejects junk', () => {
    expect(validateValue(sqft, '1,250.5')).toEqual({ ok: true, value: 1250.5 });
    expect(validateValue(sqft, 'abc').ok).toBe(false);
    expect(validateValue(sqft, 1e20).ok).toBe(false);
  });
  it('only accepts listed select options', () => {
    expect(validateValue(tier, 'Gold')).toEqual({ ok: true, value: 'Gold' });
    expect(validateValue(tier, 'Platinum').ok).toBe(false);
  });
  it('validates real calendar dates', () => {
    expect(validateValue(install, '2026-02-28').ok).toBe(true);
    expect(validateValue(install, '2026-02-30').ok).toBe(false);
    expect(validateValue(install, '02/28/2026').ok).toBe(false);
  });
  it('accepts booleans and their string forms', () => {
    expect(validateValue(pets, true)).toEqual({ ok: true, value: true });
    expect(validateValue(pets, 'false')).toEqual({ ok: true, value: false });
    expect(validateValue(pets, 'maybe').ok).toBe(false);
  });
  it('caps text length', () => {
    expect(validateValue(gate, 'x'.repeat(501)).ok).toBe(false);
    expect(validateValue(gate, '  1234  ')).toEqual({ ok: true, value: '1234' });
  });
});

describe('validateCustomData / sanitizeCustomData', () => {
  it('enforces required on active non-boolean fields only', () => {
    const req = def({ key: 'must', label: 'Must have', field_type: 'text', required: true });
    const reqBool = def({ key: 'rb', label: 'Req bool', field_type: 'boolean', required: true });
    const archivedReq = def({ key: 'ar', label: 'Old req', field_type: 'text', required: true, archived_at: '2026-01-01T00:00:00Z' });
    expect(validateCustomData([req, reqBool, archivedReq], {})).toEqual(['Must have is required.']);
    expect(validateCustomData([req], { must: 'ok' })).toEqual([]);
  });

  it('reports invalid values', () => {
    expect(validateCustomData(ALL, { sqft: 'abc', tier: 'Nope' }).length).toBe(2);
  });

  it('drops blanks + unknown keys, coerces types, keeps archived values', () => {
    const out = sanitizeCustomData(ALL, {
      tier: 'Gold',
      sqft: '1200',
      gate_code: '  ',
      has_pets: false,
      legacy: 'keep me',
      hacker: 'x',
    });
    expect(out).toEqual({ tier: 'Gold', sqft: 1200, has_pets: false, legacy: 'keep me' });
  });

  it('compares data ignoring blanks', () => {
    expect(isSameCustomData({ a: '1', b: '' }, { a: '1' })).toBe(true);
    expect(isSameCustomData({ a: '1' }, { a: '2' })).toBe(false);
    expect(isSameCustomData(null, {})).toBe(true);
  });
});

describe('display', () => {
  it('formats values', () => {
    expect(formatValue(pets, true)).toBe('Yes');
    expect(formatValue(pets, false)).toBe('No');
    expect(formatValue(sqft, 12500)).toBe('12,500');
    expect(formatValue(gate, '')).toBe('');
  });
  it('lists only active, table-visible fields in order', () => {
    const hidden = def({ key: 'hid', field_type: 'text', show_in_table: false });
    expect(tableFields([hidden, old, tier, sqft]).map((d) => d.key)).toEqual(['tier', 'sqft']);
  });
});

describe('matchesCustomFilters', () => {
  const rec = { tier: 'Gold', sqft: 1200, gate_code: 'AB-1234', install_date: '2026-03-10', has_pets: true };

  it('matches everything when no filter is set', () => {
    expect(matchesCustomFilters(rec, ALL, {})).toBe(true);
    expect(matchesCustomFilters({}, ALL, { tier: { value: '' } })).toBe(true);
  });
  it('filters each type', () => {
    expect(matchesCustomFilters(rec, ALL, { tier: { value: 'Gold' } })).toBe(true);
    expect(matchesCustomFilters(rec, ALL, { tier: { value: 'Silver' } })).toBe(false);
    expect(matchesCustomFilters(rec, ALL, { gate_code: { value: 'ab-12' } })).toBe(true);
    expect(matchesCustomFilters(rec, ALL, { sqft: { min: '1000', max: '1500' } })).toBe(true);
    expect(matchesCustomFilters(rec, ALL, { sqft: { min: '1300' } })).toBe(false);
    expect(matchesCustomFilters(rec, ALL, { install_date: { min: '2026-03-01', max: '2026-03-31' } })).toBe(true);
    expect(matchesCustomFilters(rec, ALL, { install_date: { max: '2026-03-01' } })).toBe(false);
    expect(matchesCustomFilters(rec, ALL, { has_pets: { value: 'yes' } })).toBe(true);
    expect(matchesCustomFilters(rec, ALL, { has_pets: { value: 'no' } })).toBe(false);
  });
  it('excludes records that have no value for an active filter', () => {
    expect(matchesCustomFilters({}, ALL, { tier: { value: 'Gold' } })).toBe(false);
    expect(matchesCustomFilters(null, ALL, { sqft: { min: '1' } })).toBe(false);
  });
  it('ignores filters for fields not marked filterable or archived', () => {
    const noFilter = def({ key: 'nf', field_type: 'text', show_in_filters: false });
    expect(matchesCustomFilters({}, [noFilter], { nf: { value: 'x' } })).toBe(true);
    expect(matchesCustomFilters({}, [old], { legacy: { value: 'x' } })).toBe(true);
  });
  it('counts active filters', () => {
    expect(countActiveFilters(ALL, { tier: { value: 'Gold' }, sqft: { min: '1' }, gate_code: { value: ' ' } })).toBe(2);
  });
});
