# Feature flags

Pure logic and types: `src/lib/featureFlags.ts` (+ `featureFlags.test.ts`) · data access: `src/lib/featureFlagsApi.ts` · React hook: `src/hooks/useFeatureFlag.ts` · staff UI: `src/components/staff/FlagDetailPanel.tsx`, `src/pages/admin/PilotManagementPage.tsx`.

## Model
- Table `feature_flags` (key, name, description, `enabled`, `rollout_pct`) plus per-tenant overrides (`on` / `off` / inherit). Staff-only RPCs: `staff_list_feature_flags`, `staff_list_flag_overrides`, `staff_set_flag_override`, `staff_search_tenants`, `staff_list_flag_audit` (every change is audited).
- Tenants read their effective flags through `get_my_feature_flags()`.
- Key format: `/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/` (`FLAG_KEY_RE`).
- Client cache: one shared store per tab, TTL 5 minutes (`FLAG_CACHE_TTL_MS`), refreshed when the tab regains focus.

## Use in code
```tsx
const { isEnabled, ready } = useFeatureFlag();
if (ready && isEnabled('my_new_feature')) { /* ... */ }   // second argument = fallback while not ready
```
Always design the **off** state to be the safe, current behaviour. Flags are client-visible: never use one as the only guard for a sensitive server action — enforce on the server/RLS as well. Known flag in docs: `data_residency_ui` (default off, see `docs/compliance/adr-0001-data-residency.md`).

## Lifecycle
Create (staff) → roll out by percentage or per-tenant override → remove the flag and its dead branch within a release or two. Record owner and removal date in the flag description.
