# Identity & Authorization: Phase 0 Audit and Threat Model

Scope: `vireek-main.zip` (the two uploaded zips are byte-identical). This is a static read of the code. Nothing was executed (see "Not verified").
Method: file reads plus `grep` counts over `src/`, `supabase/migrations/` (673 files) and `supabase/functions/` (426 entries). Counts are evidence of scale, not per-table classification.

## 1. How permissions work today (end to end)

| Layer | Mechanism | Evidence |
|---|---|---|
| Tenant identity | The tenant **is the owner's auth user id**. There is no `accounts` table. `profiles.id` = owner uid; `team_members.account_owner_id` points at it. | `20260821101104_create_profiles_and_team_members.sql` |
| Tenant resolution (RLS) | `get_account_owner_id()` returns own profile id, else the owner of the matching `team_members` row. Referenced ~4,015 times across migrations. | same file, lines 161+ |
| Permission flags | 9 booleans (`can_view_billing` ... `can_export_data`) in `team_members.permissions`; a `custom_roles.permissions` jsonb overrides per key. | `AuthContext.tsx`, `enterpriseSecurity.ts` |
| DB permission helper | `has_account_permission(p_key)` (re-declared with `CREATE OR REPLACE` in at least 4 migrations) plus ~53 migration files defining per-module `can_manage_*` / `can_view_*` wrappers. Used by 12 migrations. | `20271110000000_pm_integrations.sql` lines 51-71 |
| Owner-only policies | 325 policy clauses of the form `user_id = auth.uid()` (owner-only, not tenant-wide). | grep |
| UI gates | `requiresPermission` on nav items in `DashboardNav.tsx`; ~467 `permissions.can_*` references in `src/`. | grep |
| Edge functions | Flag checks in `issue-refund`, `export-run`, `bi-export-run`, `bi-admin`, `scim-v2`, `operational-truth`, `telematics-connect`. | grep |
| Staff access | `staff-impersonate` edge function: staff gate via `profiles.is_staff`, reason and ticket validation, rate limit, dual audit, magic link into the **owner's** account. | `functions/staff-impersonate/index.ts` |
| Comments | `entity_comments` with @mentions; visibility keyed on `can_view_all_jobs`. | `20270602000000_entity_comments.sql` |
| Portals | Bearer-token links: `customers.portal_token`, per-job `reschedule_token`, `quote_token`. Separate supplier and partner portal pages. | `20261106000000_portal_unification.sql` |

## 2. Confirmed gaps (grep-based; "none found" means no match in this zip)

| Gap from brief | Result |
|---|---|
| Ownership transfer | None found. Structurally blocked, see F1. |
| Guest / external collaborators | None found. Portals are anonymous bearer tokens with no identity, expiry, scope or MFA. |
| ABAC / field / record-level | None found. All visibility is tenant-wide, optionally gated by one of 9 flags. |
| Just-in-time access | None found. |
| Generic approval engine | None found. Ad hoc flows listed in section 4. |
| Member deactivation | No `deactivated` / `disabled_at` / `is_active` column on `team_members` (0 matches). Removal is a row delete. |

## 3. Findings

**F1 (architectural, blocks Phase 1).** Tenant id equals the owner's auth uid, and 325 owner-only policies compare `user_id = auth.uid()`. A new owner has a different uid, so transfer needs an indirection (a stable tenant id plus a table mapping users to owner or co-owner roles). Changing the body of `get_account_owner_id()` would fix tenant-wide policies centrally, but the 325 owner-only policies would still lock the new owner out of owner-only tables. They must be migrated to a helper, not left behind.

**F2 (high).** RLS is tenant-wide by default. Any table whose policy is only `user_id = get_account_owner_id()` is readable and writable by every member (including a technician) directly through the API, regardless of the UI gate. Permission enforcement exists only where a module opted in via a `can_*` helper. Which of the ~1,700 tables are in which state is **not classified**; Phase 3 needs that inventory as a generated report.

**F3 (high).** Two identity keys for membership. The base `get_account_owner_id()` matches `team_members.member_email` against `auth.users.email`; `has_account_permission()` and later helpers match `team_members.user_id`. `AuthContext` also loads the member by `member_email`. Email matching breaks on email change, and returns an arbitrary row (`LIMIT 1`, `maybeSingle`) if a person is invited to two accounts. The live definition may differ (see "Not verified").

**F4 (medium).** The helper definitions I read do not check `invite_status` or any deactivation state, so a pending invite is treated like an active member.

**F5 (high).** Impersonation: `expires_at` is written to `staff_impersonation_sessions` but the magic link yields an ordinary owner session. Nothing enforces the expiry, nothing marks the session as impersonated in the JWT, and RLS cannot distinguish it. There is no customer approval step. The audit trail is good; the access control is not.

**F6 (medium).** Custom role keys are unvalidated: `saveCustomRole` accepts any `Partial<UserPermissions>` shape and the DB resolver trusts any key string. A typo silently denies or, if a role key is absent, silently falls back to the base flag.

