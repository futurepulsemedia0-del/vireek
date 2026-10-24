# Vireek Insights: privacy review checklist and runbook

Insights publishes aggregated industry indexes built from businesses that opted in.
Nothing is released until a named reviewer completes this checklist.

## 1. Quarterly release procedure

Run in the Supabase SQL editor (service role / postgres).

1. A draft is created automatically on the 5th day after each quarter ends (pg_cron
   `vireek-insights-generate-draft`). To create or rebuild one by hand:
   `select public.insights_generate_publication(2027, 4);`
2. Review the draft (queries in section 3). Complete every item in section 2.
3. Publish: `select * from public.insights_publish('<publication id>');`
   `insights_publish` re-checks the k-anonymity audit itself and refuses on failure.
4. Verify as an anonymous visitor: `/insights` shows the new quarter, national cells only.
5. If anything is wrong after release: `select * from public.insights_retract('<publication id>', 'reason');`
   Retracted data disappears from the page, the PDF/CSV source, the dashboard and the API at once.
   A published release can never be edited or deleted.

## 2. Privacy review checklist (sign off every line)

Consent and scope
- [ ] Only businesses with `insights_settings.contribute = true` are included (generator joins on it).
- [ ] The consent text on `/dashboard/insights` matches what is actually published (CONSENT_* in `src/lib/insights.ts`).
- [ ] Withdrawals since the last release are excluded; the consent log shows each grant/withdrawal.
- [ ] No free text, names, addresses, phone numbers, ids or dates leave a business: only 5 numeric metrics, trade key, state code.

Aggregation and thresholds
- [ ] Every published cell has an audit row with `contributor_count >= 10` and `distinct_values >= 3`.
- [ ] Suppressed cells reviewed (`insights_suppression_log`); nothing was lowered or overridden to publish more.
- [ ] Only p25 / median / p75 are published. No min, max, mean or sum anywhere.
- [ ] Public cells show a band (10-19, 20-49, 50-99, 100+), never an exact count; total contributors is rounded down to 10.
- [ ] Trade vocabulary is the fixed list in `insights_trade_key`; unknown trades ('other') are not published.

Attack resistance
- [ ] Noise is stable per (period, trade, region, metric) so re-running cannot average it away.
- [ ] No single cell is dominated by one business or one franchise/parent group (manual check for large franchisors; the system cannot see ownership groups).
- [ ] Small-state cells and rare trades checked for "one obviously identifiable business" even above k (e.g. the only roofer in a small state). If in doubt, suppress by retracting and regenerating before publishing.
- [ ] National totals vs state cells cannot isolate a small state (medians only, no sums or counts).

Access and release
- [ ] Public page and PDF/CSV use only `insights_public_indexes` (national). State cells are served only by `insights_member_indexes` (contributors) and the subscriber API.
- [ ] Anonymous users cannot read `insights_index_cells` directly (RLS: staff only).
- [ ] API keys: only SHA-256 stored, scope `insights:read`, per-key rate limit, expiry set, request log pruned after 90 days.
- [ ] Subscriber contract/terms accepted (`insights_subscribers.terms_accepted_at`) and forbid re-identification and resale of raw data.

Honesty
- [ ] Marketing and docs say "differential-privacy-inspired noise", never "certified" or "epsilon-DP".
- [ ] Privacy policy / DPA mention Insights as an opt-in use of aggregated business data.
- [ ] `supabase test db` passes (`vireek_insights.test.sql`) and `npm test` passes on this release.

Reviewer: ____________  Date: ____________  Publication id: ____________

## 3. Review queries

```sql
-- cells per level and band
select c.trade, c.region_key, c.metric, c.contributor_band, c.p25, c.p50, c.p75, a.contributor_count, a.distinct_values
from insights_index_cells c join insights_cell_audit a on a.cell_id = c.id
where c.publication_id = '<publication id>' order by c.trade, c.region_key, c.metric;

-- anything that failed a gate (reason only)
select reason, count(*) from insights_suppression_log where publication_id = '<publication id>' group by reason;

-- smallest published cell must be >= 10
select min(a.contributor_count) from insights_cell_audit a join insights_index_cells c on c.id = a.cell_id
where c.publication_id = '<publication id>';
```

## 4. Subscribers and API keys

```sql
insert into insights_subscribers (name, contact_email, tier, terms_accepted_at)
values ('Acme Analytics', 'data@acme.com', 'standard', now()) returning id;

select * from insights_issue_api_key('<subscriber id>', 'production', 60, 365);  -- raw key shown ONCE
select insights_revoke_api_key('<key id>');
```

Endpoints (Bearer vrk_ins_...): `GET /functions/v1/insights-api/v1/publications`,
`/v1/indexes?period=2027-Q4&trade=hvac&region=tx&metric=close_rate_pct&format=csv`, `/v1/methodology`.
Deploy: `supabase functions deploy insights-api --no-verify-jwt`.

## 5. Known limits (state them, do not hide them)

- Noise is DP-inspired, not formally proven epsilon-DP.
- Consent applies at generation time; a business that opts in after quarter end is included in that quarter's draft.
- Withdrawal does not recompute already published quarters (disclosed in the consent text).
- Region is a best-effort US state parsed from free-text `service_area` (`ob_region_key`); businesses it cannot place count only in national cells.
