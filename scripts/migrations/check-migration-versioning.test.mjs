// node --test scripts/migrations/check-migration-versioning.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBaseline, evaluate, formatVersion, inventoryViolations, nextVersion, parseVersion, planFutureRepair } from "./migration-versioning-lib.mjs";

const NOW = new Date("2026-11-19T12:00:00Z"); // 20261119120000
const kinds = (r) => r.violations.map((v) => `${v.kind}:${v.file}`);
const sql = (v, slug = "x") => `${v}_${slug}.sql`;

describe("versions", () => {
  it("parses/formats and rejects impossible dates", () => {
    assert.equal(formatVersion(NOW), "20261119120000");
    assert.ok(parseVersion("20260228235959"));
    assert.equal(parseVersion("20260230000000"), null);
    assert.equal(parseVersion("20261301000000"), null);
    assert.equal(parseVersion("2026111912000"), null);
  });
});

describe("inventoryViolations", () => {
  const nowV = formatVersion(NOW);
  it("classifies irregular names, duplicates and future-dated files", () => {
    const inv = inventoryViolations([sql("20260101000000", "a"), sql("20260101000000", "b"), "20260915_short.sql", "x.sq", "split", sql("20260101000001", "Upper"), sql("20270101000000", "f"), "README.md"], nowV);
    const got = inv.map((v) => `${v.kind}:${v.file}`);
    assert.deepEqual(got, [
      "duplicate-version:20260101000000_a.sql", "duplicate-version:20260101000000_b.sql",
      "future-dated:20270101000000_f.sql",
      "irregular-name:20260101000001_Upper.sql", "irregular-name:20260915_short.sql", "irregular-name:README.md", "irregular-name:split", "irregular-name:x.sq",
    ]);
  });
  it("a clean directory has none", () => {
    assert.deepEqual(inventoryViolations([sql("20260101000000"), sql("20260101000001")], formatVersion(NOW)), []);
  });
});

describe("evaluate (baseline = only NEW violations fail)", () => {
  const legacy = [sql("20260101000000", "a"), sql("20260101000000", "b"), "20260915_short.sql", sql("20290306000000", "future")];
  const baseline = buildBaseline(legacy, NOW);
  it("legacy state passes", () => assert.deepEqual(evaluate({ names: legacy, now: NOW, baseline }).violations, []));
  it("a new clean migration after the latest passes (frontier continues past legacy future-dated max)", () => {
    const r = evaluate({ names: [...legacy, sql("20290306000100", "new")], now: NOW, baseline });
    assert.deepEqual(r.violations, []);
  });
  it("a new migration with a REAL timestamp sorts before the legacy max => out-of-order", () => {
    const r = evaluate({ names: [...legacy, sql("20261119120500", "new")], now: NOW, baseline });
    assert.deepEqual(kinds(r), ["out-of-order:20261119120500_new.sql"]);
  });
  it("jumping more than a day past the frontier => future-jump", () => {
    const r = evaluate({ names: [...legacy, sql("20290308000000", "jump")], now: NOW, baseline });
    assert.deepEqual(kinds(r), ["future-jump:20290308000000_jump.sql"]);
  });
  it("a third file joining a baselined duplicate group fails, the old members do not", () => {
    const r = evaluate({ names: [...legacy, sql("20260101000000", "c")], now: NOW, baseline });
    assert.deepEqual(kinds(r).filter((k) => k.startsWith("duplicate")), ["duplicate-version:20260101000000_c.sql"]);
  });
  it("new irregular names fail (8-digit, typo extension, placeholder)", () => {
    const r = evaluate({ names: [...legacy, "20290307_oops.sql", "<timestamp>_x.sql", "20290306000200_ok.sq"], now: NOW, baseline });
    assert.deepEqual(kinds(r).filter((k) => k.startsWith("irregular")).length, 3);
  });
  it("reports baselined entries that no longer violate as stale (info, never a failure)", () => {
    const r = evaluate({ names: legacy.filter((n) => n !== "20260915_short.sql"), now: NOW, baseline });
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.stale, ["irregular-name:20260915_short.sql"]);
  });
  it("with baseNames (git), a file added on the branch is 'new' even if the baseline is older", () => {
    const base = [...legacy, sql("20290306000100", "merged_on_main")];
    const r = evaluate({ names: [...base, sql("20290306000050", "mine")], now: NOW, baseline, baseNames: base });
    assert.deepEqual(kinds(r), ["out-of-order:20290306000050_mine.sql"]);
  });
  it("edits/renames/deletes of existing migrations fail; --repair-pr allows rename/delete of baselined files only", () => {
    const ch = [{ status: "M", path: legacy[0] }, { status: "R100", oldPath: "20260915_short.sql", path: "20260915000000_short.sql" }, { status: "D", path: legacy[3] }];
    const r = evaluate({ names: legacy, now: NOW, baseline, changes: ch });
    assert.deepEqual(kinds(r).sort(), ["deleted-applied:20290306000000_future.sql", "edited-applied:20260101000000_a.sql", "renamed-applied:20260915_short.sql"]);
    const rp = evaluate({ names: legacy, now: NOW, baseline, changes: ch, repairPr: true });
    assert.deepEqual(kinds(rp), ["edited-applied:20260101000000_a.sql"]);
  });
});

