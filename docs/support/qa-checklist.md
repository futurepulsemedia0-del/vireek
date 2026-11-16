# QA checklist

## A. Ticket QA (sample 5 closed tickets per agent per week — proposed)
Score each 0/1; below 6/7 → coaching note.
1. Severity was correct and confirmed in time
2. First response within target
3. Correct, specific answer (no guessing; unknowns stated)
4. Tone clear and respectful; no jargon
5. No secrets/PII requested or pasted
6. Escalated when criteria required it, with a complete packet
7. Closed with customer confirmation and a one-line cause/fix

## B. Verification for the severity + overdue feature
- [ ] `npm run lint:migrations` passes; migration applies twice without error (idempotent)
- [ ] `supabase test db` — `support_severity_sla.test.sql` passes
- [ ] `npx vitest run src/lib/supportSla.test.ts` and `npm run typecheck` pass
- [ ] Tenant: new ticket works exactly as before; customer SLA labels unchanged
- [ ] Tenant cannot change severity/clock via the API; cannot read `support_sla_targets`; sees nothing in `support_overdue_tickets`
- [ ] Staff: severity select + "Confirm" stamp who/when; "Overdue only" matches the view
- [ ] Editing a target changes the overdue set on next refresh
- [ ] Existing live chat (kind='chat') unaffected; rows keep severity NULL
- [ ] Two tabs: staff reply stops the first-response clock; customer reply does not restart it
