-- 20280401000000_site_assistant_knowledge.sql
--
-- "Ask Vireek" public knowledge layer:
--   1. site_kb_chunks        public-only knowledge chunks (pgvector + full-text)
--   2. match_site_kb()       hybrid search (vector + keyword, RRF fusion)
--   3. site_assistant_log    privacy-safe answer log (redacted question, no IP, no user id)
--   4. submit_site_assistant_feedback()  anonymous thumbs up/down, once per answer
--   5. get_site_assistant_gaps/stats/purge  staff-only knowledge-gap tooling
--
-- Deliberately a NEW table instead of altering `brand_knowledge`: no migration
-- in this repo creates `brand_knowledge`, so its live schema cannot be verified.
-- The legacy table/RPC are left untouched and remain the fallback path.
--
-- Depends on: public.is_vireek_staff(uuid) (20260913020000_live_chat_and_academy.sql).
-- Idempotent: safe to run twice.
-- ROLLBACK (manual, destructive to the new objects only):
--   drop function if exists public.purge_site_assistant_log(int);
--   drop function if exists public.get_site_assistant_stats(int);
--   drop function if exists public.get_site_assistant_gaps(int);
--   drop function if exists public.submit_site_assistant_feedback(uuid, smallint);
--   drop function if exists public.match_site_kb(vector, text, int, double precision);
--   drop table if exists public.site_assistant_log;
--   drop table if exists public.site_kb_chunks;

create extension if not exists vector with schema extensions;

-- Make the `vector` type and its operators resolvable whether the extension
-- lives in `extensions` (Supabase default) or `public` (older projects).
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 1. Knowledge chunks (PUBLIC scope only — enforced by CHECK + RLS)
-- ---------------------------------------------------------------------
create table if not exists public.site_kb_chunks (
  id            uuid primary key default gen_random_uuid(),
  chunk_key     text not null unique,              -- stable: "<source>:<slug>:<n>"
  scope         text not null default 'public' check (scope = 'public'),
  topic         text not null,
  title         text not null,
  content       text not null check (char_length(content) between 1 and 6000),
  url           text,                              -- canonical site URL
  plans         text[] not null default '{}',      -- plan ids this applies to; empty = all
  status        text not null default 'live' check (status in ('live', 'beta', 'planned')),
  lang          text not null default 'en',
  content_hash  text not null,                     -- sha256 of title+content; skip re-embed if unchanged
  token_estimate integer,
  embedding     vector(1024),                      -- Cohere embed-multilingual-v3.0 (1024-dim)
  updated_at    timestamptz not null default now(),
  fts           tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(content, '')), 'B')
                ) stored
);

create index if not exists site_kb_chunks_fts_idx on public.site_kb_chunks using gin (fts);
create index if not exists site_kb_chunks_topic_idx on public.site_kb_chunks (topic);
create index if not exists site_kb_chunks_embedding_idx
  on public.site_kb_chunks using hnsw (embedding vector_cosine_ops);

alter table public.site_kb_chunks enable row level security;

drop policy if exists site_kb_chunks_public_read on public.site_kb_chunks;
create policy site_kb_chunks_public_read on public.site_kb_chunks
  for select to anon, authenticated
  using (scope = 'public');
-- No insert/update/delete policies: only the service role (knowledge:build) writes.

-- ---------------------------------------------------------------------
-- 2. Hybrid search: vector rank + keyword rank, fused with RRF (k = 60)
--    query_embedding NULL => keyword-only (embeddings not configured).
-- ---------------------------------------------------------------------
create or replace function public.match_site_kb(
  query_embedding       vector(1024) default null,
  query_text            text default '',
  match_count           int default 5,
  min_vector_similarity double precision default 0.35
)
returns table (
  id         uuid,
  title      text,
  content    text,
  url        text,
  topic      text,
  plans      text[],
  status     text,
  score      double precision,
  similarity double precision,
  kw_rank    double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with q as (
    select case when btrim(coalesce(query_text, '')) = '' then null
                else websearch_to_tsquery('english', query_text) end as tsq
  ),
  vec as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rnk,
           1 - (c.embedding <=> query_embedding) as sim
    from public.site_kb_chunks c
    where query_embedding is not null and c.embedding is not null
    order by c.embedding <=> query_embedding
    limit 20
  ),
  kw as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk,
           ts_rank_cd(c.fts, q.tsq) as r
    from public.site_kb_chunks c, q
    where q.tsq is not null and c.fts @@ q.tsq
    order by ts_rank_cd(c.fts, q.tsq) desc
    limit 20
  ),
  fused as (
    select coalesce(v.id, k.id) as id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + k.rnk), 0) as score,
           v.sim as sim,
           k.r as kw_rank
    from vec v
    full outer join kw k on k.id = v.id
  )
  select c.id, c.title, c.content, c.url, c.topic, c.plans, c.status,
         f.score::double precision,
         coalesce(f.sim, 0)::double precision as similarity,
         f.kw_rank::double precision
  from fused f
  join public.site_kb_chunks c on c.id = f.id
  where coalesce(f.sim, 0) >= min_vector_similarity or f.kw_rank is not null
  order by f.score desc
  limit least(greatest(match_count, 1), 12);
