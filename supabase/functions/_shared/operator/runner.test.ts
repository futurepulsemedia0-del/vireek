import { describe, expect, it } from "vitest";
import { executeRun, undoRun, type MoveResult, type RunnerDeps, type RunState, type SmsResult } from "./runner.ts";
import type { Actor, EffectRow, StepRow } from "./types.ts";

const owner: Actor = { userId: "o1", ownerId: "o1", role: "owner", permissions: {} };
const tech: Actor = { userId: "t1", ownerId: "o1", role: "technician", permissions: { can_view_all_jobs: true } };
const BEFORE = (id: string) => ({ scheduled_datetime: `2026-10-27T14:00:00.000Z`, assigned_technician_id: "mike", job_status: "scheduled", id });

function makeState(gov = "approved"): RunState {
  const s1: StepRow = { id: "st1", step_key: "s1", position: 0, tool: "reschedule_jobs", title: "Reschedule", status: "planned", action_log_id: "log1", gov_status: gov, affected_count: 0, error: null, params: {} };
  const s2: StepRow = { id: "st2", step_key: "s2", position: 1, tool: "message_customers", title: "Text", status: "planned", action_log_id: "log2", gov_status: gov, affected_count: 0, error: null, params: { from_step: "s1", body: "Hi {first_name}, now {new_date} at {new_time}." } };
  const eff = (id: string, step: string, kind: EffectRow["kind"], job: string): EffectRow => ({
    id, step_id: step, kind, record_id: job, label: job,
    before: kind === "sms" ? {} : BEFORE(job),
    after: kind === "sms" ? {} : { scheduled_datetime: "2026-10-28T14:00:00.000Z" },
    status: "planned", reason: null, external_ref: null,
  });
  return {
    runId: "run1", steps: [s1, s2],
    effects: [eff("e1", "st1", "job_reschedule", "j1"), eff("e2", "st1", "job_reschedule", "j2"), eff("e3", "st2", "sms", "j1"), eff("e4", "st2", "sms", "j2")],
  };
}

function makeDeps(over: Partial<RunnerDeps> = {}) {
  const calls = { moves: [] as { id: string; patch: Record<string, unknown>; expected: Record<string, unknown> }[], sms: [] as { body: string; key: string }[], outcomes: [] as [string, string][] };
  const deps: RunnerDeps = {
    tz: "America/Chicago",
    moveJob: async (id, patch, expected): Promise<MoveResult> => {
      calls.moves.push({ id, patch, expected });
      return { status: "moved", job: { scheduled_datetime: patch.scheduled_datetime as string, assigned_technician_id: "mike" } };
    },
    loadJob: async () => ({ customer_id: "c1", customer_name: "Ana Perez", customer_phone: "+15550001111", scheduled_datetime: "2026-10-28T14:00:00.000Z" }),
    sendSms: async (_job, body, key): Promise<SmsResult> => { calls.sms.push({ body, key }); return { ok: true, deferred: false, ref: "SM1" }; },
    saveEffect: async () => {},
    saveStep: async () => {},
    recordOutcome: async (id, status) => { calls.outcomes.push([id, status]); },
    checkBudget: async () => ({ allowed: true }),
    ...over,
  };
  return { deps, calls };
}

