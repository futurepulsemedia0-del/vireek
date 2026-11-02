// crawl/axe.mjs — axe-core via @axe-core/playwright (already a devDependency). Absent => explicit BLOCKED, never a fake pass.
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export async function loadAxe() {
  try { const m = await import('@axe-core/playwright'); return m.default ?? m.AxeBuilder ?? null; } catch { return null; }
}

/** Pure: shrink an axe result to what the report needs. */
export function summarizeAxe(r) {
  const violations = (r.violations ?? []).map((v) => ({ id: v.id, impact: v.impact ?? 'minor', help: v.help, helpUrl: v.helpUrl, nodes: (v.nodes ?? []).length, sample: (v.nodes ?? []).slice(0, 3).map((n) => (Array.isArray(n.target) ? n.target.join(' ') : String(n.target))) }));
  const severe = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  return { violations, severeCount: severe.length, total: violations.length, passes: (r.passes ?? []).length, incomplete: (r.incomplete ?? []).length };
}

export async function runAxe(AxeBuilder, page) {
  return summarizeAxe(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze());
}