$$;

grant execute on function public.match_site_kb(vector, text, int, double precision) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Answer log — privacy-safe: redacted question text only. No IP, no
--    user id, no raw message, no conversation history.
--    RLS on + zero policies => anon/authenticated cannot read or write it.
--    The edge function writes with the service role; staff read via RPCs.
-- ---------------------------------------------------------------------
create table if not exists public.site_assistant_log (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  question_redacted text not null check (char_length(question_redacted) <= 500),
  intent            text not null default 'general',
  grounded          boolean not null,
  top_similarity    real,
  source_urls       text[] not null default '{}',
  provider          text,
  model             text,
  latency_ms        integer,
  first_token_ms    integer,
  cached            boolean not null default false,
  handoff           boolean not null default false,
  rating            smallint check (rating in (-1, 1)),
  rated_at          timestamptz
);

create index if not exists site_assistant_log_created_idx on public.site_assistant_log (created_at desc);
create index if not exists site_assistant_log_gap_idx
  on public.site_assistant_log (created_at desc) where grounded = false or rating = -1;

alter table public.site_assistant_log enable row level security;

-- ---------------------------------------------------------------------
-- 4. Anonymous feedback: one rating per answer, within 24h of the answer.
--    The answer id is an unguessable uuid only the answering client saw.
-- ---------------------------------------------------------------------
create or replace function public.submit_site_assistant_feedback(p_answer_id uuid, p_rating smallint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_rating is null or p_rating not in (-1, 1) then
    raise exception 'rating must be -1 or 1' using errcode = '22023';
  end if;
  update public.site_assistant_log
     set rating = p_rating, rated_at = now()
   where id = p_answer_id
     and rating is null
     and created_at > now() - interval '1 day';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.submit_site_assistant_feedback(uuid, smallint) from public;
grant execute on function public.submit_site_assistant_feedback(uuid, smallint) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Staff-only knowledge-gap tooling
-- ---------------------------------------------------------------------
create or replace function public.get_site_assistant_gaps(p_days integer default 30)
returns table (
  question        text,
  intent          text,
  occurrences     bigint,
  thumbs_down     bigint,
  ungrounded      bigint,
  avg_similarity  real,
  last_seen       timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_vireek_staff(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select lower(btrim(l.question_redacted)) as question,
           l.intent,
           count(*)                                         as occurrences,
           count(*) filter (where l.rating = -1)            as thumbs_down,
           count(*) filter (where l.grounded = false)       as ungrounded,
           avg(l.top_similarity)::real                      as avg_similarity,
           max(l.created_at)                                as last_seen
      from public.site_assistant_log l
     where l.created_at > now() - make_interval(days => least(greatest(p_days, 1), 180))
       and (l.grounded = false or l.rating = -1)
     group by 1, 2
     order by 3 desc, 7 desc
     limit 200;
end;
$$;

create or replace function public.get_site_assistant_stats(p_days integer default 30)
returns table (
  total          bigint,
  grounded_pct   numeric,
  thumbs_up      bigint,
  thumbs_down    bigint,
  cached_pct     numeric,
  handoffs       bigint,
  p50_latency_ms integer,
  p95_latency_ms integer,
  p50_first_token_ms integer,
  p95_first_token_ms integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_vireek_staff(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select count(*),
           round(100.0 * count(*) filter (where l.grounded) / nullif(count(*), 0), 1),
           count(*) filter (where l.rating = 1),
           count(*) filter (where l.rating = -1),
           round(100.0 * count(*) filter (where l.cached) / nullif(count(*), 0), 1),
           count(*) filter (where l.handoff),
           (percentile_cont(0.5)  within group (order by l.latency_ms))::integer,
           (percentile_cont(0.95) within group (order by l.latency_ms))::integer,
           (percentile_cont(0.5)  within group (order by l.first_token_ms))::integer,
           (percentile_cont(0.95) within group (order by l.first_token_ms))::integer
      from public.site_assistant_log l
     where l.created_at > now() - make_interval(days => least(greatest(p_days, 1), 180));
end;
$$;

-- Retention: call from a scheduled job (pg_cron / Supabase scheduled function).
-- Service role only; not exposed to anon/authenticated.
create or replace function public.purge_site_assistant_log(p_days integer default 180)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  delete from public.site_assistant_log
   where created_at < now() - make_interval(days => greatest(p_days, 7));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.get_site_assistant_gaps(integer)  from public, anon;
revoke all on function public.get_site_assistant_stats(integer) from public, anon;
revoke all on function public.purge_site_assistant_log(integer) from public, anon, authenticated;
grant execute on function public.get_site_assistant_gaps(integer)  to authenticated;
grant execute on function public.get_site_assistant_stats(integer) to authenticated;
grant execute on function public.purge_site_assistant_log(integer) to service_role;

reset search_path;
