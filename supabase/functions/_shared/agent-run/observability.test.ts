// supabase/functions/_shared/agent-run/observability.test.ts
// Contract tests: agent alert rules ⇄ obs_agent_metrics SQL ⇄ runbook.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_RUNTIME_RULES, DEFAULT_RULES } from "../observability/alertRules.ts";

const sql = readFileSync(new URL("../../../migrations/20281116000200_agent_runtime_observability.sql", import.meta.url), "utf8");

describe("agent runtime alert rules", () => {
  it("are appended to DEFAULT_RULES, keys unique across all rules", () => {
    const keys = DEFAULT_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of AGENT_RUNTIME_RULES) expect(keys).toContain(r.key);
  });
  it("every rule's metric is emitted by obs_agent_metrics", () => {
    for (const r of AGENT_RUNTIME_RULES) expect(sql, r.metric).toContain(`'${r.metric}'`);
  });
  it("hysteresis is sane: recovery threshold is at least as strict as the trigger", () => {
    for (const r of AGENT_RUNTIME_RULES) {
      if (r.comparator === "gt") expect(r.recoveryThreshold).toBeLessThanOrEqual(r.threshold);
      else expect(r.recoveryThreshold).toBeGreaterThanOrEqual(r.threshold);
    }
  });
  it("breaker rule is per provider and pages at SEV2; runbook file exists", () => {
    const b = AGENT_RUNTIME_RULES.find((r) => r.metric === "agent_breaker_open")!;
    expect(b.scope).toBe("provider");
    expect(b.severity).toBe("SEV2");
    for (const r of AGENT_RUNTIME_RULES) expect(existsSync(new URL(`../../../../${r.runbook}`, import.meta.url)), r.runbook).toBe(true);
  });
  it("metrics RPC is service_role only", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.obs_agent_metrics(integer) FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.obs_agent_metrics(integer) TO service_role");
  });
});
