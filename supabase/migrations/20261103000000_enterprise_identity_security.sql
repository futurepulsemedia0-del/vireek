-- Enterprise Identity & Security
-- Custom RBAC roles, IP allowlisting, session policy, SSO domain
-- registry, and SCIM provisioning tokens. Built on top of the existing
-- team_members / audit_log system — no breaking changes to either.

-- =============================================================
-- CUSTOM ROLES (granular RBAC)
-- =============================================================

create table if not exists public.custom_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.custom_roles enable row level security;

-- Any member of the account (owner or team member, via get_account_owner_id())
-- can read the roles — they're not secret, just permission templates.
create policy "account_select_custom_roles"
  on public.custom_roles for select
  using (user_id = public.get_account_owner_id());

-- Only the owner can create/edit/delete roles.
create policy "owner_insert_custom_roles"
  on public.custom_roles for insert
  with check (user_id = auth.uid());

create policy "owner_update_custom_roles"
  on public.custom_roles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "owner_delete_custom_roles"
  on public.custom_roles for delete
  using (user_id = auth.uid());

-- Link team_members to an optional custom role. NULL = keep using the
-- existing fixed `permissions` flags on team_members (fully backward compatible).
alter table public.team_members
  add column if not exists custom_role_id uuid references public.custom_roles(id) on delete set null;

create index if not exists team_members_custom_role_id_idx on public.team_members (custom_role_id);

-- =============================================================
-- IP ALLOWLIST
-- =============================================================

create table if not exists public.ip_allow_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  cidr text not null,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists ip_allow_rules_user_id_idx on public.ip_allow_rules (user_id);

alter table public.ip_allow_rules enable row level security;

create policy "owner_manage_ip_allow_rules"
  on public.ip_allow_rules for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =============================================================
-- SECURITY POLICY (session rules, MFA/SSO enforcement toggles)
-- =============================================================

create table if not exists public.security_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  sso_enforced boolean not null default false,
  require_mfa_for_team boolean not null default false,
  ip_restriction_enabled boolean not null default false,
  session_idle_minutes integer not null default 0,
  session_max_hours integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.security_policies enable row level security;

create policy "owner_manage_security_policies"
  on public.security_policies for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =============================================================
-- SSO DOMAINS (SAML) — local registry mirroring what's registered
-- with Supabase Auth via the Management API (see admin-sso function)
-- =============================================================

create table if not exists public.sso_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  domain text not null unique,
  sso_provider_id text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  created_at timestamptz not null default now()
);

create index if not exists sso_domains_user_id_idx on public.sso_domains (user_id);

alter table public.sso_domains enable row level security;

create policy "owner_manage_sso_domains"
  on public.sso_domains for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =============================================================
-- SCIM TOKENS — bearer credentials for the scim-v2 edge function.
-- The raw token is shown once at creation and never stored — only
-- its SHA-256 hash is kept, same pattern as trusted_devices cookies.
-- =============================================================

create table if not exists public.scim_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists scim_tokens_user_id_idx on public.scim_tokens (user_id);
create index if not exists scim_tokens_hash_idx on public.scim_tokens (token_hash);

alter table public.scim_tokens enable row level security;

create policy "owner_manage_scim_tokens"
  on public.scim_tokens for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
