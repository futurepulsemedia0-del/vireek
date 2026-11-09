# Runbook — Agent run runtime

Alerts: `agent_stuck_runs`, `agent_dead_letter_rate`, `agent_breaker_open`, `agent_stale_approvals`
(rules in `supabase/functions/_shared/observability/alertRules.ts`, metrics from `obs_agent_metrics`).

## Stuck runs (`agent_stuck_runs`)
1. `SELECT id, agent_source, trigger_ref, heartbeat_at FROM agent_runs WHERE status='running' AND heartbeat_at < now() - interval '15 min';`
2. Look at the steps: `SELECT step_index, tool, status, attempt_count, maybe_executed, error FROM agent_run_steps WHERE run_id = '<id>' ORDER BY step_index;`
3. `in_flight` older than 2 minutes is normal after a crash: the next cron tick reconciles it (verify → recovered, or re-execute with the same idempotency key). If it keeps reappearing, the agent's cron is not running.
4. `needs_human` with `maybe_executed = true` means the effect might have happened and could not be proven. Check the provider (Twilio/Vapi console) BEFORE re-sending; then close the escalated task.

## Dead letters / escalations (`agent_dead_letter_rate`)
Open the human task (`agent_tasks`, target `agent_runs`) — `error_class` says why: `permanent`/`ambiguous_input` (needs a decision), `transient` after max attempts (provider unhealthy), `policy_blocked` (governance/budget).

## Circuit breaker open (`agent_breaker_open`)
Provider incident. Runs park and retry with backoff automatically; nothing is sent while open. After the cooldown one probe is allowed. Manual reset: `UPDATE agent_circuit_breakers SET state='closed', consecutive_failures=0, open_until=NULL WHERE provider='<p>';`

## Stale approvals (`agent_stale_approvals`)
Approvals older than 24h are refused on purpose (facts may be outdated). Reject/re-plan them in Agent Governance.

## Kill switch
Per tenant: `UPDATE agent_runtime_flags SET enabled=false WHERE user_id='<tenant>' AND agent_source='<agent>';`
Global: set function secret `AGENT_RUNTIME_DISABLED=1` (all agents fall back to their legacy path).
