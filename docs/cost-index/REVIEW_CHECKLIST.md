# Cost Index — release review checklist

Two **different** named reviewers must tick every item (enforced by `cost_index_publish_release`). Item keys must match `REVIEW_ITEMS` in `_shared/cost-index/release.ts`.

Release slug: `________`   Period: `________`   Cells hash: `________`
Reviewer 1: `________`   Reviewer 2: `________`   Date: `________`

- [ ] `consent_ledger_checked` — sampled ≥ 5 contributing businesses: active `granted` consent, none revoked/pending deletion
- [ ] `thresholds_confirmed` — k=10, dominance 0.35, volume 100 match METHODOLOGY.md (and any raised value is recorded in the changelog)
- [ ] `service_map_reviewed` — `cost_index_service_map` reviewed; no mapping changed silently since last release
- [ ] `spot_check_recomputed` — ≥ 3 published cells recomputed independently from raw data; matched after rounding
- [ ] `methodology_page_current` — `/cost-index` methodology text matches this `method_version`
- [ ] `legal_review_complete` — TODO(counsel): public wording and opt-in terms reviewed

Also confirm (not enforced): suppressed share is plausible; no region/trade pair looks identifying; changelog written; previous release will show as superseded.
After publishing: open `/cost-index`, download the CSV, compare 3 rows to the review sample.
