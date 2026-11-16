# Restore drill log

Procedure: `docs/DB_BACKUP_RESTORE.md` ("روال اندازه‌گیری RTO واقعی") + `scripts/dr/restore-drill.sh`. Run against STAGING or a throwaway restored project, never production.
**No drill has been performed yet. Table intentionally empty. Do not fill with estimates.**

## Checklist
- [ ] Supabase plan includes PITR/backups; retention noted: ______ (dashboard → Database → Backups)
- [ ] Staging DB seeded with realistic volume (size: ______ GB)
- [ ] `scripts/dr/restore-drill.sh marker` run on staging (writes marker row, prints T0 timestamps)
- [ ] Wait ≥ 5 min, then trigger PITR/restore to T0+2 min into a NEW project; note request time
- [ ] When the restored project is "healthy", run `scripts/dr/restore-drill.sh verify` against it; note time
- [ ] Application smoke test against the restored project: login, dashboard load, one booking, `/status` → note time green
- [ ] Record results below; open issues for anything slower than the proposed targets in `docs/SLO.md`

## Results
| Date | DB size | Method (PITR / backup) | Restore requested | App healthy | **RTO (min)** | Marker written | Newest row after restore | **RPO (s)** | Operator | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

RTO = app healthy − restore requested (not the `dr-restore-drill` function's `rto_seconds`, which excludes real restore time per DB_BACKUP_RESTORE.md).
RPO = marker written − newest surviving marker row.
