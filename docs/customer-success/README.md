# Customer success playbooks

Four playbooks that turn the signals Vireek **already computes** into repeatable staff actions. Nothing here adds a score or a table: every playbook names the existing source it reads.

| Playbook | Stage | Primary signal |
|---|---|---|
| [Onboarding](./onboarding.md) | Days 0-30 | `health.band = 'new'`, activation factor, `PLAYBOOKS` in `successTools.ts` |
| [At-risk](./at-risk.md) | Any active account | `computeSuccessRisk()` level `high` / `medium` |
| [Churn-save](./churn-save.md) | Billing trouble or cancel intent | `profiles.dunning_stage`, `subscription_cancellations` |
| [Expansion](./expansion.md) | Healthy, growing accounts | usage factor, `nps_responses`, `success_feature_catalog` |

## Where the signals come from

| Signal | Source (verified in repo) | Computed where |
|---|---|---|
| Health score + band | `computeHealth()` in `supabase/functions/_shared/staff/accountExplorer.ts` | Pure TS; fed by `staff_account_overview()` |
| Blended success risk | `computeSuccessRisk()` in `src/lib/successTools.ts` (health 55% / adoption 30% / NPS 15%) | Client-side in the staff UI; **not stored** |
| Feature adoption | `success_feature_catalog` + `_success_usage_matrix()` | `staff_success_overview()` (staff only, audited) |
| NPS | `nps_responses`, `submit_nps_response()`, `nps_should_prompt()` | Written only through the RPC |
| Dunning | `profiles.subscription_status`, `dunning_stage`, `payment_failed_at`, `payment_grace_period_ends_at`; `enforce-payment-suspension` | Stripe webhook |
| Cancel / pause / win-back | `manage-subscription-cancellation` edge function, table `subscription_cancellations` | Edge function (service role) |
| Plan change | `manage-subscription-plan` edge function | Edge function |
| Module grants | `account_module_entitlements` (see [ENTITLEMENTS](../ENTITLEMENTS.md)) | `/staff/entitlements` |

Staff surfaces: `/staff/customers` (`StaffCustomersPage`) shows `AtRiskAccountsPanel`; each account detail shows `AccountSuccessSection`.

## Conventions

- **Code-defined** values are copied from the code and are guarded by `src/lib/customerSuccessPlaybooks.docs.test.ts`. If a constant changes, the test fails and this document must be updated.
- **[POLICY]** values (response times, who owns what) are proposals. No CS role or SLA exists in the repo; an owner must confirm them. **[VERIFY]**
- Owners are written as roles, not people. The repo has `profiles.is_staff` only; there is no finer CS role. **[VERIFY]**
- Staff access to tenant data always goes through the audited `staff_*` RPCs. Never read a tenant's tables directly and never answer or dismiss NPS prompts on a customer's behalf (the RPCs refuse this while impersonating).

## Known gaps (honest list)

1. Follow-up tasks live in the staff-only `staff_cs_tasks` table behind flag `cs_auto_tasks` (default off); see [at-risk.md](./at-risk.md#automation-flag-gated-default-off). They are created when staff open the at-risk tab, not by a background job, and are never auto-closed.
2. The blended risk level is computed in the browser and never persisted, so there is no risk history.
3. `subscription_cancellations` stores reasons, but no staff screen aggregating them was found. **[VERIFY]**
4. Success metrics below have no stored baseline. Capture one before judging a playbook.
