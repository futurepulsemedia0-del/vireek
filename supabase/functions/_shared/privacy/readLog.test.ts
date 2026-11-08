import { describe, expect, it, vi } from "vitest";
import {
  API_TABLE_ASSETS, ReadLogError, apiReadEntries, buildReadLogArgs, logSensitiveRead, readGateStatus,
  type ReadLogEntry, type RpcCaller,
} from "./readLog";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const K = "bbbbbbbb-0000-0000-0000-000000000002";
const base: ReadLogEntry = { accountId: A, actorKind: "api_key", apiKeyId: K, assetClass: "transcript", action: "api_read", channel: "api" };

describe("buildReadLogArgs", () => {
  it("accepts a minimal valid entry", () => {
    expect(buildReadLogArgs(base)).toMatchObject({ p_account_id: A, p_record_count: 1, p_purpose: "service_delivery" });
  });
  it("rejects free-text target ids (PII cannot ride in target_id)", () => {
    for (const bad of ["+49 170 1234567", "jane@example.com", "John Smith", "123"]) {
      expect(() => buildReadLogArgs({ ...base, targetId: bad })).toThrow(ReadLogError);
    }
  });
  it("rejects bad uuids, unknown classes/actions and absurd counts", () => {
    expect(() => buildReadLogArgs({ ...base, accountId: "nope" })).toThrow(ReadLogError);
    expect(() => buildReadLogArgs({ ...base, assetClass: "secrets" as never })).toThrow(ReadLogError);
    expect(() => buildReadLogArgs({ ...base, action: "peek" as never })).toThrow(ReadLogError);
    expect(() => buildReadLogArgs({ ...base, recordCount: 0 })).toThrow(ReadLogError);
    expect(() => buildReadLogArgs({ ...base, recordCount: 1.5 })).toThrow(ReadLogError);
    expect(() => buildReadLogArgs({ ...base, targetTable: "calls; drop table x" })).toThrow(ReadLogError);
  });
  it("produces only enumerated, id-shaped fields (no content keys)", () => {
    const keys = Object.keys(buildReadLogArgs({ ...base, targetId: K, targetTable: "calls" }));
    expect(keys.sort()).toEqual([
      "p_account_id", "p_action", "p_actor_id", "p_actor_kind", "p_api_key_id", "p_asset_class", "p_channel",
      "p_purpose", "p_record_count", "p_request_id", "p_target_id", "p_target_table",
    ].sort());
  });
});

describe("logSensitiveRead (fail closed)", () => {
  it("calls the trusted RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "x", error: null });
    await logSensitiveRead({ rpc } as RpcCaller, base);
    expect(rpc).toHaveBeenCalledWith("log_sensitive_read", expect.objectContaining({ p_asset_class: "transcript" }));
  });
  it("throws when the log write fails so the caller withholds data", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(logSensitiveRead({ rpc } as RpcCaller, base)).rejects.toThrow("read log unavailable");
  });
  it("throws before any RPC on invalid input", async () => {
    const rpc = vi.fn();
    await expect(logSensitiveRead({ rpc } as unknown as RpcCaller, { ...base, targetId: "jane@x.com" })).rejects.toThrow(ReadLogError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("apiReadEntries completeness for every public API resource", () => {
  it("calls => recording + transcript; leads/jobs => customer_pii", () => {
    expect(apiReadEntries({ accountId: A, apiKeyId: K, table: "calls", recordId: null, returned: 50 }).map((e) => e.assetClass)).toEqual(["call_recording", "transcript"]);
    expect(apiReadEntries({ accountId: A, apiKeyId: K, table: "leads", recordId: null, returned: 3 }).map((e) => e.assetClass)).toEqual(["customer_pii"]);
    expect(apiReadEntries({ accountId: A, apiKeyId: K, table: "jobs", recordId: A, returned: 1 })[0]?.recordCount).toBe(1);
  });
  it("aggregates a list into one row per class with record_count (no per-record rows)", () => {
    const rows = apiReadEntries({ accountId: A, apiKeyId: K, table: "calls", recordId: null, returned: 200 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.recordCount === 200 && r.targetId === null)).toBe(true);
  });
  it("logs nothing for empty results or tables without sensitive classes", () => {
    expect(apiReadEntries({ accountId: A, apiKeyId: K, table: "calls", recordId: null, returned: 0 })).toEqual([]);
    expect(apiReadEntries({ accountId: A, apiKeyId: K, table: "quotes", recordId: null, returned: 5 })).toEqual([]);
  });
  it("registry covers exactly the tables the API contract exposes", () => {
    expect(Object.keys(API_TABLE_ASSETS).sort()).toEqual(["calls", "jobs", "leads"]);
  });
});

describe("readGateStatus", () => {
  it("maps gate codes", () => {
    expect(readGateStatus({ message: "", code: "SR401" })).toEqual({ status: 401, code: "step_up_required" });
    expect(readGateStatus({ message: "", code: "SR429" })).toEqual({ status: 429, code: "rate_limited" });
    expect(readGateStatus({ message: "", code: "42501" })?.status).toBe(403);
    expect(readGateStatus({ message: "x" })?.status).toBe(500);
    expect(readGateStatus(null)).toBeNull();
  });
});
