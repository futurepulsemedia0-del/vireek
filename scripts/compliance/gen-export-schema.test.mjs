import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseLists } from './export-coverage.mjs';
import { OUT_JSON, OUT_MD, buildSchema, jsonTypeFor, renderMarkdown, scanColumns } from './gen-export-schema.mjs';

describe('gen-export-schema', () => {
  it('maps Postgres types to JSON value types', () => {
    expect(jsonTypeFor('uuid')).toBe('string (uuid)');
    expect(jsonTypeFor('timestamptz')).toBe('string (ISO 8601)');
    expect(jsonTypeFor('numeric(10,2)')).toBe('number');
    expect(jsonTypeFor('jsonb')).toBe('any JSON value');
    expect(jsonTypeFor('text[]')).toBe('array');
    expect(jsonTypeFor('boolean')).toBe('boolean');
  });

  it('documents every exported table, defined in migrations, and hides user_id and credential keys', () => {
    const { core, supplement } = parseLists(ROOT);
    const s = buildSchema(ROOT);
    expect(s.tables.map((t) => t.name)).toEqual([...core, ...supplement]);
    for (const t of s.tables) {
      expect(t.definedInMigrations, t.name).toBe(true);
      expect(t.columns.map((c) => c.name)).not.toContain('user_id');
      expect(t.columns.length, t.name).toBeGreaterThan(1);
    }
  });

  it('reads ALTER TABLE ADD COLUMN, e.g. the recording link on calls', () => {
    expect([...scanColumns(ROOT).get('calls').keys()]).toContain('recording_url');
  });

  it('keeps the committed schema files in step with the export lists (run `npm run export-schema:write`)', () => {
    expect(existsSync(join(ROOT, OUT_MD)) && existsSync(join(ROOT, OUT_JSON))).toBe(true);
    const s = buildSchema(ROOT);
    expect(readFileSync(join(ROOT, OUT_MD), 'utf8')).toBe(renderMarkdown(s) + '\n');
    expect(readFileSync(join(ROOT, OUT_JSON), 'utf8')).toBe(JSON.stringify(s, null, 2) + '\n');
  });
});
