import test from "node:test";
import assert from "node:assert/strict";
import { METRICS, compare, qualityViolations, shrinkBaseline, isTest, allowed } from "./codeHealth.mjs";

const c = (metric, path, text) => METRICS[metric].count(path, text);

test("any: counts a file once, ignores comments and tests", () => {
  assert.equal(c("any_files", "src/a.ts", "const x: any = 1;\nlet y = z as any;"), 1);
  assert.equal(c("any_files", "src/a.ts", "// const x: any = 1\n const many = 1; // company"), 0);
  assert.equal(c("any_files", "src/a.ts", "const a: Array<any> = [];"), 1);
  assert.equal(METRICS.any_files.scope("src/a.test.ts"), false);
});
test("console.log/debug counted per line; warn/error/info are not", () => {
  assert.equal(c("console_log", "src/a.ts", "console.log(1);\nconsole.debug(2);\nconsole.error(3);\nconsole.info(4)"), 2);
  assert.equal(c("console_log", "src/a.ts", "// console.log(1)"), 0);
});
test("allow marker needs a reason and the right metric", () => {
  assert.equal(c("console_log", "a.ts", "console.log(x); // code-health: allow(console_log) default sink"), 0);
  assert.equal(c("console_log", "a.ts", "console.log(x); // code-health: allow(console_log)"), 1);
  assert.equal(c("console_log", "a.ts", "console.log(x); // code-health: allow(todo_fixme) wrong metric"), 1);
  assert.equal(allowed("x // code-health: allow(ts_ignore) because", "ts_ignore"), true);
});
test("skipped tests: skip/todo/skipIf/xit detected only in test files", () => {
  for (const s of ["it.skip('a', f)", "test.skip(!X, 'no creds')", "describe.skipIf(!K)('x', f)", "it.todo('later')", "xit('a', f)"]) assert.equal(c("skipped_test_files", "a.test.ts", s), 1, s);
  assert.equal(c("skipped_test_files", "a.test.ts", "it('skips nothing', f)"), 0);
  assert.equal(METRICS.skipped_test_files.scope("src/lib/a.ts"), false);
  assert.equal(isTest("e2e/a.ts"), true);
});
test("skip without a reason is a hard violation; with a reason it is not", () => {
  assert.equal(qualityViolations("a.test.ts", "it.skip('works', f)").length, 1); // a title is not a reason
  assert.equal(qualityViolations("a.test.ts", "// flaky on CI, see tracker\nit.skip('works', f)").length, 0);
  assert.equal(qualityViolations("a.test.ts", "it.todo('GAP-1: seat limit is not enforced yet')").length, 0);
  assert.equal(qualityViolations("a.test.ts", "it.todo('later')").length, 1);
  assert.equal(qualityViolations("e2e/a.spec.ts", "test.skip(!EMAIL, 'E2E_TEST_EMAIL not set');").length, 0);
  assert.equal(qualityViolations("e2e/a.spec.ts", "test.skip(cond);").length, 1);
  assert.equal(qualityViolations("a.ts", "// @ts-ignore").length, 1);
  assert.equal(qualityViolations("a.ts", "// @ts-ignore -- plain .mjs without types").length, 0);
});
test("TODO and coming soon", () => {
  assert.equal(c("todo_fixme", "a.ts", "// TODO fix\n// FIXME x\nconst TODOS = 1"), 2);
  assert.equal(c("coming_soon", "src/p.tsx", "<b>Coming Soon</b>"), 1);
  assert.equal(METRICS.coming_soon.scope("supabase/functions/x.ts"), false);
});
test("ratchet: growth fails, shrink is an improvement, missing baseline fails", () => {
  const base = { counts: Object.fromEntries(Object.keys(METRICS).map((k) => [k, 10])) };
  const same = Object.fromEntries(Object.keys(METRICS).map((k) => [k, 10]));
  assert.deepEqual(compare(same, base), { regressions: [], improvements: [] });
  assert.equal(compare({ ...same, any_files: 11 }, base).regressions[0].metric, "any_files");
  assert.equal(compare({ ...same, any_files: 9 }, base).improvements.length, 1);
  assert.equal(compare(same, { counts: {} }).regressions.length, Object.keys(METRICS).length);
});
test("baseline can only shrink", () => {
  const base = { counts: { any_files: 10, console_log: 5 } };
  const n = shrinkBaseline({ any_files: 12, console_log: 3, todo_fixme: 7 }, base);
  assert.equal(n.any_files, 10);
  assert.equal(n.console_log, 3);
  assert.equal(n.todo_fixme, 7);
});
