# Change management policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
How code, database and configuration changes are reviewed, tested, released and rolled back.

## Existing technical controls (evidence in this repository)
- PR template: `.github/pull_request_template.md`; CODEOWNERS: `.github/CODEOWNERS`
- CI gates: `docs/TESTING.md`; migration rules and rollback: `RUNBOOK.md` §3–§4
- Release checklist: `RUNBOOK.md` §1

## Gaps the owner must close before approval
- Branch protection and required reviews (GitHub settings — not verifiable from the repo)
- Emergency-change procedure