describe("executeRun", () => {
  it("moves every job, texts every customer, and reports completed", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps();
    const r = await executeRun(state, owner, deps);
    expect(r.status).toBe("completed");
    expect(calls.moves).toHaveLength(2);
    expect(calls.sms).toHaveLength(2);
    expect(calls.sms[0].body).toBe("Hi Ana, now Wed, Oct 28 at 9:00 AM.");
    expect(calls.sms[0].key).toBe("operator:run1:e3");
    expect(calls.outcomes).toEqual([["log1", "executed"], ["log2", "executed"]]);
  });

  it("sends the preview-time snapshot as the compare-and-swap guard", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps();
    await executeRun(state, owner, deps);
    expect(calls.moves[0].expected).toEqual({ scheduled_datetime: "2026-10-27T14:00:00.000Z", assigned_technician_id: "mike", job_status: "scheduled" });
    expect(calls.moves[0].patch).toEqual({ scheduled_datetime: "2026-10-28T14:00:00.000Z" });
  });

  it("texts ONLY customers whose job really moved (partial run)", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps({
      moveJob: async (id) => (id === "j2" ? { status: "conflict", reason: "Mike is already booked then." } : { status: "moved", job: { scheduled_datetime: "2026-10-28T14:00:00.000Z" } }),
    });
    const r = await executeRun(state, owner, deps);
    expect(r.status).toBe("partial");
    expect(calls.sms).toHaveLength(1);
    expect(state.effects.find((e) => e.id === "e2")!.status).toBe("skipped");
    expect(state.effects.find((e) => e.id === "e4")!.status).toBe("skipped");
  });

  it("does nothing for a step that is not approved", async () => {
    const state = makeState("pending_approval");
    const { deps, calls } = makeDeps();
    const r = await executeRun(state, owner, deps);
    expect(calls.moves).toHaveLength(0);
    expect(calls.sms).toHaveLength(0);
    expect(calls.outcomes).toHaveLength(0);
    expect(r.status).toBe("failed");
  });

  it("PERMISSION ESCALATION: re-checks the caller at execution time", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps();
    const r = await executeRun(state, tech, deps);
    expect(calls.moves).toHaveLength(0);
    expect(calls.sms).toHaveLength(0);
    expect(r.status).toBe("failed");
    expect(state.steps[0].error).toContain("permissions");
    expect(calls.outcomes[0]).toEqual(["log1", "failed"]);
  });

  it("stops the step when move_job answers forbidden", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps({ moveJob: async () => ({ status: "forbidden", reason: "You don't have permission to move jobs." }) });
    await executeRun(state, owner, deps);
    expect(state.effects.filter((e) => e.step_id === "st1").every((e) => e.status === "skipped")).toBe(true);
    expect(calls.sms).toHaveLength(0);
  });

  it("survives a throwing move and an opted-out customer", async () => {
    const state = makeState();
    let attempts = 0;
    const { deps } = makeDeps({
      moveJob: async (id) => { attempts++; if (id === "j1") throw new Error("boom"); return { status: "moved", job: { scheduled_datetime: "2026-10-28T14:00:00.000Z" } }; },
      sendSms: async () => ({ ok: false, reason: "OPTED_OUT" }),
    });
    const r = await executeRun(state, owner, deps);
    expect(state.effects.find((e) => e.id === "e1")!.status).toBe("failed");
    expect(state.effects.find((e) => e.id === "e4")!.status).toBe("skipped");
    expect(r.status).toBe("partial");
    expect(attempts).toBe(2);
  });

  it("stops texting when A2P is not approved", async () => {
    const state = makeState();
    let sent = 0;
    const { deps } = makeDeps({ sendSms: async () => { sent++; return { ok: false, reason: "A2P_NOT_APPROVED" }; } });
    await executeRun(state, owner, deps);
    expect(sent).toBe(1);
    expect(state.effects.find((e) => e.id === "e4")!.status).toBe("skipped");
  });

  it("respects the autonomy budget", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps({ checkBudget: async () => ({ allowed: false, reason: "Action count limit reached" }) });
    const r = await executeRun(state, owner, deps);
    expect(calls.moves).toHaveLength(0);
    expect(state.steps[0].status).toBe("blocked");
    expect(r.status).toBe("failed");
  });
});

describe("undoRun", () => {
  async function ran() {
    const state = makeState();
    const { deps } = makeDeps();
    await executeRun(state, owner, deps);
    return state;
  }

  it("restores jobs with an inverse, compare-and-swap move and flags texts as irreversible", async () => {
    const state = await ran();
    const { deps, calls } = makeDeps();
    const r = await undoRun(state, owner, deps);
    expect(r).toMatchObject({ status: "undone", undone: 2, failed: 0, irreversible: 2 });
    expect(calls.moves[0].patch).toEqual({ scheduled_datetime: "2026-10-27T14:00:00.000Z" });
    expect(calls.moves[0].expected).toEqual({ scheduled_datetime: "2026-10-28T14:00:00.000Z", job_status: "scheduled" });
    expect(state.effects.filter((e) => e.kind === "sms").every((e) => e.status === "irreversible")).toBe(true);
  });

  it("never overwrites a later change: stale rows are left as they are", async () => {
    const state = await ran();
    const { deps } = makeDeps({ moveJob: async (id) => (id === "j1" ? { status: "stale" } : { status: "moved" }) });
    const r = await undoRun(state, owner, deps);
    expect(r.status).toBe("undo_partial");
    expect(state.effects.find((e) => e.id === "e1")!.status).toBe("undo_failed");
    expect(state.effects.find((e) => e.id === "e2")!.status).toBe("undone");
  });

  it("PERMISSION ESCALATION: a caller without permission cannot undo", async () => {
    const state = await ran();
    const { deps, calls } = makeDeps();
    const r = await undoRun(state, tech, deps);
    expect(calls.moves).toHaveLength(0);
    expect(r.status).toBe("undo_partial");
  });
});
