import { describe, it, expect } from 'vitest';
import { checkMigrationSql } from './migrationSafety.mjs';

const RB = '-- rollback: drop the thing\n';

describe('checkMigrationSql', () => {
  it('requires a rollback note', () => {
    expect(checkMigrationSql('CREATE TABLE t (id int);')[0]).toContain('rollback');
  });
  it('allows a clean expand migration', () => {
    expect(checkMigrationSql(RB + 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text; ALTER TABLE t ADD COLUMN b int NOT NULL DEFAULT 0;')).toEqual([]);
  });
  it('flags non-concurrent index on an existing table', () => {
    expect(checkMigrationSql(RB + 'CREATE INDEX idx_a ON jobs(a);').join()).toContain('CONCURRENTLY');
  });
  it('allows an index on a table created in the same file', () => {
    expect(checkMigrationSql(RB + 'CREATE TABLE x (id int); CREATE INDEX i ON x(id);')).toEqual([]);
  });
  it('requires a concurrent index to be alone in its file', () => {
    expect(checkMigrationSql(RB + 'CREATE INDEX CONCURRENTLY i ON jobs(a); SELECT 1;').join()).toContain('own migration');
    expect(checkMigrationSql(RB + 'CREATE INDEX CONCURRENTLY i ON jobs(a);')).toEqual([]);
  });
  it('flags NOT NULL column without default, SET NOT NULL and unvalidated constraints', () => {
    expect(checkMigrationSql(RB + 'ALTER TABLE jobs ADD COLUMN a int NOT NULL;')).toHaveLength(1);
    expect(checkMigrationSql(RB + 'ALTER TABLE jobs ALTER COLUMN a SET NOT NULL;')).toHaveLength(1);
    expect(checkMigrationSql(RB + 'ALTER TABLE jobs ADD CONSTRAINT c CHECK (a > 0);')).toHaveLength(1);
    expect(checkMigrationSql(RB + 'ALTER TABLE jobs ADD CONSTRAINT c CHECK (a > 0) NOT VALID;')).toEqual([]);
  });
  it('honours an explicit opt-out but still demands the rollback note', () => {
    expect(checkMigrationSql(RB + '-- lint:allow-blocking tiny table\nCREATE INDEX i ON jobs(a);')).toEqual([]);
    expect(checkMigrationSql('-- lint:allow-blocking x\nCREATE INDEX i ON jobs(a);')).toHaveLength(1);
  });
  it('ignores keywords inside comments, strings and function bodies', () => {
    expect(checkMigrationSql(RB + "-- CREATE INDEX x ON jobs(a);\nSELECT 'ALTER TABLE jobs ADD COLUMN a int NOT NULL';")).toEqual([]);
  });
});
