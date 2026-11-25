# Subcontractor licence verification and insurance (COI) — owner worksheet

Status: DRAFT template. Nothing here is legal or insurance advice. `TODO(owner)` = you decide; `TODO(counsel)` = counsel/broker decides.

## 1. Decisions to make before switching enforcement on
| Decision | Where | Value |
|---|---|---|
| Block assignment on missing/expired insurance? | Vendors → vendor → Rules | TODO(owner) (default OFF) |
| Required coverage lines | Rules | TODO(owner) / TODO(counsel) |
| Minimum general-liability limit per occurrence | Rules | TODO(counsel) (empty = none) |
| Grace days after expiry | Rules | TODO(owner) (0–30) |
| Licence re-check interval | Rules | TODO(owner) (empty = off) |
| Who may verify COIs / record licence checks | Owner, admin, or member with billing permission (fixed in SQL) | — |
| Who may change Rules | Owner / admin only (fixed in SQL) | — |

## 2. Manual licence check (per subcontractor)
1. Open the state licensing board's public lookup (TODO(owner): list your states and URLs).
2. Record: licence number, state, status, expiry, name on licence, link to the record page.
3. "Active" cannot be saved without the link. Records are append-only; re-check = new record.

## 3. COI intake (per subcontractor)
1. Upload the certificate (PDF/photo ≤ 10 MB) and key in each line: carrier, policy no., dates, limits.
2. A manager compares the numbers to the file and presses Verify. Any later edit resets to Unverified.
3. Exemptions (e.g. no employees → no workers' comp) need a written reason; keep proof. TODO(counsel): acceptable exemption wording.

## 4. Operations
- Daily sweep `vendor_compliance_sweep()` (pg_cron `vireek-vendor-compliance-sweep`, 06:20) notifies at 30/14/7 days and on expiry; each alert fires once.
- No state API adapter is enabled: add a `verification_sources` row (provider `socrata`) only after confirming the board publishes a public dataset. TODO(owner).
- OCR: the existing OCR function is receipt-only; COI fields are keyed manually.
