// @vitest-environment node
// OpenAPI contract tests: the published spec, the contract and index.ts must agree, and nothing a
// client may rely on can disappear without a major version bump.
// Update the baseline deliberately:  BASELINE_UPDATE=1 npx vitest run api-v1/contract
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  API_VERSION, ERROR_CATALOG, buildOpenApiSpec, checkEdgeFunctionSource, serializeSpec, validateSpec,
} from "./contract.ts";

const read = (u: URL) => readFileSync(u, "utf8");
const BASELINE = new URL("./__golden__/openapi-baseline.json", import.meta.url);

function surface(spec: ReturnType<typeof buildOpenApiSpec>) {
  const operations = Object.entries(spec.paths).flatMap(([p, item]) =>
    Object.entries(item as Record<string, { parameters?: { name?: string; $ref?: string }[]; responses?: Record<string, unknown> }>)
      .map(([m, op]) => ({
        op: `${m.toUpperCase()} ${p}`,
        params: (op.parameters ?? []).map((x) => x.name ?? x.$ref ?? "?").sort(),
        responses: Object.keys(op.responses ?? {}).sort(),
      })));
  const schemas = Object.fromEntries(
    Object.entries(spec.components?.schemas ?? {}).map(([k, v]) => [k, Object.keys((v as { properties?: object }).properties ?? {}).sort()]),
  );
  return { version: API_VERSION, operations, schemas, errorCodes: ERROR_CATALOG.map((e) => e.code).sort() };
}

describe("api-v1 contract", () => {
  const spec = buildOpenApiSpec();

  it("spec is internally valid", () => expect(validateSpec(spec)).toEqual([]));
  it("index.ts obeys the contract (routing, errors, allowlist, sandbox)", () =>
    expect(checkEdgeFunctionSource(read(new URL("./index.ts", import.meta.url)))).toEqual([]));
  it("index.ts defines fail() used by every error path", () =>
    expect(/function fail\(/.test(read(new URL("./index.ts", import.meta.url)))).toBe(true));
  it("public/openapi.json is exactly what the contract generates", () =>
    expect(read(new URL("../../../public/openapi.json", import.meta.url)).trim()).toBe(serializeSpec(buildOpenApiSpec(JSON.parse(read(new URL("../../../public/openapi.json", import.meta.url))).servers[0].url)).trim()));
  it("error catalog codes are unique with valid statuses", () => {
    const codes = ERROR_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of ERROR_CATALOG) { expect(e.status).toBeGreaterThanOrEqual(400); expect(e.status).toBeLessThanOrEqual(599); }
  });
  it("API is read-only (so no money/contact write needs an idempotency key here)", () =>
    expect(Object.values(spec.paths).every((p) => Object.keys(p as object).every((m) => m === "get"))).toBe(true));

  it("no breaking change against the baseline without a major version bump", () => {
    const now = surface(spec);
    if (process.env.BASELINE_UPDATE === "1") { writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n"); return; }
    const base = JSON.parse(read(BASELINE)) as ReturnType<typeof surface>;
    if (Number(now.version.split(".")[0]) > Number(base.version.split(".")[0])) return; // major bump = intentional break
    const problems: string[] = [];
    for (const b of base.operations) {
      const c = now.operations.find((o) => o.op === b.op);
      if (!c) { problems.push(`removed operation ${b.op}`); continue; }
      for (const p of b.params) if (!c.params.includes(p)) problems.push(`${b.op}: removed parameter ${p}`);
      for (const r of b.responses) if (!c.responses.includes(r)) problems.push(`${b.op}: removed response ${r}`);
    }
    for (const [k, props] of Object.entries(base.schemas)) {
      if (!(k in now.schemas)) { problems.push(`removed schema ${k}`); continue; }
      for (const p of props) if (!now.schemas[k].includes(p)) problems.push(`${k}: removed property ${p}`);
    }
    for (const c of base.errorCodes) if (!now.errorCodes.includes(c)) problems.push(`removed error code ${c}`);
    expect(problems).toEqual([]);
  });
});
