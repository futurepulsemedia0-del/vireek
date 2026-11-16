# Runbook: database outage (Supabase Postgres)

Related: `docs/DB_BACKUP_RESTORE.md`, `restore-drill-log.md`, `RUNBOOK.md` §6. **No RTO/RPO has been measured**: do not quote any to customers until the restore drill log has real numbers.

## 1. Detect
Edge functions returning 5xx/timeouts, `/status` red, Supabase dashboard alerts, `webhook_5xx_high`.

## 2. Triage (10 min)
1. Supabase status page + project dashboard (CPU, connections, disk, "restoring" banner).
2. Cause class: (a) provider incident → wait/escalate to Supabase support; (b) connection exhaustion → find the runaway function, disable its cron; (c) disk full → free space/upgrade; (d) bad migration → roll back per RUNBOOK §4; (e) data corruption/deletion → PITR (below).

## 3. What keeps working during a DB outage (by design, verify in drill)
- Inbound calls: `voice-front-door` reads the DB for level/contact; helpers **fail open toward answering** (`effectiveLevel` defaults to L0; the last-resort catch speaks a "technical difficulties / call 911" message). The AI engine itself does not need our DB to start, but tool calls (booking, lookup) will fail → expect L1 behavior and missed bookings.
- Vapi webhooks: ledger fails open → events are processed when the DB returns only if the provider retries; otherwise `voice-reconcile` recovers them after recovery. Expect late leads, not lost ones, provided reconcile's lookback window covers the outage (check its window before relying on this).
- Missed-call rows cannot be written during the outage: the Twilio recording/provider logs are the source of truth; reconcile after recovery.

## 4. Recovery
- Provider-side incident: wait; after recovery run `voice-reconcile`, replay `dead` ledger rows, check Stripe/QuickBooks webhook backlogs (replay from vendor dashboards).
- PITR restore: restoring replaces data after the chosen time. Choose the timestamp just before the bad event, restore to a NEW project first when possible, compare, then cut over. Steps and timing: `docs/runbooks/restore-drill-log.md`.

## 5. Communications templates
**Status page:** "We are experiencing a service disruption affecting the dashboard and bookings. Phone calls continue to be answered or sent to voicemail. We will update every 30 minutes."
**Resolved:** "Service restored at {time}. Data recorded between {t1} and {t2} may appear with a delay; we are re-processing it. No action is needed from you."
**If data loss is possible (PITR to earlier time):** state the exact window of affected data once known; involve legal/privacy per `incident-response.md` (regulatory notification deadlines are a human/legal decision).

## 6. After
Postmortem; update the drill log with real timings.
