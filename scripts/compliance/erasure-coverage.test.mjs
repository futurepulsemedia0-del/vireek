// Unit tests for the erasure parser/classifier plus the real-repo gate that runs in CI (`npm test`).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, fromCatalogRows, parseMigrations, parseRpcExclude, stripComments, validateExemptions } from './erasure-lib.mjs';
import { ROOT, analyse, evaluate } from './check-erasure-coverage.mjs';

const parse = (...sql) => parseMigrations(sql.map((s, i) => ({ name: `${i}.sql`, sql: s })));
const none = new Set();
const cls = (tables, extra = {}) => Object.fromEntries(classify({ tables, owned: none, trust: none, ...extra }).rows.map((r) => [r.table, r.class]));

describe('parseMigrations', () => {
  it('reads inline FK cascade to auth.users and profiles (qualified or not)', () => {
    const t = parse(`CREATE TABLE IF NOT EXISTS public.a (id uuid, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);
      CREATE TABLE b (user_id uuid NOT NULL DEFAULT x() REFERENCES profiles(id) ON DELETE CASCADE);
      CREATE TABLE c (user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE SET NULL);
      CREATE TABLE d (user_id uuid NOT NULL REFERENCES auth.users(id));`);
    expect(cls(t)).toEqual({ a: 'cascade', b: 'cascade', c: 'catalog_rpc', d: 'catalog_rpc' });
  });
  it('does not treat a cascade to some other table as erasure', () => {
    expect(cls(parse(`CREATE TABLE e (user_id uuid REFERENCES jobs(id) ON DELETE CASCADE);`))).toEqual({ e: 'catalog_rpc' });
  });
  it('handles table-level FOREIGN KEY constraints, also added later with ALTER TABLE', () => {
    const t = parse(
      `CREATE TABLE f (user_id uuid, CONSTRAINT f_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE);`,
      `CREATE TABLE g (user_id uuid); ALTER TABLE ONLY public.g ADD CONSTRAINT g_fk FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;`,
    );
    expect(cls(t)).toEqual({ f: 'cascade', g: 'cascade' });
  });
  it('sees owner columns added by ALTER TABLE ADD COLUMN and drops removed ones', () => {
    const t = parse(`CREATE TABLE h (id uuid); ALTER TABLE public.h ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT x();
      CREATE TABLE i (user_id uuid, owner_id uuid); ALTER TABLE i DROP COLUMN user_id;`);
    expect(cls(t)).toEqual({ h: 'catalog_rpc', i: 'uncovered' });
  });
  it('replays DROP TABLE and RENAME, and ignores comments and other schemas', () => {
    const t = parse(`CREATE TABLE gone (user_id uuid); DROP TABLE IF EXISTS public.gone CASCADE;
      CREATE TABLE old_name (user_id uuid); ALTER TABLE old_name RENAME TO new_name;
      -- CREATE TABLE commented (user_id uuid);
      /* CREATE TABLE blockc (user_id uuid); */
      CREATE TABLE private.hidden (user_id uuid);`);
    expect([...t.keys()]).toEqual(['new_name']);
  });
  it('is not fooled by nested parentheses or defaults containing commas', () => {
    const t = parse(`CREATE TABLE j (a numeric(10,2) DEFAULT 0, b text CHECK (b IN ('x','y')), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, c jsonb DEFAULT '{"a":1,"b":2}');`);
    expect(cls(t)).toEqual({ j: 'cascade' });
  });
  it('stripComments keeps quoted dashes', () => {
    expect(stripComments(`SELECT '--not a comment'; -- real`).trim()).toBe(`SELECT '--not a comment';`);
  });
});

describe('classify', () => {
  const t = parse(`CREATE TABLE k (user_id uuid); CREATE TABLE l (user_id text); CREATE TABLE m (account_owner_id uuid);
    CREATE TABLE n (user_id uuid); CREATE TABLE o (user_id uuid); CREATE TABLE audit_log (user_id uuid);`);
  it('applies precedence exempt > listed > cascade > catalog_rpc > uncovered', () => {
    const r = classify({ tables: t, owned: new Set(['n']), trust: none, exemptions: { o: { reason: 'kept for a documented reason' } }, rpcExclude: ['audit_log'] });
    expect(Object.fromEntries(r.rows.map((x) => [x.table, x.class]))).toEqual({ audit_log: 'uncovered', k: 'catalog_rpc', l: 'uncovered', m: 'uncovered', n: 'listed', o: 'exempt' });
    expect(r.summary).toMatchObject({ listed: 1, exempt: 1, catalog_rpc: 1, uncovered: 3, total: 6 });
  });
  it('accepts a catalog dump as an alternative source', () => {
    const tables = fromCatalogRows([{ table: 'p', column: 'user_id', type: 'uuid', cascades: true }, { table: 'q', column: 'owner_id', type: 'uuid', cascades: false }, { table: 'r', column: 'name', type: 'text', cascades: false }]);
    expect(cls(tables)).toEqual({ p: 'cascade', q: 'uncovered' });
  });
  it('reads the RPC exclude list from its migration text', () => {
    expect(parseRpcExclude(`p_exclude text[] DEFAULT ARRAY['a','b']`)).toEqual(['a', 'b']);
  });
  it('rejects exemptions without a real reason or for unknown tables', () => {
    expect(validateExemptions({ x: { reason: 'short' }, y: { reason: 'a proper written reason' } }, new Set(['x']))).toHaveLength(2);
  });
});

describe('real repository gate (this is the CI check)', () => {
  const a = analyse();
  const baseline = JSON.parse(readFileSync(join(ROOT, 'docs/compliance/erasure-coverage-baseline.json'), 'utf8'));

  it('analyses a plausible number of tables (guards against a silently broken parser)', () => {
    expect(a.summary.total).toBeGreaterThan(1000);
    expect(a.summary.listed).toBeGreaterThanOrEqual(25);
  });
  it('has no consistency problems (exemptions valid, OWNED_TABLES entries are real tables)', () => {
    expect(a.problems).toEqual([]);
  });
  it('FAILS when a new owner-column table has no erasure path', () => {
    const withNew = classify({ tables: parse(`CREATE TABLE brand_new_feature (account_owner_id uuid NOT NULL);`), owned: none, trust: none });
    expect(evaluate({ rows: withNew.rows, problems: [] }, baseline.uncovered).fresh).toEqual(['brand_new_feature']);
  });
  it('passes today: nothing uncovered beyond the committed baseline', () => {
    expect(existsSync(join(ROOT, 'docs/compliance/erasure-coverage-baseline.json'))).toBe(true);
    expect(evaluate(a, baseline.uncovered).fresh).toEqual([]);
  });
});
