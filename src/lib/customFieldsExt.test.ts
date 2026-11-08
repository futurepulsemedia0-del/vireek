import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXT_ENTITIES,
  EXT_ENTITY_META,
  EXT_FIELD_TYPES,
  allowedFilterOps,
  canReadField,
  canWriteField,
  computeFormula,
  customValueToCsv,
  evalFormula,
  isFieldVisible,
  mapCsvRowToCustomData,
  maskCustomData,
  missingForStage,
  parseFormula,
  validateExtValue,
  type ExtFieldDef,
} from '@/lib/customFieldsExt';

const SQL = readFileSync(resolve(process.cwd(), 'supabase/migrations/20281111000000_custom_fields_expansion.sql'), 'utf8');

function def(over: Partial<ExtFieldDef> & { key: string }): ExtFieldDef {
  return {
    label: over.key, field_type: 'text', options: [], required: false, required_stages: [], read_roles: null,
    write_roles: null, config: {}, archived_at: null, ...over,
  };
}

describe('SQL ↔ TS parity', () => {
  it('entities and field types match the CHECK constraints', () => {
    const ent = /cfd_entity_valid CHECK \(entity IN \(([^)]*)\)\)/.exec(SQL)?.[1] ?? '';
    expect([...ent.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...EXT_ENTITIES].sort());
    const types = /cfd_field_type_valid CHECK \(field_type IN \(([^)]*)\)\)/.exec(SQL)?.[1] ?? '';
    expect([...types.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...EXT_FIELD_TYPES].sort());
  });
  it('entity → table mapping matches custom_table_for_entity()', () => {
    const block = /custom_table_for_entity[\s\S]*?\$\$;/.exec(SQL)?.[0] ?? '';
    for (const e of EXT_ENTITIES) {
      expect(block, e).toContain(`WHEN '${e}' THEN '${EXT_ENTITY_META[e].table}'`);
    }
    expect(/custom_owner_column_for_entity[\s\S]*?\$\$;/.exec(SQL)?.[0]).toContain("p_entity = 'technician' THEN 'account_owner_id'");
  });
});

describe('parseFormula / evalFormula', () => {
  const keys = new Set(['price', 'qty', 'discount']);
  const parse = (s: string) => {
    const r = parseFormula(s, keys);
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r;
  };

  it('respects precedence and parentheses', () => {
    expect(evalFormula(parse('price * qty + 5').ast, { price: 10, qty: 3 })).toBe(35);
    expect(evalFormula(parse('price * (qty + 5)').ast, { price: 10, qty: 3 })).toBe(80);
    expect(evalFormula(parse('10 - 4 - 3').ast, {})).toBe(3);
    expect(evalFormula(parse('-price + 1').ast, { price: 4 })).toBe(-3);
  });
  it('collects sorted references', () => {
    expect(parse('qty * price - discount').refs).toEqual(['discount', 'price', 'qty']);
  });
  it('is null (key dropped) on missing input, division by zero and non-numeric values', () => {
    expect(evalFormula(parse('price / qty').ast, { price: 1, qty: 0 })).toBeNull();
    expect(evalFormula(parse('price * qty').ast, { price: 2 })).toBeNull();
    expect(evalFormula(parse('price * 2').ast, { price: '2' })).toBeNull();
  });
  it('rounds to 6 decimals and drops huge results like the database', () => {
    expect(computeFormula(parse('1 / 3').ast, {})).toBe(0.333333);
    expect(computeFormula(parse('price * 1000000000000').ast, { price: 10000 })).toBeNull();
  });
  it('rejects bad input', () => {
    const bad = (s: string) => parseFormula(s, keys);
    expect(bad('')).toEqual({ ok: false, error: 'empty' });
    expect(bad('price +')).toMatchObject({ ok: false, error: 'syntax' });
    expect(bad('(price')).toMatchObject({ ok: false, error: 'syntax' });
    expect(bad('price ^ 2')).toMatchObject({ ok: false, error: 'syntax' });
    expect(bad('nope * 2')).toEqual({ ok: false, error: 'unknownField', detail: 'nope' });
    expect(bad('1+'.repeat(200))).toMatchObject({ ok: false, error: 'tooLong' });
  });
  it('rejects expressions deeper than the database allows', () => {
    // Right-nested via parentheses: 1+(1+(1+(…))) → depth > 8
    const deep = `${'1+('.repeat(10)}1${')'.repeat(10)}`;
    expect(parseFormula(deep, keys)).toEqual({ ok: false, error: 'tooDeep' });
  });
});

