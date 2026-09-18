-- 20260928000000_agent_orchestration.sql
--
-- "AI Agent Orchestration" feature flag. When true, vapi-webhook's
-- assistant-request handler returns a Vapi Squad (Router / Scheduler /
-- Emergency / Pricing / Account specialists) instead of the single "Sarah"
-- assistant. Defaults to false so every existing tenant keeps today's
-- exact behavior until they opt in from Settings.
--
-- Same table/pattern as escalation_enabled (see
-- EscalationSettings.tsx / the migration that added that column).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS agent_orchestration_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.agent_orchestration_enabled IS
  'When true, the AI receptionist runs as a Vapi Squad of specialized agents (router/scheduler/emergency/pricing/account) instead of one general-purpose assistant. See supabase/functions/_shared/ai-core/agentOrchestration.ts.';
