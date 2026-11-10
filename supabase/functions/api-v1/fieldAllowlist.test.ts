// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RESOURCES, parseListQuery, selectColumns, usesListExtensions } from "./contract.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const UUID = "3f2b1c52-4c3b-4a8e-9d3a-2f6e0b9a1c11";
const q = (qs: string, resource = "jobs") => parseListQuery(resource, new URLSearchParams(qs));

describe("api-v1 field-level allowlist", () => {
  it("selects exactly the documented fields of each resource", () => {
    for (const r of RESOURCES) expect(selectColumns(r.name).split(",")).toEqual(r.fields.map((f) => f.name));
  });
  it("returns an empty list for unknown resources", () => {
    expect(selectColumns("customers")).toBe("");
  });
  it("index.ts never uses select('*') and uses selectColumns()", () => {
    expect(source).not.toMatch(/\.select\(\s*["']\*["']\s*\)/);
    expect(source).toMatch(/\bselectColumns\(/);
  });
  it("index.ts declares fail() exactly once", () => {
    expect((source.match(/^function fail\(/gm) ?? []).length).toBe(1);
  });
});

describe("api-v1 per-key rate limit", () => {
  it("reads the key's limit and passes it to the limiter and the header", () => {
    expect(source).toMatch(/rate_limit_per_minute/);
    expect(source).toMatch(/p_limit:\s*ctx\.rateLimit/);
    expect(source).toMatch(/X-RateLimit-Limit",\s*String\(ctx\.rateLimit\)/);
  });
});

describe("api-v1 filters and sparse fieldsets (public_api_v2)", () => {
  it("is a no-op without filter or fields parameters", () => {
    expect(usesListExtensions("jobs", new URLSearchParams("limit=5&before=2026-01-01T00:00:00Z"))).toBe(false);
    expect(q("")).toEqual({ ok: true, filters: [], columns: selectColumns("jobs") });
  });
  it("accepts valid filters", () => {
    expect(q(`customer_id=${UUID}&job_status=completed`)).toMatchObject({ ok: true, filters: [{ column: "job_status", value: "completed" }, { column: "customer_id", value: UUID }] });
    expect(q("is_emergency=true", "calls")).toMatchObject({ ok: true, filters: [{ column: "is_emergency", value: true }] });
  });
  it("rejects malformed, repeated and injection-shaped values", () => {
    expect(q("customer_id=nope").ok).toBe(false);
    expect(q("is_emergency=yes", "calls").ok).toBe(false);
    expect(q("job_status=a&job_status=b").ok).toBe(false);
    expect(q("job_status=x'%3Bdrop%20table").ok).toBe(false);
    expect(q("job_status=" + "a".repeat(65)).ok).toBe(false);
  });
  it("ignores filters that do not belong to the resource", () => {
    expect(q("status=open", "leads")).toMatchObject({ ok: true, filters: [] });
  });
  it("sparse fieldsets only allow documented fields and always keep id + created_at", () => {
    expect(q("fields=customer_name,id")).toMatchObject({ ok: true, columns: "id,created_at,customer_name" });
    expect(q("fields=password").ok).toBe(false);
    expect(q("fields=").ok).toBe(false);
    expect(q("fields=a&fields=b").ok).toBe(false);
  });
  it("index.ts only applies them behind the entitlement RPC and fails closed", () => {
    expect(source).toMatch(/public_api_v2_enabled/);
    expect(source).toMatch(/v2 === true/);
  });
});
