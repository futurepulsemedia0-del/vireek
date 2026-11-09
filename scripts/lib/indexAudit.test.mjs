import { describe, it, expect } from 'vitest';
import { scan, findGaps } from './indexAudit.mjs';

describe('indexAudit', () => {
  it('flags a tenant table with no leading tenant index and accepts the covered ones', () => {
    const sql = [
      `create table public.a (id uuid primary key, user_id uuid not null, name text);`,
      `create table public.b (id uuid primary key, user_id uuid not null); create index idx_b on public.b (user_id, created_at desc);`,
      `create table public.c (user_id uuid not null, k text, primary key (user_id, k));`,
      `create table public.d (id uuid primary key, other text); -- not tenant scoped`,
      `create table public.e (id uuid primary key); alter table public.e add column if not exists account_owner_id uuid; create index on public.e (created_at);`,
      `create table public.f (user_id uuid primary key);`,
      `create table public.g (id uuid, user_id uuid); drop table public.g;`,
    ];
    const { scopedCount, gaps } = findGaps(scan(sql));
    expect(scopedCount).toBe(5);
    expect(gaps.map((g) => g.table)).toEqual(['a', 'e']);
  });
  it('ignores comments and index not leading with the tenant column', () => {
    const sql = [`create table x (id uuid, user_id uuid); -- create index i on x (user_id);\ncreate index j on x (created_at, user_id);`];
    expect(findGaps(scan(sql)).gaps.map((g) => g.table)).toEqual(['x']);
  });
});
