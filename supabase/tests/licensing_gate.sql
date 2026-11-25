-- Manual / staging verification for the licensing gate (NOT RUN by the author: no Postgres available).
-- Run in the SQL editor against a STAGING project. Replace <STAFF_USER_ID> and <TENANT_OWNER_ID>.
-- Everything is wrapped in a transaction and ROLLED BACK.
begin;

-- 0) Seed state: every capability exists, closed, not killed.
select capability, licensing_confirmed, kill_switch from public.licensing_gate order by 1;
--    expect 7 rows: bnpl_legacy, escrow, financing_partners, pay_capital, pay_earned_wage_access,
--    pay_instant_payouts, pay_spend_cards  -> all licensing_confirmed=false, kill_switch=false

-- 1) Decision function fails closed.
select public.licensing_gate_state('bnpl_legacy');     -- {"allowed": false, "reason": "licensing_not_confirmed"}
select public.licensing_gate_state('does_not_exist');  -- {"allowed": false, "reason": "unknown_capability"}
select public.licensing_gate_allows('escrow');         -- false

-- 2) Evidence is mandatory (CHECK constraint, even for a direct write as postgres):
--    update public.licensing_gate set licensing_confirmed = true where capability = 'escrow';
--    -- expect: violates check constraint "licensing_confirmed_needs_evidence"

-- 3) Staff RPCs. Impersonate a staff user:
--    set local role authenticated;
--    select set_config('request.jwt.claims', '{"sub":"<STAFF_USER_ID>"}', true);
--    select public.staff_licensing_gate_set('escrow', true, null, 'attempt without counsel ref');   -- expect 22023
--    select public.staff_licensing_gate_set('escrow', true, 'COUNSEL-TEST-1', 'staging test only'); -- ok
--    select public.licensing_gate_allows('escrow');   -- permission denied for authenticated (service_role only)
--    reset role;
--    select public.licensing_gate_allows('escrow');   -- true (as postgres/service role)

-- 4) Non-staff cannot use the RPCs:
--    set local role authenticated;
--    select set_config('request.jwt.claims', '{"sub":"<TENANT_OWNER_ID>"}', true);
--    select public.staff_licensing_kill_all('should be refused');   -- expect 42501 "Staff only"
--    select * from public.licensing_gate;                           -- expect permission denied
--    reset role;

-- 5) Kill switch beats confirmation, and resume does not re-confirm:
--    (as staff) select public.staff_licensing_kill_all('staging kill drill');   -- returns number of rows changed
--    select public.licensing_gate_state('escrow');                              -- {"allowed": false, "reason": "killed"}
--    (as staff) select public.staff_licensing_resume('escrow', 'staging resume');
--    select public.licensing_gate_state('escrow');                              -- allowed again only because step 3 confirmed it

-- 6) Audit is append-only and records every change:
select capability, action, reason, actor from public.licensing_gate_audit order by id desc limit 10;
--    update public.licensing_gate_audit set reason = 'x';   -- expect 42501 "licensing_gate_audit is append-only"
--    delete from public.licensing_gate_audit;               -- expect 42501

-- 7) Legacy BNPL database backstop (needs one existing job/user row; gate must be closed):
--    insert into public.financing_offers (user_id, customer_name, requested_amount_cents)
--    values ('<TENANT_OWNER_ID>', 'Gate Test', 50000);      -- expect 42501 "licensing_not_confirmed"
--    -- then confirm 'bnpl_legacy' as in step 3 and repeat: insert should now succeed (rolled back below).

-- 8) Pay live mode honours the gate (use a product that has agreement ref + reviewed disclosures in staging,
--    otherwise you will see 'disclosures_not_reviewed' only AFTER the licensing check passes):
--    select public.pay_product_state('instant_payouts', '<TENANT_OWNER_ID>') ->> 'reason';
--    -- with mode='live' and pay_instant_payouts closed: 'licensing_not_confirmed'; in sandbox: unaffected.

-- 9) Partner financing: with the flag on and gate closed, fin_gate reports the licensing reason.
--    select public.fin_gate('<TENANT_OWNER_ID>', 'consumer_financing') ->> 'reason';  -- 'licensing_not_confirmed'
rollback;
