// scripts/brand-audit/score.mjs — pure scoring, regression and gate logic (no I/O, fully unit-tested).
//
// Honesty rules enforced here:
//  * A category with no measured component has score null ("NOT RUN") — it is excluded from the overall score and
//    the overall reports how much of the rubric weight was actually measured.
//  * Evidence-gated items (certifications, reviews, customer references …) never touch a score.
import { CATEGORIES, REGRESSION_TOLERANCE, SEVERITY_WEIGHT, NEEDS_EVIDENCE_STATIC } from './config.mjs';
import { combine, round1 } from './lib/util.mjs';

/** Merge any number of check/crawl results into one record per category. */
export function mergeResults(results) {
  const cats = {};
  for (const def of CATEGORIES) cats[def.id] = { components: [], metrics: {}, findings: [], needsDetected: [] };
  for (const r of results) {
    const c = cats[r.category];
    if (!c) throw new Error(`Unknown category "${r.category}"`);
    c.components.push(...(r.components ?? []));
    c.findings.push(...(r.findings ?? []));
    c.needsDetected.push(...(r.needsEvidenceDetected ?? []));
    c.metrics = { ...c.metrics, ...Object.fromEntries(Object.entries(r.metrics ?? {}).map(([k, v]) => [k, v])) };
  }
  return cats;
}

export function scoreAll(merged) {
  const categories = CATEGORIES.map((def) => {
    const m = merged[def.id];
    const score = combine(m.components);
    const notRun = m.components.filter((c) => c.score === null || c.score === undefined);
    return {
      id: def.id, label: def.label, weight: def.weight, floor: def.floor, target: def.target,
      score, status: score === null ? 'not-run' : notRun.length ? 'partial' : 'measured',
      components: m.components, notRunComponents: notRun.map((c) => c.name), metrics: m.metrics,
      findingCount: m.findings.length,
      needsEvidence: [...(NEEDS_EVIDENCE_STATIC[def.id] ?? []).map((label) => ({ label, kind: 'standing' })), ...m.needsDetected.map((d) => ({ label: `${d.label}: ${d.occurrences} occurrence(s) with no current evidence entry`, kind: 'detected', id: d.id, refs: d.refs }))],
    };
  });
  const measured = categories.filter((c) => c.score !== null);
  const wMeasured = measured.reduce((a, c) => a + c.weight, 0);
  const overall = wMeasured ? round1(measured.reduce((a, c) => a + c.score * c.weight, 0) / wMeasured) : null;
  return { categories, overall, coverage: round1(wMeasured), };
}

/** Prioritised fix list: severity × category weight × (1 + log10(count)). */
export function prioritize(merged, limit = 30) {
  const weight = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.weight]));
  const byId = new Map();
  for (const [cat, m] of Object.entries(merged)) for (const f of m.findings) {
    const key = f.id;
    const e = byId.get(key) ?? { ...f, category: cat, count: 0, refs: [] };
    e.count += f.count ?? 1;
    e.refs = [...e.refs, ...(f.refs ?? [])].slice(0, 200);
    byId.set(key, e);
  }
  return [...byId.values()]
    .filter((f) => (SEVERITY_WEIGHT[f.severity] ?? 0) > 0)
    .map((f) => ({ ...f, priority: round1((SEVERITY_WEIGHT[f.severity] ?? 0) * (weight[f.category] ?? 1) * (1 + Math.log10(Math.max(1, f.count)))) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/** Per-category deltas vs a previous run. Only categories measured in BOTH runs are compared. */
export function compare(prev, cur, tolerance = REGRESSION_TOLERANCE) {
  if (!prev) return { available: false, rows: [], regressions: [], newCritical: [] };
  const prevScore = Object.fromEntries((prev.categories ?? []).map((c) => [c.id, c.score]));
  const rows = cur.categories.filter((c) => c.score !== null && prevScore[c.id] != null).map((c) => ({ id: c.id, label: c.label, prev: prevScore[c.id], cur: c.score, delta: round1(c.score - prevScore[c.id]) }));
  const regressions = rows.filter((r) => r.delta < -tolerance);
  const prevCrit = new Set((prev.criticalIds ?? []));
  const newCritical = (cur.criticalIds ?? []).filter((id) => !prevCrit.has(id));
  return { available: true, rows, regressions, newCritical };
}

/**
 * Gate. Floors: config floor, or (baseline score − tolerance) when a baseline exists. A category with neither is
 * reported as "no gate yet", never silently passed as healthy.
 */
export function evaluateGate(cur, { prev = null, baseline = null, tolerance = REGRESSION_TOLERANCE, requireMeasured = [] } = {}) {
  const failures = []; const warnings = [];
  const cmp = compare(prev, cur, tolerance);
  for (const c of cur.categories) {
    if (c.score === null) { if (requireMeasured.includes(c.id)) failures.push(`${c.label}: NOT RUN but required in this mode`); else warnings.push(`${c.label}: NOT RUN`); continue; }
    const baseFloor = baseline?.categories?.[c.id] != null ? round1(baseline.categories[c.id] - tolerance) : null;
    const floor = Math.max(c.floor ?? -Infinity, baseFloor ?? -Infinity);
    if (!Number.isFinite(floor)) { warnings.push(`${c.label}: no floor/baseline yet (score ${c.score}) — record one with --write-baseline-scores`); continue; }
    if (c.score < floor) failures.push(`${c.label}: ${c.score} is below the floor ${floor}`);
  }
  for (const r of cmp.regressions) failures.push(`${r.label}: regressed ${r.delta} (${r.prev} → ${r.cur}) vs the previous run`);
  for (const id of cmp.newCritical) failures.push(`New critical finding: ${id}`);
  return { pass: failures.length === 0, failures, warnings, compare: cmp };
}

export function snapshot(scored, prioritized, extra = {}) {
  const critical = prioritized.filter((f) => f.severity === 'critical').map((f) => f.id);
  return { generatedAt: new Date().toISOString(), overall: scored.overall, coverage: scored.coverage, categories: scored.categories.map(({ id, label, weight, score, status }) => ({ id, label, weight, score, status })), criticalIds: critical, ...extra };
}
