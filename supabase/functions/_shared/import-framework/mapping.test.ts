import { describe, expect, it } from 'vitest';
import { createCsvAdapter } from './adapters/csv.ts';
import { IMPORT_ENTITIES } from './entities.ts';
import { entityOrder, mapRecord, validateMapping } from './mapping.ts';
import { CUSTOMERS_CSV, JOBS_CSV, MAPPING, clone } from './testFixtures.ts';

const adapter = createCsvAdapter({ customers: CUSTOMERS_CSV, jobs: JOBS_CSV });
const codes = (m: unknown, a = adapter) => validateMapping(m, IMPORT_ENTITIES, a).issues.map((i) => i.code);

describe('validateMapping', () => {
  it('accepts the reference mapping and returns a normalised copy', () => {
    const r = validateMapping(MAPPING, IMPORT_ENTITIES, adapter);
    expect(r.ok).toBe(true);
    expect(r.config === MAPPING).toBe(false);
    expect(entityOrder(r.config!, IMPORT_ENTITIES)).toEqual(['customers', 'jobs']);
  });
  it('rejects unknown keys, entities, target fields and source columns', () => {
    const m = clone(MAPPING) as any;
    m.extra = 1; m.entities.ghosts = { fields: {} }; m.entities.customers.fields.password = { from: 'Name' }; m.entities.customers.fields.email.from = 'Nope';
    const c = codes(m);
    for (const code of ['UNKNOWN_KEY', 'UNKNOWN_ENTITY', 'UNKNOWN_TARGET_FIELD', 'UNKNOWN_SOURCE_COLUMN']) expect(c).toContain(code);
  });
  it('requires a source key unless positional keys are explicitly allowed', () => {
    const m = clone(MAPPING) as any; delete m.entities.customers.key;
    expect(codes(m)).toContain('KEY_REQUIRED');
    m.options.allowPositionalKeys = true;
    expect(codes(m)).toEqual([]);
  });
  it('requires required target fields to be mapped and from/value to be exclusive', () => {
    const m = clone(MAPPING) as any; delete m.entities.customers.fields.name; m.entities.customers.fields.email = { from: 'Email', value: 'x' };
    const c = codes(m);
    expect(c).toContain('REQUIRED_FIELD_UNMAPPED'); expect(c).toContain('FIELD_SOURCE_INVALID');
  });
  it('rejects unknown transforms, bad options, prototype keys and oversized input', () => {
    const m = clone(MAPPING) as any; m.entities.customers.fields.email.transforms = [{ op: 'eval', code: '1' }];
    expect(codes(m)).toContain('TRANSFORM_UNKNOWN');
    const o = clone(MAPPING) as any; o.options = { timezone: 'Mars/Base', dedupe: 'merge', maxErrorRatio: 4 };
    expect(codes(o).filter((c) => c === 'OPTIONS_INVALID').length).toBe(3);
    const p = clone(MAPPING) as any; p.entities.customers.fields.customer_type.transforms = [{ op: 'enum', map: JSON.parse('{"__proto__":"x"}') }];
    expect(codes(p)).toContain('ENUM_INVALID');
    expect(codes({ version: 1, source: 'csv', entities: { customers: { fields: { name: { value: 'x'.repeat(250_000) } } } } })).toContain('MAPPING_TOO_LARGE');
    expect(codes('nope')).toContain('MAPPING_INVALID');
  });
});

describe('mapRecord', () => {
  const em = MAPPING.entities.customers;
  const def = IMPORT_ENTITIES.customers;
  it('normalises values, drops invalid optional ones with a warning and omits empties', () => {
    const r = mapRecord(em, def, { ID: ' c9 ', Name: 'Zed', Phone: '12', Email: 'ZED@X.COM', Type: 'COMMERCIAL' }, 'UTC');
    expect(r.key).toBe('c9');
    expect(r.values).toEqual({ name: 'Zed', email: 'zed@x.com', customer_type: 'commercial' });
    expect(r.issues.map((i) => i.code)).toEqual(['PHONE_INVALID']);
    expect(mapRecord(em, def, { ID: 'c', Name: 'Z', Phone: '(555) 123-4567', Email: '', Type: 'Residential' }, 'UTC').values.phone).toBe('+15551234567');
  });
  it('reports required and enum problems without echoing source values', () => {
    const r = mapRecord(em, def, { ID: 'c1', Name: '', Phone: '', Email: '', Type: 'SECRET-VALUE' }, 'UTC');
    expect(r.issues.map((i) => i.code).sort()).toEqual(['ENUM_UNMAPPED', 'REQUIRED_MISSING']);
    expect(JSON.stringify(r.issues)).toBe(JSON.stringify(r.issues).replace('SECRET-VALUE', ''));
  });
  it('does not leak Object.prototype through enum lookups', () => {
    const r = mapRecord(em, def, { ID: 'c1', Name: 'A', Phone: '', Email: '', Type: 'constructor' }, 'UTC');
    expect(r.issues.map((i) => i.code)).toContain('ENUM_UNMAPPED');
  });
  it('maps jobs: money, timestamp in the configured zone and a reference', () => {
    const r = mapRecord(MAPPING.entities.jobs, IMPORT_ENTITIES.jobs, { JobID: 'j1', CustID: 'c1', Customer: 'Ann', Amount: '$1,250.50', Status: 'Done', When: '2027-01-05 09:00' }, 'UTC');
    expect(r.values.invoice_amount).toBe(1250.5);
    expect(r.values.job_status).toBe('completed');
    expect(r.values.scheduled_datetime).toBe('2027-01-05T09:00:00.000Z');
    expect(r.refs).toEqual({ customer_ref: 'c1' });
    expect(r.issues).toEqual([]);
  });
});
