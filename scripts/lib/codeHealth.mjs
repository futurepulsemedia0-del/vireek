// scripts/lib/codeHealth.mjs
// Pure counting rules for the code-health ratchets. No I/O except `listFiles`/`scanRepo` helpers.
// Every metric is "lower is better"; the baseline may only shrink.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export const ROOTS = ["src", "supabase/functions", "e2e", "worker", "api", "services"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "playwright-report", "test-results"]);
export const isSource = (p) => /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p);
export const isTest = (p) => /\.(test|spec)\.(ts|tsx)$/.test(p) || /(^|\/)e2e\//.test(p) || /(^|\/)__tests__\//.test(p);

/** A line carries an explicit, reviewed exemption: `// code-health: allow(<metric>) <reason>` */
export const allowed = (line, metric) => new RegExp(`code-health:\\s*allow\\(${metric}\\)\\s*\\S+`).test(line);

const stripLineComment = (l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, "");

/** Metric definitions. `count(path, text)` returns the number of units; `scope` decides which files are scanned. */
export const METRICS = {
  any_files: {
    label: "files using `any`", unit: "files", scope: (p) => !isTest(p),
    count: (_p, t) => (t.split("\n").some((l) => !allowed(l, "any_files") && /(:\s*any\b|\bas any\b|<any[,>]|\bany\[\]|Array<any>)/.test(stripLineComment(l))) ? 1 : 0),
  },
  eslint_disable_files: {
    label: "files with eslint-disable", unit: "files", scope: () => true,
    count: (_p, t) => (t.split("\n").some((l) => /eslint-disable/.test(l) && !allowed(l, "eslint_disable_files")) ? 1 : 0),
  },
  console_log: {
    label: "console.log/debug in production code", unit: "lines", scope: (p) => !isTest(p) && !/(^|\/)api-v1\/(contract|quickstarts)\.ts$/.test(p) && !/src\/pages\/SdksPage\.tsx$/.test(p),
    count: (_p, t) => t.split("\n").filter((l) => /\bconsole\.(log|debug)\s*\(/.test(stripLineComment(l)) && !allowed(l, "console_log")).length,
  },
  todo_fixme: {
    label: "TODO/FIXME markers", unit: "lines", scope: () => true,
    count: (_p, t) => t.split("\n").filter((l) => /\b(TODO|FIXME)\b/.test(l) && !allowed(l, "todo_fixme")).length,
  },
  skipped_test_files: {
    label: "test files with skipped/todo tests", unit: "files", scope: isTest,
    count: (_p, t) => (t.split("\n").some((l) => SKIP_RE.test(l) && !allowed(l, "skipped_test_files")) ? 1 : 0),
  },
  ts_ignore: {
    label: "@ts-ignore", unit: "lines", scope: () => true,
    count: (_p, t) => t.split("\n").filter((l) => /@ts-ignore/.test(l) && !allowed(l, "ts_ignore")).length,
  },
  coming_soon: {
    label: "'Coming soon' strings in UI/source", unit: "lines", scope: (p) => !isTest(p) && /^src\//.test(p),
    count: (_p, t) => t.split("\n").filter((l) => /coming soon/i.test(l) && !allowed(l, "coming_soon")).length,
  },
};

export const SKIP_RE = /\b(it|test|describe)\.(skip|todo|fixme)\(|\b(it|test|describe)\.skipIf\(|\bx(it|describe)\(|\btest\.skip\(/;

/** Hard rules that must be zero from day one (no baseline). */
export function qualityViolations(path, text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (isTest(path) && SKIP_RE.test(l) && !allowed(l, "skipped_test_files")) {
      // A skip must say why: (1) a reason string as a later argument, e.g. test.skip(!TOKEN, 'TOKEN not set'),
      // (2) an it.todo title of 3+ words, or (3) a comment with the reason on this line or the line above.
      const call = l.slice(l.search(SKIP_RE));
      const reasonArg = /,\s*['"`][^'"`]*[A-Za-z]{3,}/.test(call);
      const todoTitle = /\.todo\(\s*['"`](\S+\s+){2,}/.test(call);
      const comment = /\/\/.*[A-Za-z]{3,}/.test(l) || /^\s*\/\/.*[A-Za-z]{3,}/.test(lines[i - 1] ?? "");
      if (!(reasonArg || todoTitle || comment)) out.push({ path, line: i + 1, rule: "skip_without_reason", text: l.trim() });
    }
    if (/@ts-ignore\s*$/.test(l)) out.push({ path, line: i + 1, rule: "ts_ignore_without_reason", text: l.trim() });
  });
  return out;
}

export function listFiles(root, dir = root, acc = []) {
  let entries; try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(root, full, acc); else acc.push(full.split(sep).join("/"));
  }
  return acc;
}

export function scanRepo(cwd = process.cwd(), roots = ROOTS) {
  const counts = Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0]));
  const offenders = Object.fromEntries(Object.keys(METRICS).map((k) => [k, []]));
  const violations = [];
  const prev = process.cwd(); if (cwd !== prev) process.chdir(cwd);
  try {
    for (const r of roots) for (const p of listFiles(r)) {
      if (!isSource(p)) continue;
      const text = readFileSync(p, "utf8");
      for (const [k, m] of Object.entries(METRICS)) {
        if (!m.scope(p)) continue;
        const n = m.count(p, text);
        if (n) { counts[k] += n; offenders[k].push(p); }
      }
      violations.push(...qualityViolations(p, text));
    }
  } finally { if (cwd !== prev) process.chdir(prev); }
  return { counts, offenders, violations };
}

/** Compare current counts with a baseline. `regressions` fail CI; `improvements` ask to shrink the baseline. */
export function compare(counts, baseline) {
  const regressions = [], improvements = [];
  for (const k of Object.keys(METRICS)) {
    const b = baseline?.counts?.[k];
    if (typeof b !== "number") { regressions.push({ metric: k, baseline: null, current: counts[k], reason: "missing_baseline" }); continue; }
    if (counts[k] > b) regressions.push({ metric: k, baseline: b, current: counts[k], reason: "grew" });
    else if (counts[k] < b) improvements.push({ metric: k, baseline: b, current: counts[k] });
  }
  return { regressions, improvements };
}

/** New baseline = element-wise min(old, current): it can only shrink. A brand-new metric takes the current value. */
export function shrinkBaseline(counts, baseline) {
  const next = {};
  for (const k of Object.keys(METRICS)) { const b = baseline?.counts?.[k]; next[k] = typeof b === "number" ? Math.min(b, counts[k]) : counts[k]; }
  return next;
}
