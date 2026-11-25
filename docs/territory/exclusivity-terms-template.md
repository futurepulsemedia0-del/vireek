# Territory exclusivity — fill-in template

Owner: TODO(owner) · Counsel review: TODO(counsel) · Last reviewed: TODO

## Agreement terms (TODO(counsel))
Grant, exclusivity scope, holder obligations (minimum activity?), suspension rights, termination, renewal, remedies, governing law, antitrust / competition review of exclusivity.

## Commercial fields (TODO(owner))
| Field | In system | Decision needed |
|---|---|---|
| Fee amount / currency / billing cadence | recorded only (fee_cents, fee_currency) | pricing, invoicing |
| Waiting-list offer hold | 72 h (`territory_offer_hold_hours()`) | confirm |
| Auto-renew | flag recorded, NOT executed | renewal process |
| Does exclusivity limit an account's OWN inbound callers/customers? | No — applies to Vireek-originated leads and marketing only | confirm |

## Effect on routing / marketing
Implemented: `territory_lead_decision` (service role), `territory_marketing_guard` (account tool).
Not wired: no cross-account lead router or ZIP-targeted campaign code exists in the repo to hook into.
