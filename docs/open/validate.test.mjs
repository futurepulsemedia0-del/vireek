// Run:  node --experimental-strip-types --no-warnings --test docs/open/validate.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupported, compatibilityErrors, validate, validateEvent } from './validate.mjs';
import { RESOURCES, WEBHOOK_EVENTS } from '../../supabase/functions/api-v1/contract.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...p) => JSON.parse(readFileSync(join(HERE, ...p), 'utf8'));
const registry = json('event-types.json');
const schemaFiles = readdirSync(join(HERE, 'schemas')).filter((f) => f.endsWith('.schema.json'));

describe('schemas', () => {
  it('only use keywords the reference validator supports', () => {
    for (const f of schemaFiles) assert.doesNotThrow(() => assertSupported(json('schemas', f)), f);
  });
  it('the validator refuses unknown keywords instead of passing silently', () => {
    assert.throws(() => validate({ type: 'object', $ref: '#/x' }, {}), /unsupported keyword/);
    assert.throws(() => validate({ type: 'string', format: 'hostname' }, 'a'), /Unsupported format/);
  });
  it('every registry entry points at an existing schema file', () => {
    for (const e of registry.events) if (e.data_schema) assert.ok(schemaFiles.includes(e.data_schema), e.event);
  });
});

describe('examples', () => {
  const valid = readdirSync(join(HERE, 'examples')).filter((f) => f.endsWith('.json'));
  const invalid = readdirSync(join(HERE, 'examples', 'invalid')).filter((f) => f.endsWith('.json'));
  it('every valid example passes', () => {
    assert.ok(valid.length >= 7);
    for (const f of valid) {
      const r = validateEvent(json('examples', f));
      assert.equal(r.ok, true, `${f}: ${r.errors.join('; ')}`);
    }
  });
  it('every invalid example fails', () => {
    assert.ok(invalid.length >= 9);
    for (const f of invalid) assert.equal(validateEvent(json('examples', 'invalid', f)).ok, false, f);
  });
  it('an unregistered event type passes the envelope only, with a note', () => {
    const r = validateEvent({ id: '6b1f0c52-8d3e-4a7b-9f21-0e5d4c3b2a19', event: 'thing.happened', created_at: '2026-11-23T09:15:02Z', data: {} });
    assert.equal(r.ok, true);
    assert.match(r.notes[0], /not registered/);
  });
  it('a non-object data member fails the envelope', () => {
    const r = validateEvent({ id: '6b1f0c52-8d3e-4a7b-9f21-0e5d4c3b2a19', event: 'call.created', created_at: '2026-11-23T09:15:02Z', data: [] });
    assert.equal(r.ok, false);
  });
});

describe('drift against the public API contract (contract.ts)', () => {
  const TYPE = { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', array: 'array', object: 'object' };
  for (const [resource, file] of [['calls', 'call.schema.json'], ['jobs', 'job.schema.json']]) {
    it(`${file} matches the "${resource}" resource field by field`, () => {
      const def = RESOURCES.find((r) => r.name === resource);
      const schema = json('schemas', file);
      assert.deepEqual(Object.keys(schema.properties).sort(), def.fields.map((f) => f.name).sort());
      for (const f of def.fields) {
        const p = schema.properties[f.name];
        assert.deepEqual([].concat(p.type), f.nullable ? [TYPE[f.type], 'null'] : [TYPE[f.type]], `${resource}.${f.name} type`);
        assert.equal(p.format, f.format, `${resource}.${f.name} format`);
      }
      for (const r of schema.required) assert.equal(def.fields.find((f) => f.name === r)?.nullable ?? false, false, `${r} is required but nullable in the API`);
    });
  }
  it('every registry event marked emitted exists in WEBHOOK_EVENTS with the same stability', () => {
    for (const e of registry.events.filter((x) => x.status === 'emitted')) {
      const w = WEBHOOK_EVENTS.find((x) => x.event === e.event);
      assert.ok(w, `${e.event} is not in WEBHOOK_EVENTS`);
      assert.equal(e.stability, w.stability, e.event);
    }
  });
  it('every WEBHOOK_EVENT that carries a Call or Job is mapped to the matching schema', () => {
    for (const w of WEBHOOK_EVENTS.filter((x) => x.schema === 'Call' || x.schema === 'Job')) {
      const e = registry.events.find((x) => x.event === w.event);
      assert.equal(e?.data_schema, w.schema === 'Call' ? 'call.schema.json' : 'job.schema.json', w.event);
    }
  });
  it('no WEBHOOK_EVENT is missing from the registry', () => {
    for (const w of WEBHOOK_EVENTS) assert.ok(registry.events.some((x) => x.event === w.event), `${w.event} missing`);
  });
  it('proposed events are not claimed to be emitted', () => {
    for (const e of registry.events.filter((x) => x.status === 'proposed')) assert.ok(!WEBHOOK_EVENTS.some((w) => w.event === e.event), e.event);
  });
});

describe('compatibilityErrors (additive-optional-only rule)', () => {
  const v1 = { required: ['id'], properties: { id: { type: 'string' }, amount: { type: ['number', 'null'] } } };
  it('allows a new optional field and a relaxed requirement', () => {
    assert.deepEqual(compatibilityErrors(v1, { ...v1, properties: { ...v1.properties, note: { type: 'string' } } }), []);
    assert.deepEqual(compatibilityErrors(v1, { ...v1, required: [] }), []);
  });
  it('rejects removal, retyping, new required and newly required fields', () => {
    assert.deepEqual(compatibilityErrors(v1, { required: ['id'], properties: { id: { type: 'string' } } }), ['field "amount" was removed']);
    assert.match(compatibilityErrors(v1, { ...v1, properties: { ...v1.properties, id: { type: 'integer' } } })[0], /changed type/);
    assert.match(compatibilityErrors(v1, { ...v1, properties: { ...v1.properties, note: { type: 'string' } }, required: ['id', 'note'] })[0], /must be optional/);
    assert.match(compatibilityErrors(v1, { ...v1, required: ['id', 'amount'] })[0], /became required/);
  });
});

describe('format edge cases', () => {
  const dt = { type: 'string', format: 'date-time' };
  it('rejects impossible calendar values and accepts leap day', () => {
    assert.equal(validate(dt, '2026-02-29T00:00:00Z').length, 1);
    assert.equal(validate(dt, '2028-02-29T00:00:00Z').length, 0);
    assert.equal(validate(dt, '2026-11-23T24:00:00Z').length, 1);
    assert.equal(validate(dt, '2026-11-23 09:00:00Z').length, 1);
    assert.equal(validate({ type: 'string', format: 'date' }, '2026-13-01').length, 1);
  });
  it('integer rejects 1.5 and numeric strings', () => {
    assert.equal(validate({ type: 'integer' }, 1.5).length, 1);
    assert.equal(validate({ type: 'integer' }, '1').length, 1);
    assert.equal(validate({ type: 'integer' }, 1).length, 0);
  });
});
