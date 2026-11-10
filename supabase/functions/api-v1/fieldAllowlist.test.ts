// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RESOURCES, selectColumns } from "./contract.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

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
  it("applies the per-key rate limit", () => {
    expect(source).toMatch(/rate_limit_per_minute/);
    expect(source).toMatch(/p_limit:\s*ctx\.rateLimit/);
  });
});
