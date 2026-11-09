// supabase/functions/_shared/agent-run/adapters.ts
//
// Production wiring of the executor's ports onto EXISTING Vireek building blocks — nothing here
// creates a parallel system:
//   governance  → _shared/governance/agentGovernance.ts (authorizeAgentAction / recordAgentActionOutcome)
//   escalate    → create_agent_task RPC (existing task surface) with full run context
//   tenant scope→ ONE helper through which service-role agent queries must pass

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { authorizeAgentAction, recordAgentActionOutcome } from "../governance/agentGovernance.ts";
import type { EscalationInfo, GovernancePort, RuntimeDeps } from "./executor.ts";
import { SupabaseRunStore } from "./store.ts";
import type { ToolRegistry } from "./toolRegistry.ts";

export function governancePort(admin: SupabaseClient): GovernancePort {
  return {
    authorize: (p) => authorizeAgentAction(admin, p),
    recordOutcome: (logId, outcome) => recordAgentActionOutcome(admin, logId, outcome),
  };
}

/**
 * Human task with full context, via the existing create_agent_task RPC.
 * That RPC de-duplicates open tasks per (user, target agent, type, target row), so retrying
 * an escalation never produces a second task for the same run.
 */
export function escalationPort(admin: SupabaseClient): (info: EscalationInfo) => Promise<void> {
  return async (info) => {
    const { error } = await admin.rpc("create_agent_task", {
      p_created_by_agent: info.run.agentSource,
      p_target_agent_source: "human_review",
      p_task_type: info.deadLetter ? "agent_run_dead_letter" : "agent_run_escalation",
      p_priority: info.errorClass === "policy_blocked" ? "normal" : "high",
      p_payload: {
        run_id: info.run.runId,
        correlation_id: info.run.correlationId,
        step_index: info.stepIndex,
        tool: info.tool,
        reason: info.reason.slice(0, 500),
        error_class: info.errorClass,
        dead_letter: info.deadLetter,
        context: info.context,
      },
      p_target_table: "agent_runs",
      p_target_id: info.run.runId,
      p_reasoning: `Agent run needs a human: ${info.reason}`.slice(0, 500),
      p_user_id: info.run.userId,
    });
    if (error) {
      // Never swallow silently: the run is already marked escalated/dead_letter (alerting sees it),
      // but we want the failed task creation in logs.
      console.error(JSON.stringify({ event: "agent_escalation_task_failed", run_id: info.run.runId, error: error.message }));
    }
  };
}

/** Everything the executor needs except the tool registry (callers that build tools per call use this). */
export function createRuntimeBase(admin: SupabaseClient): Omit<RuntimeDeps, "registry"> {
  const scope = tenantScope(admin);
  return {
    store: new SupabaseRunStore(admin),
    governance: governancePort(admin),
    ownsRow: (userId, table, id) => scope.ownsRow(userId, table, id),
    escalate: escalationPort(admin),
  };
}

export function createRuntimeDeps(admin: SupabaseClient, registry: ToolRegistry): RuntimeDeps {
  return { ...createRuntimeBase(admin), registry };
}

// ---------------------------------------------------------------------------
// Tenant scope — every service-role query an agent makes goes through here
// ---------------------------------------------------------------------------

/**
 * Tables an agent may touch, with the column that holds the tenant (account owner) id.
 * Anything NOT listed is refused — adding a table is an explicit, reviewed decision.
 * All listed tables were verified to carry user_id in supabase/migrations.
 */
export const AGENT_TENANT_TABLES: Readonly<Record<string, string>> = {
  jobs: "user_id",
  leads: "user_id",
  customers: "user_id",
  invoices: "user_id",
  calls: "user_id",
  followup_agent_enrollments: "user_id",
  outbound_sms: "user_id",
  agent_tasks: "user_id",
  agent_runs: "user_id",
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function tenantScope(admin: SupabaseClient, tables: Readonly<Record<string, string>> = AGENT_TENANT_TABLES) {
  const col = (table: string): string => {
    const c = tables[table];
    if (!c) throw new Error(`tenantScope: table "${table}" is not allow-listed for agent access`);
    return c;
  };
  return {
    /** Read rows of ONE tenant. The tenant filter cannot be forgotten or overridden by caller code. */
    select(userId: string, table: string, columns: string) {
      if (!userId) throw new Error("tenantScope: userId required");
      return admin.from(table).select(columns).eq(col(table), userId);
    },
    /** Update restricted to the tenant's rows. Caller must still add a row filter (.eq("id", …)). */
    update(userId: string, table: string, patch: Record<string, unknown>) {
      if (!userId) throw new Error("tenantScope: userId required");
      if (col(table) in patch) throw new Error("tenantScope: cannot rewrite the tenant column");
      return admin.from(table).update(patch).eq(col(table), userId);
    },
    /** True only when row `id` exists AND belongs to `userId` (defeats hostile ids from model output). */
    async ownsRow(userId: string, table: string, id: string): Promise<boolean> {
      if (!userId || !ID_RE.test(id)) return false;
      const c = tables[table];
      if (!c) return false;
      const { data, error } = await admin.from(table).select("id").eq("id", id).eq(c, userId).limit(1);
      if (error) return false; // fail closed
      return Array.isArray(data) && data.length > 0;
    },
  };
}
