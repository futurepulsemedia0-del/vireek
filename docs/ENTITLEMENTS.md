# Module entitlements

Per-account switches for gated modules. They sit **next to** feature flags, not instead of them
([FEATURE_FLAGS.md](./FEATURE_FLAGS.md)):

| Layer | Question | Scope | Where |
|---|---|---|---|
| Feature flag | Is the code released / at what rollout %? | Platform, per tenant override | `/staff/feature-flags` |
| Entitlement | Does THIS account have the module? | One account | `/staff/entitlements` |

A new module ships behind **both**, default **off**. Default is deny everywhere: no row, `off`, expired,
still loading, signed out, or a failed first load all mean "not allowed".

## Model

`account_module_entitlements (tenant_id, module_id, state, source, expires_at, reason)`, one row per account and module.

- `module_id`: `core`, `pay`, `ai`, `supply`, `finance`, `passport`, `intelligence`, `connect`, `packs:<slug>`.
  To add an id, `CREATE OR REPLACE FUNCTION is_valid_module_id()` in a new migration, and mirror the regex in
  `src/lib/entitlements.ts` and `supabase/functions/_shared/entitlements/requireEntitlement.ts`.
- `state`: `off` | `trial` (needs `expires_at`) | `on`. `expires_at` also works on `on` for time-boxed grants.
- `source`: `manual` (staff), `plan` (billing/plan sync), `override` (staff override a plan sync must **not** overwrite).
- Tenant = account owner's profile id; team members resolve to it via `get_account_owner_id()`.
- Every change is written to `module_entitlement_audit` by trigger. It is append-only (UPDATE/DELETE/TRUNCATE raise).
- Seed: existing owners get `core = on`; a trigger on `profiles` gives every new owner `core = on`.

## Using it in a new module

| Where | How |
|---|---|
| Route | `<ProtectedRoute><ModuleGate module="pay" flag="module_pay"><PayPage /></ModuleGate></ProtectedRoute>` |
| Nav / command palette | `requiresModule: 'pay'` on the `NavItem` |
| Component logic | `const { allowed, status, daysLeft } = useEntitlement('pay')` |
| Lists | `const { has } = useEntitlements()` (one subscription, no extra requests) |
| SQL / RLS / RPC | `has_module('pay')` (for the caller's tenant) |
| Edge function | `await requireEntitlement(checker, tenantId, 'pay')` with `tenantId` from the **verified** caller |

UI gating is a convenience. **Always** enforce on the server (`has_module()` in RLS or RPCs, `requireEntitlement()` in
functions), otherwise a direct API call bypasses the page.

```ts
// edge function, module scope
const entitlements = createEntitlementChecker({ rpc: (fn, args) => serviceClient.rpc(fn, args) });
// inside the handler, after authenticating the caller and resolving the tenant:
await requireEntitlement(entitlements, tenantId, 'pay'); // throws HttpError('forbidden')
```

## Caching and freshness

- Client: one `get_my_entitlements()` call returns every module; cached 5 min, refetched on tab focus and after
  `refreshEntitlements()`. Expiry is re-checked against the clock on every read, so an expired trial stops working
  without a refetch. A failed refetch keeps the last rows; a failed first load stays denied.
- Edge: 10 s cache per tenant+module. A recent `true` survives a short outage (60 s); `false` never turns into `true`.
- A staff revoke reaches a running tab on its next focus/refresh (up to the TTL); server checks see it within 10 s.

## Operations

- Grant / revoke: `/staff/entitlements` (staff only, reason required, history shown).
- Rollback: see the `-- rollback:` note in `supabase/migrations/20290301000000_module_entitlements.sql`.
  Dropping the tables deletes the audit history, so export `module_entitlement_audit` first.
- Tests: `src/lib/entitlements.test.ts`, `src/hooks/useEntitlement.test.tsx`, `src/components/ModuleGate.test.tsx`,
  `src/pages/admin/EntitlementsAdminPage.test.tsx`, `supabase/functions/_shared/entitlements/requireEntitlement.test.ts`,
  and pgTAP `supabase/tests/database/module_entitlements.test.sql` (cross-tenant isolation, staff-only writes, expiry, audit).