describe("nextVersion", () => {
  it("is now when everything is in the past, otherwise latest+1s", () => {
    assert.equal(nextVersion([sql("20260101000000")], NOW), "20261119120000");
    assert.equal(nextVersion([sql("20290306000000")], NOW), "20290306000001");
    assert.equal(nextVersion([], NOW), "20261119120000");
  });
});

describe("planFutureRepair", () => {
  it("compresses future-dated versions after the last real one, order preserved", () => {
    const p = planFutureRepair([sql("20260101000000", "a"), sql("20270101000000", "f1"), sql("20280101000000", "f2")], NOW);
    assert.deepEqual(p.renames.map((r) => r.newName), ["20260101000001_f1.sql", "20260101000002_f2.sql"]);
  });
  it("refuses when duplicates exist or there is no room", () => {
    assert.match(planFutureRepair([sql("20270101000000", "a"), sql("20270101000000", "b")], NOW).error, /Duplicate/);
    assert.match(planFutureRepair([sql("20261119115959", "a"), sql("20270101000000", "f1"), sql("20270101000001", "f2")], NOW).error, /room/);
  });
});

describe("CLI (real git repo)", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-migration-versioning.mjs");
  const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const node = (cwd, ...args) => sh(cwd, process.execPath, [cli, ...args, "--now", NOW.toISOString()]);
  const fresh = () => {
    const d = mkdtempSync(path.join(tmpdir(), "mig-"));
    mkdirSync(path.join(d, "supabase/migrations"), { recursive: true });
    for (const n of [sql("20260101000000", "a"), sql("20260101000000", "b"), sql("20260102000000", "c")]) writeFileSync(path.join(d, "supabase/migrations", n), "select 1;\n");
    mkdirSync(path.join(d, "scripts/migrations"), { recursive: true });
    sh(d, "git", ["init", "-q", "-b", "main"]);
    sh(d, "git", ["config", "user.email", "t@t"]); sh(d, "git", ["config", "user.name", "t"]);
    assert.equal(node(d, "baseline", "--write").status, 0);
    sh(d, "git", ["add", "-A"]); sh(d, "git", ["commit", "-qm", "base"]);
    return d;
  };
  it("passes on the baselined state; fails on a new duplicate; passes again after fixing it", () => {
    const d = fresh();
    try {
      assert.equal(node(d, "check", "--base", "HEAD").status, 0);
      writeFileSync(path.join(d, "supabase/migrations", sql("20260102000000", "dup")), "select 1;\n");
      const bad = node(d, "check", "--base", "HEAD");
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /\[duplicate-version\].*dup/);
      renameSync(path.join(d, "supabase/migrations", sql("20260102000000", "dup")), path.join(d, "supabase/migrations", sql("20260102000001", "dup")));
      assert.equal(node(d, "check", "--base", "HEAD").status, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("fails when an applied migration is edited or renamed (git-aware)", () => {
    const d = fresh();
    try {
      writeFileSync(path.join(d, "supabase/migrations", sql("20260102000000", "c")), "select 2;\n");
      assert.match(node(d, "check", "--base", "HEAD").stderr, /\[edited-applied\]/);
      sh(d, "git", ["checkout", "--", "."]);
      sh(d, "git", ["mv", `supabase/migrations/${sql("20260102000000", "c")}`, `supabase/migrations/${sql("20260102000009", "c")}`]);
      assert.match(node(d, "check", "--base", "HEAD").stderr, /\[renamed-applied\]/);
      assert.equal(node(d, "check", "--base", "HEAD", "--repair-pr").status, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("exit code 2 for a bad git ref and for a missing baseline; `next` and `repair-plan` never modify files", () => {
    const d = fresh();
    try {
      assert.equal(node(d, "check", "--base", "no-such-ref").status, 2);
      assert.equal(node(d, "check", "--baseline", "nope.json").status, 2);
      assert.match(node(d, "next").stdout, /^20261119120000/);
      writeFileSync(path.join(d, "supabase/migrations", sql("20280101000000", "f")), "select 1;\n");
      assert.equal(node(d, "repair-plan").status, 1); // fixture has a duplicate version: must be resolved first
      renameSync(path.join(d, "supabase/migrations", sql("20260101000000", "b")), path.join(d, "supabase/migrations", sql("20260101000500", "b")));
      const plan = node(d, "repair-plan");
      assert.equal(plan.status, 0);
      assert.match(plan.stdout, /git mv .*20280101000000_f\.sql .*20260102000001_f\.sql/);
      assert.match(plan.stdout, /supabase migration repair --status reverted 20280101000000/);
      assert.match(plan.stdout, /supabase migration repair --status applied 20260102000001/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
