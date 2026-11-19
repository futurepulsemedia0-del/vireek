import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureImport, findViolations, rewriteLine, rewriteSource } from "./secret-compare.mjs";

const FILE = path.resolve("supabase/functions/demo/index.ts");

describe("findViolations", () => {
  it("flags header/secret comparisons in both operand orders", () => {
    expect(findViolations('if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {').length).toBe(1);
    expect(findViolations('if (!secret || req.headers.get("x-pbx-tick-secret") !== secret) return x;').length).toBe(1);
    expect(findViolations('const ok = cronSecret === req.headers.get("x-cron-secret");').length).toBe(1);
    expect(findViolations('const ok = token === Deno.env.get("WEBHOOK_TOKEN");').length).toBe(1);
  });
  it("flags plain HMAC comparisons as report-only", () => {
    const v = findViolations("return expected === signature;");
    expect(v.length).toBe(1);
    expect(v[0].fixable).toBe(false);
  });
  it("ignores comments, helper calls and the explicit escape hatch", () => {
    expect(findViolations('// if (req.headers.get("x-cron-secret") !== cronSecret)').length).toBe(0);
    expect(findViolations('/* req.headers.get("x-cron-secret") !== cronSecret */').length).toBe(0);
    expect(findViolations('if (!checkSharedSecret(s, req.headers.get("x-cron-secret"))) return;').length).toBe(0);
    expect(findViolations('if (req.headers.get("x-token") !== tokenA) {} // timing-safe-ok: not a secret').length).toBe(0);
  });
  it("does not flag unrelated comparisons", () => {
    expect(findViolations('if (req.method !== "POST") return;').length).toBe(0);
    expect(findViolations('if (req.headers.get("content-type") === type) {}').length).toBe(0);
    expect(findViolations("if (a === b) {}").length).toBe(0);
  });
});

describe("rewriteLine", () => {
  it("rewrites !== and === keeping surrounding guards and trailing comments", () => {
    expect(rewriteLine('if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {'))
      .toBe('if (cronSecret && !checkSharedSecret(cronSecret, req.headers.get("X-Cron-Secret"))) {');
    expect(rewriteLine('const isCron = !!cronSecret && req.headers.get("X-Cron-Secret") === cronSecret; // cron'))
      .toBe('const isCron = !!cronSecret && checkSharedSecret(cronSecret, req.headers.get("X-Cron-Secret")); // cron');
    expect(rewriteLine('const ok = token === Deno.env.get("WEBHOOK_TOKEN");'))
      .toBe('const ok = checkSharedSecret(Deno.env.get("WEBHOOK_TOKEN"), token);');
  });
  it("is idempotent", () => {
    const once = rewriteLine('if (!secret || req.headers.get("x-a-secret") !== secret) return;');
    expect(rewriteLine(once)).toBe(once);
  });
});

describe("ensureImport / rewriteSource", () => {
  it("adds a relative import before the first import", () => {
    const out = ensureImport('import a from "x";\nconst y = 1;', FILE);
    expect(out.startsWith('import { checkSharedSecret } from "../_shared/http/core.ts";\nimport a')).toBe(true);
  });
  it("merges into an existing core.ts import", () => {
    const out = ensureImport('import { json } from "../_shared/http/core.ts";\n', FILE);
    expect(out).toContain('import { json, checkSharedSecret } from "../_shared/http/core.ts";');
  });
  it("does not duplicate an existing import", () => {
    const src = 'import { checkSharedSecret } from "../_shared/http/core.ts";\n';
    expect(ensureImport(src, FILE)).toBe(src);
  });
  it("rewrites a whole file and a second pass changes nothing", () => {
    const src = 'import a from "x";\nif (req.headers.get("X-Cron-Secret") !== cronSecret) return 1;\n';
    const r = rewriteSource(src, FILE);
    expect(r.changed).toBe(1);
    expect(r.source).toContain("!checkSharedSecret(cronSecret, req.headers.get(\"X-Cron-Secret\"))");
    expect(rewriteSource(r.source, FILE).changed).toBe(0);
    expect(findViolations(r.source).length).toBe(0);
  });
});

describe("checkSharedSecret semantics (mirrors _shared/http/core.ts)", () => {
  // Same algorithm as constantTimeEqual + fail-closed guard, to pin the behaviour the rewrite relies on.
  const eq = (a, b) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; };
  const check = (expected, provided) => !(!expected || !provided) && eq(provided, expected);
  it("equal, unequal, different length, missing", () => {
    expect(check("s3cret", "s3cret")).toBe(true);
    expect(check("s3cret", "s3creT")).toBe(false);
    expect(check("s3cret", "s3cret-long")).toBe(false);
    expect(check("s3cret", "s3c")).toBe(false);
    expect(check("", "")).toBe(false);
    expect(check("s3cret", null)).toBe(false);
    expect(check(undefined, "x")).toBe(false);
  });
});
