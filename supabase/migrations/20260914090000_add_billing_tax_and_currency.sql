-- Adds tax + real invoicing-currency fields. Purely additive: existing
-- columns (jobs.invoice_amount, etc.) keep their exact current meaning
-- (invoice_amount stays the pre-tax SUBTOTAL), so nothing that already
-- reads these tables breaks.

alter table profiles
  add column if not exists business_country text,
  add column if not exists business_vat_number text,
  add column if not exists invoice_currency text not null default 'USD';

alter table jobs
  add column if not exists customer_country text,
  add column if not exists customer_vat_number text,
  add column if not exists invoice_currency text,
  add column if not exists invoice_vat_rate numeric,
  add column if not exists invoice_vat_amount numeric,
  add column if not exists invoice_reverse_charge boolean not null default false;

comment on column jobs.invoice_amount is 'Pre-tax subtotal. Total owed = invoice_amount + invoice_vat_amount.';
comment on column jobs.invoice_currency is 'ISO currency code for this invoice. Falls back to profiles.invoice_currency when null.';