**F7 (medium).** Portal tokens are long-lived bearer links with no expiry, revocation record or access log visible in the portal bundle function. They cannot be reused as-is for scoped, MFA-protected guests; only the routing and page shells are reusable.

**F8 (low).** Session policy (idle and max age) is enforced client-side from `localStorage`, so it is advisory only.

## 4. Approval flows found

Tables: `workflow_approvals` (call-to-cash engine, unique per run step), `compiled_workflow_approvals` (workflow compiler, stores the price the human confirmed), `commercial_approvals`, and the `closeout_*` family (install closeout). Other approval-flavoured code: the agent authority matrix in `constitution.ts` (`requires_approval`, `auto_approve_max_cents`), plus approval mentions in franchise governance, margin guardrails / discount governance, change orders and quote videos (not read in detail). None share a decision table, separation-of-duties rule, delegation or escalation.

## 5. Threat model

| # | Asset | Threat | Today | Phase |
|---|---|---|---|---|
| T1 | Tenant data | Low-privilege member reads or writes via API, bypassing UI gate | Only modules with a `can_*` helper | 3 |
| T2 | Ownership | Compromised owner session transfers or deletes the org instantly | No transfer; no deletion hold | 1 |
| T3 | Ownership | Lost owner credentials, no recovery | None | 1 |
| T4 | Offboarding | Ex-employee keeps sessions, API keys, assigned records | Row delete only | 1 |
| T5 | External parties | Shared links leak, never expire, expose more than intended | Anonymous tokens | 2 |
| T6 | Org enumeration | Guest learns other customers or tenants exist | Not assessed | 2 |
| T7 | Sensitive fields | Cost, margin, PII visible to everyone who can see the record | None | 3 |
| T8 | Standing privilege | Permanent admin rights used rarely | Permanent flags | 4 |
| T9 | Vendor staff | Staff access without customer knowledge or consent | Audited, not consented, expiry unenforced | 4 |
| T10 | Money and risky settings | Requester approves their own request | Per-flow, inconsistent | 5 |
| T11 | Privilege escalation | Member edits own permissions or role | `team_members` UPDATE is owner-only by policy; custom role keys unvalidated | 3 |
| T12 | Cross-tenant | Helper bug leaks across tenants | No dedicated leak suite found | all |

## 6. Not verified

- No Postgres, no `node_modules`: no SQL was executed, and Vitest, Playwright, axe-core and `scripts/check-design-system.mjs` were not run.
- Your live project has diverged from this zip. The live definitions of `get_account_owner_id()`, `team_members` columns and invite flow may differ from what is described in F1 to F4.
- Whether a freshly invited teammate's auto-created `profiles` row (default `role = 'owner'`) changes tenant resolution depends on the invite-token flow, which I did not trace.
- Per-table RLS classification (F2) is not done.

## 7. Proposed build order after sign-off

1. Resolve F1 to F4 first: stable tenant indirection, one membership key (`user_id`), one `has_account_permission`, deactivation state. Everything else depends on it.
2. Phase 1, then 4 (JIT, which impersonation reuses), then 5 (approval engine, which ownership transfer and JIT reuse), then 2 and 3.
3. Every migration ships with a pgTAP cross-tenant and role-matrix test and a rollback note.

## 8. Implementation status (added after Phase 0)

| Area | Delivered | Verified | Not done |
|---|---|---|---|
| Approval engine | `src/lib/authz/approvalEngine.ts` + SQL `authz_create_approval` / `authz_decide_approval` / `authz_cancel_approval` / `authz_run_approval_timers` | TS: strict typecheck + 76 tests (shim runner) | SQL unexecuted; timers not scheduled; existing flows (`workflow_approvals`, `commercial_approvals`, closeout, constitution, settings changes) NOT migrated onto it; no UI; no e-signature provider |
| JIT access | `jitAccess.ts` + `authz_access_grants` and functions | TS tested; SQL unexecuted | `authz_has_permission` not adopted by any existing helper; DB break-glass (needs co-owners); impersonated-session expiry not enforceable |
| Staff access | `authz_request_staff_access`, `authz_staff_grant_active`, patch doc | not executed | patch not applied; no customer approval screen |
| ABAC / masking / ACL | `abac.ts` + `authz_record_decision`, `authz_allows`, `authz_mask_*`, `authz_simulate_record`, tables | TS tested; SQL unexecuted | NOT applied to any existing table (recipe in migration); no performance test; no simulator UI |
| Guests | `guestAccess.ts` + `authz_guest_*` | TS tested (incl. SHA-256 vector); SQL unexecuted | not applied to any existing table; portal reuse not wired; watermark not rendered anywhere |
| Ownership | `ownership.ts` + request/accept/cancel to `ready`; deletion hold | TS tested; SQL unexecuted | transfer EXECUTION, co-owner model, deletion purge, offboarding runner (checklist is TS-only), deactivation enforcement |
| Phase 0 findings F1-F8 | none fixed | | F1-F4 are prerequisites for the "not done" items above |
