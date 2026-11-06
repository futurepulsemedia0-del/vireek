# Backup and disaster recovery policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
Backup coverage, restore testing and recovery objectives.

## Existing technical controls (evidence in this repository)
- Real state of layers and limits: `docs/DB_BACKUP_RESTORE.md` (states that no RTO/RPO has been measured)
- `dr-backup-run`, `dr-restore-drill`; `RUNBOOK.md` §5

## Gaps the owner must close before approval
- Measured RPO/RTO targets and drill evidence location
- Supabase plan, PITR retention and restore owner
