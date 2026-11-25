# Reputation credentials — fill-in template

Owner: TODO(owner) · Counsel review: TODO(counsel) · Last reviewed: TODO

## Consent wording shown to the technician / business
TODO(counsel): exact consent text per scope (verified jobs, outcomes, license checks), withdrawal rights, data-protection basis per region.

## Public verification page footer
TODO(counsel): disclaimer wording (the page currently says Vireek confirms only what the person agreed to publish).

## Operational decisions
| Item | Current value | Owner decision |
|---|---|---|
| Max validity | 365 days (default 180) | TODO(owner) |
| Min sample for rates | 10 completed jobs | TODO(owner) |
| License "checked" meaning | manager attests a lookup / document review | TODO(counsel) |
| Signing key rotation | manual: new kid, old kid → retired | TODO(owner): cadence |

## Key custody
Private key only in secret `REPUTATION_SIGNING_KEY_JWK`. Compromise → set the key `status='revoked'` (all its credentials stop verifying) and issue a new kid.
