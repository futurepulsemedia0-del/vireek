import { describe, expect, it } from 'vitest';
import {
  buildCurlExample,
  CANONICAL_ENTITIES,
  FABRIC_DOMAINS,
  healthPercent,
  parseFieldMapping,
  slugifyConnector,
  timeAgo,
} from '@/lib/dataFabric';

describe('Data Fabric catalog', () => {
  it('covers all sixteen system categories exactly once', () => {
    const keys = FABRIC_DOMAINS.map((d) => d.key);
    expect(keys).toHaveLength(16);
    expect(new Set(keys).size).toBe(16);
  });

  it('only references known canonical entities', () => {
    const known = new Set(CANONICAL_ENTITIES.map((e) => e.key));
    for (const d of FABRIC_DOMAINS) {
      expect(d.entities.length).toBeGreaterThan(0);
      for (const e of d.entities) expect(known.has(e)).toBe(true);
    }
  });

  it('builds a curl example that carries the key and an entity from the domain', () => {
    const curl = buildCurlExample('accounting', 'vfk_test');
    expect(curl).toContain('Bearer vfk_test');
    expect(curl).toContain('"entity":"customer"');
  });
});

describe('parseFieldMapping', () => {
  it('accepts empty input', () => {
    expect(parseFieldMapping('  ')).toEqual({ ok: true, value: {} });
  });

  it('accepts a valid mapping', () => {
    const r = parseFieldMapping('{"customer":{"name":"contact.fullName","email":"contact.emails[0]"}}');
    expect(r.ok).toBe(true);
  });

  it.each([
    ['not json', '{oops'],
    ['array root', '[]'],
    ['unknown entity', '{"spaceship":{"name":"a"}}'],
    ['bad field name', '{"customer":{"Name!":"a"}}'],
    ['non-string path', '{"customer":{"name":5}}'],
    ['entity not an object', '{"customer":"x"}'],
  ])('rejects %s', (_label, input) => {
    expect(parseFieldMapping(input).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('slugifies connector names into the database-safe format', () => {
    expect(slugifyConnector('Salesforce — Production!')).toBe('salesforce_production');
    expect(slugifyConnector('!')).toBe('custom_source');
    expect(slugifyConnector('a'.repeat(80))).toHaveLength(40);
  });

  it('computes ingest health', () => {
    expect(healthPercent({ records_total: 0, failed: 0, dead_letter: 0 })).toBeNull();
    expect(healthPercent({ records_total: 200, failed: 4, dead_letter: 0 })).toBe(98);
  });

  it('formats relative time', () => {
    const now = Date.parse('2027-03-01T12:00:00Z');
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2027-03-01T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2027-03-01T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2027-03-01T06:00:00Z', now)).toBe('6h ago');
    expect(timeAgo('2027-02-26T12:00:00Z', now)).toBe('3d ago');
  });
});
