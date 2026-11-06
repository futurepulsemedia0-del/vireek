# Data classification and retention policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
Classes of data, handling rules, retention and deletion.

## Existing technical controls (evidence in this repository)
- PII map: `docs/compliance/data-map.md`, `pii_field_registry`
- Retention and erasure: `data_retention_policies`, `deletion_requests`, `data-retention-sweep`, `delete-account`; coverage check `scripts/compliance/check-erasure-coverage.mjs`

## Gaps the owner must close before approval
- Formal classification levels and retention periods per class
