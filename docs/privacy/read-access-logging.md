# Sensitive read-access logging — governance (draft for counsel review)

**Purpose limitation.** `sensitive_read_log` exists only for: (1) security detection, (2) showing customers who accessed their data, (3) incident response / compliance evidence. It must NOT be used for employee performance management, productivity scoring or ranking. Enforced technically: team members cannot query the table; history is per record; no per-employee aggregate view or export exists.

**Data minimisation.** No content. Fixed columns: tenant, actor id/kind, asset class, action, channel, record UUID, count, enumerated purpose. `target_id` must be a UUID (DB CHECK). Staff are never named to customers ("Vireek support").

**Retention.** `sensitive_read_policy.retention_days` (default 400, minimum 90), enforced by dropping whole monthly partitions (`drop_expired_sensitive_read_partitions`). Account deletion: call `erase_sensitive_read_log_for_account(account_id)` (service role). Alerts hold counts only.

**Flags for counsel (not legal advice).** Logs reveal which employees opened which customer records, i.e. employee monitoring: (a) EU/Germany — works-council co-determination (BetrVG §87(1) no. 6), GDPR Art. 6(1)(f) balancing test, Art. 13/14 notice to staff, DPIA, Art. 88 national rules; (b) California — CPRA employee-data notice; (c) other states/countries with employee-monitoring notice or consent rules; (d) call-recording consent laws apply to the recordings themselves, separately; (e) customers' own DPAs/subprocessor terms for Vireek staff access; (f) off-hours rule uses a UTC window — decide whether per-tenant time zones are required; (g) whether the 400-day default fits each contract.

**Compliance evidence.** Alerts are mirrored into `audit_log` (`sensitive_read_alert`), so existing SIEM streaming carries them. Not wired to a dedicated compliance-evidence module (not found in the snapshot).

**Performance budgets (targets, not measured).** `read_call_sensitive` adds 1–2 indexed inserts + one indexed range-sum; detection runs every 5 min over the last hour/10 min only.

## Alert runbooks
Customer-facing steps are in `src/locales/*/accessLog.json` (`alerts.runbooks.*`). Internal triage: confirm actor → check `staff_impersonation_sessions` for the window → contact tenant owner → revoke sessions/API keys → record outcome on the alert.
