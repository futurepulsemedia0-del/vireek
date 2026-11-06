# Secrets and key rotation policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
Handling, storage and rotation of secrets and encryption keys.

## Existing technical controls (evidence in this repository)
- Procedure and leak response: `RUNBOOK.md` §7; gitleaks in `security.yml`; secret inventory: `docs/generated/ENV_USAGE.md`

## Gaps the owner must close before approval
- Rotation cadence per secret class; encryption-key re-encrypt plan