describe('validateExtValue', () => {
  const ms = { field_type: 'multi_select' as const, options: ['a', 'b', 'c'] };
  it('multi_select', () => {
    expect(validateExtValue(ms, ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(validateExtValue(ms, ['a', 'a'])).toEqual({ ok: false, error: 'duplicate' });
    expect(validateExtValue(ms, ['z'])).toEqual({ ok: false, error: 'notAnOption' });
    expect(validateExtValue(ms, 'a')).toEqual({ ok: false, error: 'invalid' });
    expect(validateExtValue(ms, [])).toEqual({ ok: true, value: null });
  });
  it('currency: max 2 decimals, bounded', () => {
    const c = { field_type: 'currency' as const, options: [] };
    expect(validateExtValue(c, '1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(validateExtValue(c, 1.005)).toEqual({ ok: false, error: 'tooPrecise' });
    expect(validateExtValue(c, 2e12)).toEqual({ ok: false, error: 'outOfRange' });
    expect(validateExtValue(c, 'abc')).toEqual({ ok: false, error: 'invalid' });
  });
  it('file paths cannot escape', () => {
    const f = { field_type: 'file' as const, options: [] };
    expect(validateExtValue(f, 'jobs/1/photo.jpg').ok).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'a\\b', 'a\nb']) expect(validateExtValue(f, bad), bad).toEqual({ ok: false, error: 'badPath' });
  });
  it('lookup needs a uuid; formula is never writable', () => {
    const l = { field_type: 'lookup' as const, options: [] };
    expect(validateExtValue(l, '8B7A6C5D-4E3F-4A2B-8C1D-0E9F8A7B6C5D')).toEqual({ ok: true, value: '8b7a6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d' });
    expect(validateExtValue(l, 'nope')).toEqual({ ok: false, error: 'badId' });
    expect(validateExtValue({ field_type: 'formula', options: [] }, 5)).toEqual({ ok: false, error: 'computed' });
  });
});

describe('visibility, stages and permissions', () => {
  it('visible_when', () => {
    const eq = def({ key: 'x', config: { visible_when: { key: 'kind', op: 'eq', value: 'rental' } } });
    expect(isFieldVisible(eq, { kind: 'rental' })).toBe(true);
    expect(isFieldVisible(eq, { kind: 'owner' })).toBe(false);
    expect(isFieldVisible(eq, {})).toBe(false);
    const neq = def({ key: 'x', config: { visible_when: { key: 'kind', op: 'neq', value: 'rental' } } });
    expect(isFieldVisible(neq, {})).toBe(true);
    const set = def({ key: 'x', config: { visible_when: { key: 'kind', op: 'set' } } });
    expect(isFieldVisible(set, { kind: ' ' })).toBe(false);
    const inn = def({ key: 'x', config: { visible_when: { key: 'kind', op: 'in', value: ['a', 'b'] } } });
    expect(isFieldVisible(inn, { kind: 'b' })).toBe(true);
    expect(isFieldVisible(def({ key: 'y' }), {})).toBe(true);
  });
  it('required at stage merges status keys, ignores archived/formula, treats [] as missing', () => {
    const defs = [
      def({ key: 'permit_no', required_stages: ['completed'] }),
      def({ key: 'tags', field_type: 'multi_select', required_stages: ['completed'] }),
      def({ key: 'old', required_stages: ['completed'], archived_at: 'x' }),
      def({ key: 'calc', field_type: 'formula', required_stages: ['completed'] }),
    ];
    expect(missingForStage(defs, 'completed', ['inspector'], { permit_no: 'A1', tags: [] })).toEqual(['inspector', 'tags']);
    expect(missingForStage(defs, 'scheduled', [], {})).toEqual([]);
  });
  it('field permissions: owner always, null = everyone, formula read-only, mask hides unreadable', () => {
    const d = def({ key: 'cost', write_roles: ['admin'], read_roles: ['admin', 'member'] });
    expect(canWriteField(d, 'owner')).toBe(true);
    expect(canWriteField(d, 'technician')).toBe(false);
    expect(canWriteField(def({ key: 'z' }), 'technician')).toBe(true);
    expect(canWriteField(def({ key: 'f', field_type: 'formula' }), 'owner')).toBe(false);
    expect(canReadField(d, 'technician')).toBe(false);
    expect(maskCustomData([d, def({ key: 'open' })], { cost: 5, open: 1 }, 'technician')).toEqual({ open: 1 });
  });
});

describe('import / export', () => {
  const defs = [
    def({ key: 'sqft', field_type: 'number' }),
    def({ key: 'rental', field_type: 'boolean' }),
    def({ key: 'since', field_type: 'date' }),
    def({ key: 'tier', field_type: 'select', options: ['Gold', 'Silver'] }),
    def({ key: 'tags', field_type: 'multi_select', options: ['a', 'b'] }),
    def({ key: 'cost', field_type: 'currency' }),
    def({ key: 'calc', field_type: 'formula' }),
  ];
  it('maps and coerces a row, reporting every bad cell', () => {
    const r = mapCsvRowToCustomData(
      defs,
      { A: '1,200', B: 'Yes', C: '2026-02-30', D: 'gold', E: 'a; B', F: '19.99', G: '5', H: 'x' },
      { A: 'sqft', B: 'rental', C: 'since', D: 'tier', E: 'tags', F: 'cost', G: 'calc', H: 'unknown' },
    );
    expect(r.data).toEqual({ sqft: 1200, rental: true, tier: 'Gold', tags: ['a', 'b'], cost: 19.99 });
    expect(r.errors).toEqual([{ key: 'since', error: 'invalidDate' }]);
  });
  it('flags unknown options and skips blanks', () => {
    const r = mapCsvRowToCustomData(defs, { A: '', D: 'bronze', E: 'a;zzz' }, { A: 'sqft', D: 'tier', E: 'tags' });
    expect(r.data).toEqual({});
    expect(r.errors).toEqual([{ key: 'tier', error: 'notAnOption' }, { key: 'tags', error: 'notAnOption' }]);
  });
  it('exports flat strings', () => {
    expect(customValueToCsv({ field_type: 'multi_select' }, ['a', 'b'])).toBe('a; b');
    expect(customValueToCsv({ field_type: 'boolean' }, false)).toBe('false');
    expect(customValueToCsv({ field_type: 'text' }, null)).toBe('');
  });
  it('filter ops per type', () => {
    expect(allowedFilterOps('multi_select')).toEqual(['has']);
    expect(allowedFilterOps('file')).toEqual([]);
    expect(allowedFilterOps('currency')).toContain('gte');
  });
});
