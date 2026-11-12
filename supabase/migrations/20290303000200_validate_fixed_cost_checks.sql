/*
  # Validate the widened provider_cost_rates CHECKs added NOT VALID in 20290303000100_fixed_monthly_cost_rates.sql.
  The new checks only add allowed values, so validation cannot fail on existing rows; the table is tiny.
  Idempotent: validating an already-valid constraint is a no-op.
*/

-- rollback: nothing to undo (validation changes no data); to revert the widening see 20290303000100_fixed_monthly_cost_rates.sql.

ALTER TABLE public.provider_cost_rates VALIDATE CONSTRAINT provider_cost_rates_component_check;
ALTER TABLE public.provider_cost_rates VALIDATE CONSTRAINT provider_cost_rates_unit_check;
