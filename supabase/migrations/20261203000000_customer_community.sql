/*
# Customer Community (Forum)

## چی می‌سازه
- community_categories : دسته‌بندی‌های ثابت فوروم (seed می‌شن همین‌جا).
- community_threads     : سؤال/بحثی که یک مشتری باز می‌کنه.
- community_replies     : پاسخ‌های زیر یک thread؛ یکیشون می‌تونه accepted باشه.
- community_votes       : رأی مثبت روی یک thread یا reply؛ هر کاربر روی هر
  آیتم فقط یک رأی (unique constraint).

## چرا نوشتن‌ها فقط از طریق function
شمارنده‌ها (reply_count / upvote_count / view_count) و «accepted answer»
باید atomic و امن آپدیت بشن، وگرنه هر کاربر می‌تونه مستقیم upvote_count
خودش رو دستکاری کنه. برای همین:
- community_threads: فقط INSERT مستقیم مجازه (ساخت thread جدید، بدون شمارنده).
  ویرایش/accept/شمارنده فقط از طریق functionهای پایین.
- community_replies و community_votes: هیچ INSERT/UPDATE مستقیمی مجاز نیست؛
  فقط از طریق create_community_reply / toggle_community_vote.

## دسترسی
همه‌ی جدول‌ها برای هر کاربر authenticated قابل خوندنه (این یک فوروم
cross-tenant واقعیه، نه داده‌ی مخصوص یک اکانت) — به همین خاطر از
get_account_owner_id() این‌جا استفاده نشده. نویسندگی هر ردیف با auth.uid()
چک می‌شه.
*/

create table if not exists public.community_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  icon_name text not null default 'MessageCircle',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.community_categories enable row level security;

create policy "Authenticated users view community categories"
  on public.community_categories
  for select
  to authenticated
  using (true);

insert into public.community_categories (slug, name, description, icon_name, sort_order) values
  ('general', 'General Discussion', 'Anything about running a home service business on Vireek.', 'MessageCircle', 0),
  ('dispatch-scheduling', 'Dispatch & Scheduling', 'Routing, technician capacity, on-call, scheduling workflows.', 'Calendar', 1),
  ('quotes-pricing', 'Quotes & Pricing', 'Estimating, pricing strategy, margin, financing.', 'DollarSign', 2),
  ('automations-ai', 'Automations & AI', 'AI receptionist, workflows, agents, integrations.', 'Bot', 3),
  ('feature-requests', 'Feature Requests', 'What you wish Vireek could do next.', 'Lightbulb', 4)
on conflict (slug) do nothing;

create table if not exists public.community_threads (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.community_categories(id) on delete restrict,
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null,
  title text not null check (char_length(title) between 4 and 200),
  body text not null check (char_length(body) between 1 and 10000),
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  is_pinned boolean not null default false,
  accepted_reply_id uuid,
  reply_count integer not null default 0,
  upvote_count integer not null default 0,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists community_threads_category_idx on public.community_threads (category_id, is_pinned desc, created_at desc);
create index if not exists community_threads_author_idx on public.community_threads (author_id);

alter table public.community_threads enable row level security;

create policy "Authenticated users view community threads"
  on public.community_threads
  for select
  to authenticated
  using (true);

create policy "Authenticated users start a community thread"
  on public.community_threads
  for insert
  to authenticated
  with check (author_id = auth.uid());

-- عمداً هیچ UPDATE policy‌ای این‌جا نیست — ویرایش/accept/شمارنده‌ها فقط از
-- طریق functionهای SECURITY DEFINER پایین انجام می‌شن.

create table if not exists public.community_replies (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.community_threads(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null,
  body text not null check (char_length(body) between 1 and 10000),
  is_accepted boolean not null default false,
  upvote_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists community_replies_thread_idx on public.community_replies (thread_id, created_at);

alter table public.community_replies enable row level security;

create policy "Authenticated users view community replies"
  on public.community_replies
  for select
  to authenticated
  using (true);

alter table public.community_threads
  add constraint community_threads_accepted_reply_fkey
  foreign key (accepted_reply_id) references public.community_replies(id) on delete set null;

create table if not exists public.community_votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('thread', 'reply')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, target_type, target_id)
);

alter table public.community_votes enable row level security;

create policy "Users view their own community votes"
  on public.community_votes
  for select
  to authenticated
  using (user_id = auth.uid());

-- =============================================================
-- FUNCTIONS (تنها راه نوشتن reply / vote / accept / ویرایش thread)
-- =============================================================

create or replace function public.create_community_reply(p_thread_id uuid, p_body text, p_author_name text)
returns public.community_replies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reply public.community_replies;
begin
  insert into public.community_replies (thread_id, author_id, author_name, body)
  values (p_thread_id, auth.uid(), p_author_name, p_body)
  returning * into v_reply;

  update public.community_threads
  set reply_count = reply_count + 1, updated_at = now()
  where id = p_thread_id;

  return v_reply;
end;
$$;

grant execute on function public.create_community_reply(uuid, text, text) to authenticated;

create or replace function public.toggle_community_vote(p_target_type text, p_target_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_target_type not in ('thread', 'reply') then
    raise exception 'Invalid target_type';
  end if;

  delete from public.community_votes
  where user_id = auth.uid() and target_type = p_target_type and target_id = p_target_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    if p_target_type = 'thread' then
      update public.community_threads set upvote_count = greatest(upvote_count - 1, 0) where id = p_target_id;
    else
      update public.community_replies set upvote_count = greatest(upvote_count - 1, 0) where id = p_target_id;
    end if;
    return false;
  end if;

  insert into public.community_votes (user_id, target_type, target_id) values (auth.uid(), p_target_type, p_target_id);
  if p_target_type = 'thread' then
    update public.community_threads set upvote_count = upvote_count + 1 where id = p_target_id;
  else
    update public.community_replies set upvote_count = upvote_count + 1 where id = p_target_id;
  end if;
  return true;
end;
$$;

grant execute on function public.toggle_community_vote(text, uuid) to authenticated;

create or replace function public.accept_community_reply(p_reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_thread_author uuid;
begin
  select thread_id into v_thread_id from public.community_replies where id = p_reply_id;
  if v_thread_id is null then
    raise exception 'Reply not found';
  end if;

  select author_id into v_thread_author from public.community_threads where id = v_thread_id;
  if v_thread_author is distinct from auth.uid() then
    raise exception 'Only the thread author can accept an answer';
  end if;

  update public.community_replies set is_accepted = false where thread_id = v_thread_id and is_accepted = true;
  update public.community_replies set is_accepted = true where id = p_reply_id;
  update public.community_threads
  set accepted_reply_id = p_reply_id, status = 'answered', updated_at = now()
  where id = v_thread_id;
end;
$$;

grant execute on function public.accept_community_reply(uuid) to authenticated;

create or replace function public.update_community_thread(p_thread_id uuid, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.community_threads
  set title = p_title, body = p_body, updated_at = now()
  where id = p_thread_id and author_id = auth.uid();

  if not found then
    raise exception 'Thread not found or you are not its author';
  end if;
end;
$$;

grant execute on function public.update_community_thread(uuid, text, text) to authenticated;

create or replace function public.increment_community_thread_views(p_thread_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.community_threads set view_count = view_count + 1 where id = p_thread_id;
$$;

grant execute on function public.increment_community_thread_views(uuid) to authenticated;
