// scripts/security/rls-baseline.test.mjs
//
// Guards the RLS ratchet itself: docs/security/rls-baseline.json must exist, be well-formed and stay consistent
// with the generated pgTAP exemptions. If someone deletes or corrupts the baseline, CI must fail loudly instead of
// the gate silently treating "no baseline" as "no findings".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_FILE, BASELINE_RULES, baselineFromFindings, countByRule, gateRls, readBaseline, validateBaseline,
} from "./rls-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const committed = path.join(ROOT, BASELINE_FILE);
const tmpDirs = [];
const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rls-baseline-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "rls-baseline.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const good = { version: 1, findings: [{ table: "a", rule: "policy-true" }, { table: "b", rule: "rls-no-policy" }] };

describe("committed baseline", () => {
  it("exists in the repository (the ratchet cannot run without it)", () => {
    expect(fs.existsSync(committed)).toBe(true);
  });
  it("is valid JSON and passes validateBaseline", () => {
    const parsed = JSON.parse(fs.readFileSync(committed, "utf8"));
    expect(validateBaseline(parsed)).toEqual([]);
    expect(() => readBaseline(committed)).not.toThrow();
  });
  it("never freezes a table that has no RLS at all", () => {
    const { findings } = readBaseline(committed);
    expect(findings.filter((f) => f.rule === "no-rls")).toEqual([]);
  });
  it("is consistent with the generated pgTAP: every frozen service-role-only table is listed there", () => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase/tests/database/rls_catalog.test.sql"), "utf8");
    const { findings } = readBaseline(committed);
    const missing = findings.filter((f) => f.rule === "rls-no-policy" && !sql.includes(`'${f.table}'`)).map((f) => f.table);
    expect(missing).toEqual([]);
  });
});

describe("validateBaseline", () => {
  it("accepts a well-formed baseline, including an empty (fully fixed) one", () => {
    expect(validateBaseline(good)).toEqual([]);
    expect(validateBaseline({ version: 1, findings: [] })).toEqual([]);
  });
  it.each([
    ["null", null], ["array", []], ["string", "x"], ["number", 1],
  ])("rejects a non-object root (%s)", (_n, v) => {
    expect(validateBaseline(v).join("\n")).toMatch(/JSON object/);
  });
  it("rejects a wrong or missing version", () => {
    expect(validateBaseline({ findings: [] }).join("\n")).toMatch(/version/);
    expect(validateBaseline({ version: 2, findings: [] }).join("\n")).toMatch(/version/);
  });
  it("rejects findings that are not an array", () => {
    expect(validateBaseline({ version: 1 }).join("\n")).toMatch(/findings must be an array/);
    expect(validateBaseline({ version: 1, findings: {} }).join("\n")).toMatch(/findings must be an array/);
  });
  it("rejects malformed entries, unknown rules and duplicates", () => {
    expect(validateBaseline({ version: 1, findings: [null] }).join("\n")).toMatch(/must be an object/);
    expect(validateBaseline({ version: 1, findings: [{ rule: "policy-true" }] }).join("\n")).toMatch(/table/);
    expect(validateBaseline({ version: 1, findings: [{ table: " ", rule: "policy-true" }] }).join("\n")).toMatch(/table/);
    expect(validateBaseline({ version: 1, findings: [{ table: "a", rule: "typo-rule" }] }).join("\n")).toMatch(/not a known rule/);
    expect(validateBaseline({ version: 1, findings: [good.findings[0], good.findings[0]] }).join("\n")).toMatch(/duplicates/);
  });
  it("knows every rule the linter can emit", () => {
    expect([...BASELINE_RULES].sort()).toEqual([
      "anon-write-policy", "no-rls", "policy-column-unindexed", "policy-true", "policy-unwrapped-auth", "rls-no-policy",
    ]);
  });
});

describe("readBaseline", () => {
  it("throws, naming the restore/bootstrap command, when the file is missing", () => {
    expect(() => readBaseline(tmpFile())).toThrow(/is missing/);
    expect(() => readBaseline(tmpFile())).toThrow(/--update-baseline/);
  });
  it("throws on invalid JSON", () => {
    expect(() => readBaseline(tmpFile("{ not json"))).toThrow(/not valid JSON/);
    expect(() => readBaseline(tmpFile(""))).toThrow(/not valid JSON/);
  });
  it("throws on structurally invalid content", () => {
    expect(() => readBaseline(tmpFile(JSON.stringify({ version: 1, findings: "nope" })))).toThrow(/malformed/);
    expect(() => readBaseline(tmpFile(JSON.stringify({ version: 1, findings: [{ table: "a", rule: "x" }] })))).toThrow(/malformed/);
  });
  it("returns the parsed baseline when valid", () => {
    expect(readBaseline(tmpFile(JSON.stringify(good)))).toEqual(good);
  });
});

describe("ratchet behaviour", () => {
  const f = (table, rule, detail = "d") => ({ table, rule, detail });
  it("baselineFromFindings de-duplicates and sorts by table then rule", () => {
    const out = baselineFromFindings([f("b", "policy-true"), f("a", "policy-unwrapped-auth"), f("a", "policy-unwrapped-auth"), f("a", "policy-true")]);
    expect(out).toEqual([
      { table: "a", rule: "policy-true" }, { table: "a", rule: "policy-unwrapped-auth" }, { table: "b", rule: "policy-true" },
    ]);
  });
  it("countByRule counts unique table+rule pairs per rule", () => {
    expect(countByRule(baselineFromFindings([f("a", "policy-true"), f("b", "policy-true"), f("a", "rls-no-policy")]))).toEqual({
      "policy-true": 2, "rls-no-policy": 1,
    });
  });
  it("gate rejects a NEW finding that is not in the baseline, even when everything else is frozen", () => {
    const frozen = { version: 1, findings: [{ table: "a", rule: "policy-true" }] };
    expect(gateRls([f("a", "policy-true"), f("new_t", "no-rls")], frozen).join("\n")).toMatch(/new_t: no-rls/);
  });
  it("gate demands shrinkage when a frozen finding disappears", () => {
    expect(gateRls([], { version: 1, findings: [{ table: "a", rule: "policy-true" }] }).join("\n")).toMatch(/is fixed/);
  });
  it("an empty baseline is NOT a free pass: every finding fails", () => {
    expect(gateRls([f("a", "policy-true")], { version: 1, findings: [] })).toHaveLength(1);
  });
});
