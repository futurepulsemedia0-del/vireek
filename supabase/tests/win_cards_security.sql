-- Manual / staging verification for Win Cards (NOT RUN by the author: no Postgres available).
-- Run in the SQL editor against a STAGING project, two accounts A and B. Replace the uuids. Wrap in a transaction and ROLLBACK.
begin;
-- 1) Tenant isolation: as a user of account B, A's cards must be invisible.
--    set local role authenticated; select set_config('request.jwt.claims','{"sub":"<B_USER_ID>"}',true);
--    select count(*) from win_cards where user_id = '<A_OWNER_ID>';              -- expect 0
-- 2) Clients cannot write:
--    insert into win_cards(user_id,trigger_type,dedupe_key,private_facts) values ('<B_OWNER_ID>','milestone_calls','x','{}');  -- expect permission denied
-- 3) public_fields immutable after approval (as service role):
--    update win_cards set public_fields='{}' where id='<APPROVED_ID>';           -- expect 42501
-- 4) Approve idempotency / quota: call win_card_approve twice with the same card -> same token returned, one audit row.
-- 5) Revoked is final:  update win_cards set status='approved' where id='<REVOKED_ID>';   -- expect 42501
-- 6) Reports: 3 distinct hashes via win_card_report(...) -> third returns 'suspended'; same hash again -> 'duplicate'.
rollback;
