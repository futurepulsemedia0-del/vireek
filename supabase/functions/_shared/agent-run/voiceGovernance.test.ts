// supabase/functions/_shared/agent-run/voiceGovernance.test.ts
import { describe, expect, it } from "vitest";
import { governVoiceTool, recordVoiceToolOutcome, VOICE_TOOL_GOVERNANCE } from "./voiceGovernance.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
function admin(rpc: Rpc) { return { rpc } as never; }
const decision = (d: string) => async (name: string) =>
  name === "evaluate_agent_action" ? { data: { decision: d, log_id: "log-1", existing: false }, error: null } : { data: null, error: null };

const base = { tenantId: "t1", vapiCallId: "call_abc", log: () => {} };

describe("voice tool governance", () => {
  it("default policy: auto-approved → call proceeds, audit row id returned", async () => {
    const calls: string[] = [];
    const a = admin(async (n, args) => { calls.push(`${n}:${args.p_action_slug ?? ""}:${args.p_target_id ?? ""}`); return decision("auto_approved")(n); });
    expect(await governVoiceTool(a, { ...base, tool: "book_appointment" })).toEqual({ allow: true, logId: "log-1" });
    expect(calls).toEqual(["evaluate_agent_action:voice_book_appointment:call_abc"]);
  });

  it("tools that are not side-effecting are untouched (no RPC, zero added latency)", async () => {
    let n = 0;
    const a = admin(async () => { n += 1; return { data: null, error: null }; });
    expect(await governVoiceTool(a, { ...base, tool: "check_availability" })).toEqual({ allow: true, logId: null });
    expect(n).toBe(0);
  });

  it("tenant tightened policy: pending/rejected payment → spoken fallback, tool must not run", async () => {
    for (const d of ["pending_approval", "rejected"]) {
      const r = await governVoiceTool(admin(decision(d)), { ...base, tool: "collect_card_payment" });
      expect(r.allow).toBe(false);
      if (!r.allow) expect(r.spoken).toContain("transfer");
    }
  });

  it("governance outage: payment fails CLOSED, booking/reschedule fail OPEN, transfer always allowed", async () => {
    const down = admin(async () => ({ data: null, error: { message: "db down" } }));
    expect((await governVoiceTool(down, { ...base, tool: "collect_card_payment" })).allow).toBe(false);
    expect((await governVoiceTool(down, { ...base, tool: "book_appointment" })).allow).toBe(true);
    expect((await governVoiceTool(down, { ...base, tool: "reschedule_appointment" })).allow).toBe(true);
    expect((await governVoiceTool(down, { ...base, tool: "request_human_transfer" })).allow).toBe(true);
  });

  it("latency budget: a hung governance call times out instead of stalling the caller", async () => {
    const hung = admin(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await governVoiceTool(hung, { ...base, tool: "book_appointment", timeoutMs: 30 });
    expect(r.allow).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await governVoiceTool(hung, { ...base, tool: "collect_card_payment", timeoutMs: 30 })).allow).toBe(false);
  });

  it("human transfer is NEVER blocked, even if a tenant policy says pending/rejected (still logged)", async () => {
    for (const d of ["pending_approval", "rejected"]) {
      expect(await governVoiceTool(admin(decision(d)), { ...base, tool: "request_human_transfer" })).toEqual({ allow: true, logId: "log-1" });
    }
  });

  it("outcome recording never throws and reports ok/failed", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await recordVoiceToolOutcome(admin(async (_n, args) => { seen.push(args); return { data: null, error: null }; }), "log-1", true);
    await recordVoiceToolOutcome(admin(async (_n, args) => { seen.push(args); return { data: null, error: { message: "x" } }; }), "log-1", false);
    expect(seen.map((s) => s.p_status)).toEqual(["executed", "failed"]);
    await recordVoiceToolOutcome(admin(async () => { throw new Error("boom"); }), "log-1", true);
  });

  it("every governed voice slug is declared in the migration catalog", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../../migrations/20281116000000_agent_run_runtime.sql", import.meta.url), "utf8");
    for (const { slug } of Object.values(VOICE_TOOL_GOVERNANCE)) expect(sql, slug).toContain(`'${slug}'`);
  });
});
