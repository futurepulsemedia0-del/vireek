# Tenant id indirection — design and spike

Status: design + a spike on 3 tables (`supabase/migrations/20290306000100_tenant_indirection_spike.sql`). Not a rollout.
Inventory (generated, table by table): [tenant-indirection-tables.md](./tenant-indirection-tables.md)

## 1. Problem (measured, not assumed)
Tenant id is the account owner's `auth.uid()` (= `profiles.id`). Measured from the final state of 801 migrations by static analysis (`scripts/gen-tenant-indirection-appendix.mjs`):

| Measure | Count |
|---|---|
| Final static RLS policies | 2717 |
| Policies of the exact form `<col> = auth.uid()` (owner-only) | 310 (266 on `user_id`, 14 `owner_id`, 11 `account_owner_id`, 18 `id`, 1 `created_by`) |
| Policies that reference `auth.uid()` and not `get_account_owner_id()` (broader match) | 482 |
| Policies using `get_account_owner_id()` (team-aware) | 2100 (123 also mention `auth.uid()`) |
| Tables with at least one `auth.uid()` policy | 368 |
| FK targets of `user_id` columns | ~399 `auth.users(id)`, ~465 `profiles(id)` |

So the "~325 owner-only policies" figure holds (310 strict, up to 482 broad). The bigger finding is that **`get_account_owner_id()` already is a single indirection point for ~2100 policies** (it maps a team member to the owner). Only the *value* it returns is still the owner's uid. [VERIFY] 42 policies are created inside DO/EXECUTE blocks and are not in these counts; run the catalogue query in section 9 on a real database.

Consequences of tenant id = owner uid:
* Ownership transfer, owner leaving, merging or splitting accounts, and "agency owns many tenants" are impossible without rewriting every row.
* Deleting an owner's auth user cascades through ~860 FKs.
* Two meanings share one column: *who acted* (`created_by`) and *whose data* (`user_id`).

## 2. Target model
```
tenants(id uuid PK, owner_user_id uuid UNIQUE -> profiles.id, created_at)
```
* **Identity minting.** For every existing profile `tenants.id = profiles.id`. No existing row is rewritten, no URL, token, storage path or webhook that embeds the old id changes. New profiles mint a tenant with the same id (trigger), so the two worlds agree until ownership first moves.
* **Stability rule.** `tenants.id` never changes. `owner_user_id` may. Data rows carry `tenant_id`.
* **Resolvers.** `current_tenant_id()` (owner *or* team member; future replacement for `get_account_owner_id()`) and `current_owner_tenant_id()` (owner only; replacement for `user_id = auth.uid()`). Both are STABLE SECURITY DEFINER and used as `(SELECT ...)` so Postgres plans them once.
* **Meaning of `user_id` after migration.** Stays as the legacy owner column during the compatibility window, then is renamed in spirit to "created by / legacy owner" and no longer used for access.

## 3. Compatibility strategy (expand → dual-write → switch → contract)
1. **Expand** (done for the spike): add nullable `tenant_id`, backfill from `user_id` via `tenants`, add FK `NOT VALID` then `VALIDATE`, index.
2. **Dual-write**: BEFORE trigger fills `tenant_id` from `user_id` and rejects disagreement (`23514`). Old clients, edge functions and service-role scripts that only write `user_id` keep working.
3. **Switch**: policies move to `tenant_id = (SELECT current_owner_tenant_id())`, keeping the *same* audience (owner-only stays owner-only; team access is never widened by this change). A transitional `tenant_id IS NULL AND user_id = auth.uid()` clause covers orphan rows with no profile.
4. **Contract** (not before every reader is on `tenant_id`): `SET NOT NULL` via `CHECK ... NOT VALID`, drop the transitional clause, stop writing `user_id` for access, re-point FKs from `profiles(id)` to `tenants(id)`.
5. Throughout: every migration is additive until step 4; there is no step that cannot be undone by re-creating the old policies.

## 4. Migration plan, table by table
The generated appendix lists every table with its wave, counts of policies, inbound FKs and triggers. Waves:

| Wave | Tables | Work per table | Gate to start the next wave |
|---|---|---|---|
| 0 | `call_sources`, `estimate_templates`, `api_usage_alert_rules` (spike, **done**) | expand, dual-write, policies | pgTAP green, one release cycle with no RLS-related errors |
| 1 | 155 leaf tables (no inbound FK, no triggers) | same recipe, generated from the appendix, ≤ 20 tables per migration | per-batch pgTAP isolation test + `supabase db lint` clean |
| 2 | 207 coupled tables (inbound FKs or triggers) | recipe plus trigger review; children migrate in the same batch as parents | FK validation timings on a production-size copy |
| 3 | not table-shaped: ~hundreds of SECURITY DEFINER functions taking `user_id`, storage policies keyed on `auth.uid()`, edge functions using the service role with `user_id` filters, views | rewrite to `current_tenant_id()`; edge functions pass the tenant explicitly | grep gate below returns 0 |
| 4 | core: `profiles`, `team_members`, `customers`, `jobs`, `quotes`, `invoices`, `leads`, `calls` | maintenance window per table, backfill in batches of 10k | traffic-shadowed read comparison old vs new predicate |
| 5 | contract: NOT NULL, drop transitional clause, re-point FKs, `get_account_owner_id()` becomes a thin wrapper | | |

