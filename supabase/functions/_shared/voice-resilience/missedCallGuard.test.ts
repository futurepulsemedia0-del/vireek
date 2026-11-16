import { describe, expect, it } from "vitest";
import { ensureMissedCallRecord, type MissedCallPorts, type MissedCallRow } from "./missedCallGuard.ts";

const OWNER = "22222222-2222-2222-2222-222222222222";

function ports(over: Partial<{ failInsert: number; alertResult: boolean; alertThrows: boolean }> = {}) {
  const rows = new Map<string, MissedCallRow>();
  const alerts: string[] = [];
  let insertCalls = 0;
  const p: MissedCallPorts = {
    async insertCallIfAbsent(row) {
      insertCalls++;
      if (insertCalls <= (over.failInsert ?? 0)) throw new Error("db down");
      if (!rows.has(row.vapi_call_id)) rows.set(row.vapi_call_id, row); // insert-if-absent
    },
    async alertOwner(_o, title, body) {
      if (over.alertThrows) throw new Error("sms down");
      alerts.push(`${title}|${body}`);
      return over.alertResult ?? true;
    },
  };
  return { p, rows, alerts, get insertCalls() { return insertCalls; } };
}

describe("ensureMissedCallRecord", () => {
  it("creates exactly one lead row and alerts the owner", async () => {
    const h = ports();
    const r = await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "CA1", callerPhone: "+15550001111", reason: "engine_unavailable" });
    expect(r).toEqual({ recorded: true, alerted: true });
    expect(h.rows.size).toBe(1);
    expect(h.rows.get("twilio:CA1")?.status).toBe("new_lead");
    expect(h.alerts.length).toBe(1);
  });

  it("is idempotent: a Twilio retry for the same CallSid does not create a second row", async () => {
    const h = ports();
    await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "CA2", callerPhone: null, reason: "engine_no_answer" });
    await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "CA2", callerPhone: null, reason: "engine_no_answer" });
    expect(h.rows.size).toBe(1);
  });

  it("retries once on a transient DB failure and still records", async () => {
    const h = ports({ failInsert: 1 });
    const r = await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "CA3", callerPhone: null, reason: "level_forced" });
    expect(r.recorded).toBe(true);
    expect(h.insertCalls).toBe(2);
  });

  it("never throws: persistent DB failure and alert failure are reported, not raised", async () => {
    const h = ports({ failInsert: 99, alertThrows: true });
    const r = await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "CA4", callerPhone: null, reason: "forward_failed" });
    expect(r).toEqual({ recorded: false, alerted: false });
  });

  it("does nothing without a CallSid or owner (no junk rows)", async () => {
    const h = ports();
    expect(await ensureMissedCallRecord(h.p, { ownerId: OWNER, callSid: "", callerPhone: null, reason: "engine_unavailable" })).toEqual({ recorded: false, alerted: false });
    expect(h.rows.size).toBe(0);
  });
});
