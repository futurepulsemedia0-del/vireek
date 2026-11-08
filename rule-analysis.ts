// supabase/functions/_shared/workflow-compiler/rule-analysis.ts
//
// Phase 4 (pure core): conflict / shadowing detection, golden scenarios, impact preview.
// Reuses spec.ts evaluateRule/Rule: no second evaluator. The analysis is deliberately
// CONSERVATIVE: it only reports shadowing it can prove. Unknown => not reported.
import type { Rule } from "./spec.ts";

export interface PrioritizedRule { id: string; priority: number; when: Rule[]; outcome: string }
export interface RuleFinding { kind: "unsatisfiable" | "shadowed" | "redundant" | "ambiguous"; rule: string; by?: string; detail: string }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const low = (v: unknown) => String(v).toLowerCase();

/** true only when a ⇒ b is PROVEN (same path). */
export function implies(a: Rule, b: Rule): boolean {
  if (a.path !== b.path) return false;
  if (a.op === b.op && JSON.stringify(a.value) === JSON.stringify(b.value)) return true;
  const av = num(a.value), bv = num(b.value);
  switch (b.op) {
    case "truthy": return a.op === "truthy" || (a.op === "eq" && a.value !== false && a.value !== 0 && a.value !== "" && low(a.value) !== "false");
    case "falsy": return a.op === "falsy";
    case "eq": return a.op === "eq" && low(a.value) === low(b.value) || (a.op === "in" && Array.isArray(a.value) && a.value.length === 1 && low(a.value[0]) === low(b.value));
    case "gt": return av !== null && bv !== null && ((a.op === "gt" && av >= bv) || (a.op === "gte" && av > bv) || (a.op === "eq" && av > bv));
    case "gte": return av !== null && bv !== null && ((a.op === "gt" && av >= bv) || (a.op === "gte" && av >= bv) || (a.op === "eq" && av >= bv));
    case "lt": return av !== null && bv !== null && ((a.op === "lt" && av <= bv) || (a.op === "lte" && av < bv) || (a.op === "eq" && av < bv));
    case "lte": return av !== null && bv !== null && ((a.op === "lt" && av <= bv) || (a.op === "lte" && av <= bv) || (a.op === "eq" && av <= bv));
    case "in": return Array.isArray(b.value) && ((a.op === "eq" && b.value.map(low).includes(low(a.value))) || (a.op === "in" && Array.isArray(a.value) && a.value.every((x) => (b.value as unknown[]).map(low).includes(low(x)))));
    default: return false;
  }
}

/** true only when a and b can NEVER both hold (same path). */
export function disjoint(a: Rule, b: Rule): boolean {
  if (a.path !== b.path) return false;
  const av = num(a.value), bv = num(b.value);
  const pair = (x: Rule, y: Rule) => {
    const xv = num(x.value), yv = num(y.value);
    if (x.op === "truthy" && y.op === "falsy") return true;
    if (x.op === "eq" && y.op === "neq" && low(x.value) === low(y.value)) return true;
    if (x.op === "eq" && y.op === "eq" && low(x.value) !== low(y.value)) return true;
    if (xv !== null && yv !== null) {
      if (x.op === "gt" && (y.op === "lt" || y.op === "lte")) return xv >= yv;
      if (x.op === "gte" && y.op === "lt") return xv >= yv;
      if (x.op === "gte" && y.op === "lte") return xv > yv;
      if (x.op === "eq" && (y.op === "gt" || y.op === "gte" || y.op === "lt" || y.op === "lte")) return !implies(x, y);
    }
    return false;
  };
  void av; void bv;
  return pair(a, b) || pair(b, a);
}

const unsatisfiable = (r: PrioritizedRule) => r.when.some((x, i) => r.when.slice(i + 1).some((y) => disjoint(x, y)));
/** a's conditions are all implied by b's => every input matching b also matches a. */
const covers = (a: PrioritizedRule, b: PrioritizedRule) => a.when.every((ca) => b.when.some((cb) => implies(cb, ca)));
const mayOverlap = (a: PrioritizedRule, b: PrioritizedRule) => !a.when.some((x) => b.when.some((y) => disjoint(x, y)));

/** First-match semantics: lower `priority` number is evaluated first, ties break on id. */
export function analyzeRules(rules: readonly PrioritizedRule[]): RuleFinding[] {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const out: RuleFinding[] = [];
  ordered.forEach((r, i) => {
    if (unsatisfiable(r)) { out.push({ kind: "unsatisfiable", rule: r.id, detail: "its own conditions contradict each other, so it can never match" }); return; }
    for (const earlier of ordered.slice(0, i)) {
      if (unsatisfiable(earlier)) continue;
      if (covers(earlier, r)) {
        out.push(earlier.outcome === r.outcome
          ? { kind: "redundant", rule: r.id, by: earlier.id, detail: `"${earlier.id}" already matches everything this rule matches, with the same outcome` }
          : { kind: "shadowed", rule: r.id, by: earlier.id, detail: `"${earlier.id}" matches first and decides "${earlier.outcome}", so this rule's "${r.outcome}" is unreachable` });
        return;
      }
    }
    const tie = ordered.slice(0, i).find((e) => e.priority === r.priority && e.outcome !== r.outcome && !unsatisfiable(e) && mayOverlap(e, r));
    if (tie) out.push({ kind: "ambiguous", rule: r.id, by: tie.id, detail: `same priority as "${tie.id}", different outcome, and both can match the same input; order is decided only by id` });
  });
  return out;
}

// ---------------------------------------------------------------- golden scenarios & impact
export interface GoldenScenario<I, O> { name: string; input: I; expect: O }
export function runGolden<I, O>(scenarios: readonly GoldenScenario<I, O>[], decide: (input: I) => O): { passed: number; failures: { name: string; expected: O; actual: O | { error: string } }[] } {
  const failures: { name: string; expected: O; actual: O | { error: string } }[] = [];
  for (const s of scenarios) {
    try {
      const actual = decide(s.input);
      if (JSON.stringify(actual) !== JSON.stringify(s.expect)) failures.push({ name: s.name, expected: s.expect, actual });
    } catch (e) {
      failures.push({ name: s.name, expected: s.expect, actual: { error: e instanceof Error ? e.message : "error" } });
    }
  }
  return { passed: scenarios.length - failures.length, failures };
}

export function impactPreview<I, O>(past: readonly { id: string; input: I }[], before: (i: I) => O, after: (i: I) => O, sample = 20): { total: number; altered: number; ids: string[] } {
  const ids: string[] = []; let altered = 0;
  for (const p of past) {
    let a: string, b: string;
    try { a = JSON.stringify(before(p.input)); } catch { a = "__error__"; }
    try { b = JSON.stringify(after(p.input)); } catch { b = "__error__"; }
    if (a !== b) { altered++; if (ids.length < sample) ids.push(p.id); }
  }
  return { total: past.length, altered, ids };
}