Spike tables, exactly:

| Table | Tenant column today | Why low-risk |
|---|---|---|
| `call_sources` | `user_id` (no FK) | leaf, 4 owner-only policies, 2 src files + 1 edge function (writes with `user_id`, covered by dual-write) |
| `estimate_templates` | `user_id` (no FK) | leaf, 4 owner-only policies, 1 lib file; note its RPCs already scope by `get_account_owner_id()` while its policies are owner-only (existing inconsistency, deliberately preserved) |
| `api_usage_alert_rules` | `user_id` is the PRIMARY KEY, FK to profiles | leaf, 3 policies, a trigger on UPDATE only; proves the PK-as-tenant case |

Rejected candidates: `franchise_price_policies` (no `user_id`; scoped through a group), `third_party_payers` (inbound FK), per-user preference tables such as `user_table_prefs` (they belong to a *user*, not a tenant, and must not be migrated).

## 5. Rollback
* Spike or any later batch: re-create the original policies (section 7) and drop `trg_<table>_tenant_sync`. `tenants` and `tenant_id` are additive and may stay.
* After step 4 (contract) rollback is a forward fix, so step 4 is only taken per batch after a full release cycle on step 3.
* Data is never deleted by this work; the only destructive-looking change is the cascade from `tenants` (section 6, risk 3).

## 6. Risk list
| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | Policy change silently widens or narrows access | medium / critical | Same audience by construction; per-batch pgTAP "owner sees own, other tenant sees none, anon denied"; generated before/after policy diff reviewed |
| 2 | Policy performance: function in `USING` evaluated per row | medium / high on big tables | Resolver used as `(SELECT f())` InitPlan, `tenant_id` indexed; EXPLAIN on the 10 biggest tables before wave 4 [VERIFY on production-size data] |
| 3 | Account deletion now cascades via `tenants` | low / high | Same end state as today for FK'd tables; for unconstrained tables (e.g. `call_sources`) orphans are now removed. Move to `RESTRICT` plus an explicit delete job when ownership transfer ships |
| 4 | Ownership transfer is possible but nothing implements it safely | n/a / high | Out of scope; must also move billing, Stripe customer, integrations, storage paths and audit trail. Not enabled: `tenants` has no write policy |
| 5 | Tokens, storage paths, webhooks, `app_metadata`/JWT claims embedding the owner uid | high / medium | Identity mapping keeps all ids valid forever; grep gate (below) lists every embed |
| 6 | Service-role code and edge functions bypass RLS and filter on `user_id` | high / high | Dual-write keeps them correct; wave 3 migrates them to an explicit `tenant_id` argument |
| 7 | `get_account_owner_id()` has been redefined 3+ times; the live definition may differ from the repo | medium / high | Read the live body before wave 2 [VERIFY]; a pgTAP test asserts its contract |
| 8 | Dual-write trigger adds a lookup per write | low / low | PK lookup on `tenants(owner_user_id)` (unique index); measured only on the spike [VERIFY at scale] |
| 9 | Teams: a member can also own a profile, so "which tenant" is ambiguous | medium / high | `UNIQUE(owner_user_id)` and one tenant per owner; multi-tenant users need an explicit active-tenant claim (design item, not in the spike) |
| 10 | Policies created in DO/EXECUTE blocks escape static analysis | known / medium | Section 9 catalogue query is the source of truth |

Grep gate for wave 3 (must reach 0 before contract): `grep -rn "auth.uid()" supabase/migrations | grep -v "^\S*:--"` outside an allowlist, plus edge-function `.eq("user_id"`.

## 7. Original policies of the spike tables (for rollback)
`call_sources` and `estimate_templates`: `select_own_*` FOR SELECT USING `(user_id = auth.uid())`, `insert_own_*` FOR INSERT WITH CHECK `(user_id = auth.uid())`, `update_own_*` FOR UPDATE USING and WITH CHECK `(user_id = auth.uid())`, `delete_own_*` FOR DELETE USING `(user_id = auth.uid())`, all `TO authenticated`.
`api_usage_alert_rules`: `aar_select`, `aar_insert`, `aar_update` with the same predicates (no delete policy).

## 8. What the spike proves, and what it does not
Proves: identity backfill, dual-write for legacy writers (including upsert-by-PK), preserved owner-only semantics, cross-tenant denial, anon denial, and that ownership can move by changing one `tenants` row without rewriting data.
Does not prove: behaviour at production scale, team-member flows, storage/edge paths, or any table with inbound FKs.

## 9. Verify against the live database
```sql
-- policies that still hard-code the owner uid, including those created in DO blocks
select schemaname, tablename, policyname, cmd, coalesce(qual, with_check) as predicate
from pg_policies
where schemaname = 'public'
  and coalesce(qual, with_check) ~ 'auth\.uid\(\)'
  and coalesce(qual, with_check) !~ 'current_owner_tenant_id|get_account_owner_id'
order by tablename, policyname;
```
