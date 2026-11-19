# Maker-checker (requester ≠ approver)

Closes threat **T10** of `identity-authz-audit.md` ("requester approves their own request"). Migration: `supabase/migrations/20290306000000_maker_checker.sql`. Tests: `supabase/tests/database/maker_checker.test.sql` (pgTAP), `scripts/security/maker-checker.test.mjs` (static).

## The rule

`public.maker_checker_assert(tenant, subject_type, subject_id, amount_cents, requester, approver, risky)` raises `42501 maker_checker_violation` when requester and approver are the same person, unless:

1. **Threshold.** The amount is KNOWN and below the tenant's `maker_checker_settings.money_threshold_cents` (default `0` = nothing is exempt). An unknown amount (`NULL`) and `risky = true` are never exempt.
2. **Solo owner.** The approver is the tenant owner, the tenant has no other active team member, and `solo_owner_exception` is on (default on). Allowed, and written to `audit_log` as `maker_checker.solo_self_approval`.

No human requester (`requested_by IS NULL`: automation, engine ticks, service role) means nothing to enforce, because the approver is always a person.

## Inventory

| Flow | Requester recorded as | Enforced by | Status |
|---|---|---|---|
| `workflow_approvals` | `requested_by` (new, default `auth.uid()`) | `trg_maker_checker_guard` (generic, `status → approved`) | Guarded. Live runs are enrolled by events, so `requested_by` is usually NULL and the rule has nothing to compare; it bites for human-started runs. |
| `compiled_workflow_approvals` | `requested_by` (new, default `auth.uid()`) | same trigger; `price_cents` is the amount | Same as above. |
| `closeout_steps` (`ready_for_approval → submitted`) | `approval_requested_by` (new; set by the trigger to `auth.uid()` when the step enters `ready_for_approval`) | `trg_maker_checker_closeout_guard`; `estimated_value_cents` is the amount | Guarded. Pre-approval (`closeout_set_pre_approval`) records an external confirmation number and has no internal requester, so it is out of scope. |
| `commercial_approval_requests` / `_decisions` | `requested_by` (existing) | RPC `commercial_decide_approval` (existing, stricter: always refuses) + table trigger `trg_maker_checker_commercial_decision` as a backstop | Guarded twice. |
| `authz_approval_*`, `authz_access_grants` | `requester_id` (existing) | RPCs raise `authz: self_approval_forbidden` | Already compliant; untouched. |
| `commercial_approvals` | — | — | Not an internal approval: it records a customer's PO. Out of scope. |
| `approve_and_post_pay_run`, `pn_approve_order`, `approve_inventory_count`, `approve_retention_action`, `approve_leak_retrofit_plan`, `sa_approve_packet`, `approve_emergency_network_handoff`, `approve_partner_application`, `approve_decision_ledger_entry` | not assessed | not assessed | **[VERIFY]** Found by name only; the money ones (pay run, procurement order, inventory count) are the next candidates. |

## Settings

`maker_checker_settings` (one row per tenant, `user_id` = owner). Read: any member of the tenant. Write: `authz_can_admin()` only; every change is audited (`maker_checker.settings.change`, old and new values). No row = defaults.

## Adopting it for another approval flow

1. Add a nullable `requested_by uuid` (default `auth.uid()`) and make sure it is never rewritten.
2. Attach the generic guard: `CREATE TRIGGER trg_maker_checker_guard BEFORE UPDATE ON <table> FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.requested_by IS DISTINCT FROM NEW.requested_by) EXECUTE FUNCTION public.maker_checker_guard('<subject>', '<approved status value>', '<amount column or empty>');` The table needs `status`, `requested_by`, `decided_by`, `user_id` and `id`.
3. Add a temp-table test like the ones in `maker_checker.test.sql`.

## Limits and not done

- Existing pending rows have `requested_by NULL` and keep their old behavior.
- A refused approval rolls back with its transaction, so blocked attempts are visible as errors, not as audit rows.
- No admin UI for the settings (the table is RLS-protected and writable by admins). If you add one it needs i18n, RTL, permission gating, and loading/empty/error states.
- A tenant owner with a team can no longer approve their own request. That is the intent of T10; it is a behavior change to announce.
- Not executed here: no Postgres was available, so the SQL and pgTAP file have never run. `[VERIFY]` by running `supabase test db` after applying the migration to a clone.
