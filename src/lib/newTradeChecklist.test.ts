import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AREA_TITLES, CHECKLIST_AREAS, COVERED_HAZARDS, SUPPORTED_LOCALES, TOUCHPOINTS,
  checkEvidence, extractWorkflowSlugs, generateChecklist, lintPlaybookDraft, parseCandidate, parseDraft,
  renderChecklistMarkdown, resolveJobType, summarizeFindings, validateCandidate,
  type DraftPlaybook, type TradeCandidate,
} from './newTradeChecklist';
import { TRADE_PLAYBOOKS } from './tradePlaybookCatalog';

const root = process.cwd();
const readRepo = (p: string): string | null => {
  const abs = join(root, p);
  if (!existsSync(abs)) return null;
  return statSync(abs).isDirectory() ? '' : readFileSync(abs, 'utf8');
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const fixture = JSON.parse(readFileSync(join(root, 'docs/product/examples/garage-door.dry-run.json'), 'utf8')) as { candidate: TradeCandidate; draft: DraftPlaybook };
const workflowSlugs = extractWorkflowSlugs(readFileSync(join(root, 'src/lib/workflowPlaybooks.ts'), 'utf8'));

const minimal: TradeCandidate = {
  slug: 'glazing', name: 'Glazing', hazards: [], regulatedWork: false, usesRegulatedProducts: false,
  recurringContracts: false, markets: ['US'], languages: [], joinsOutcomeNetwork: false, needsNewTables: false,
};
const codes = (f: ReturnType<typeof lintPlaybookDraft>) => f.map((x) => x.code);
const lint = (d: DraftPlaybook) => lintPlaybookDraft(d, { knownWorkflowSlugs: workflowSlugs });

describe('validateCandidate', () => {
  it('accepts the dry-run candidate and a minimal one', () => {
    expect(validateCandidate(fixture.candidate)).toEqual([]);
    expect(validateCandidate(minimal)).toEqual([]);
  });
  it('rejects bad slugs, taken slugs, unknown hazards, bad markets and unsupported languages', () => {
    const bad = { ...minimal, slug: 'Garage-Door', hazards: ['lasers'], markets: ['usa'], languages: ['xx'] } as unknown as TradeCandidate;
    const errs = validateCandidate(bad).join('\n');
    expect(errs).toContain('slug "Garage-Door"');
    expect(errs).toContain('unknown hazard "lasers"');
    expect(errs).toContain('market "usa"');
    expect(errs).toContain('language "xx"');
    expect(validateCandidate({ ...minimal, slug: 'hvac' }).join()).toContain('already has a playbook');
    expect(validateCandidate({ ...minimal, markets: [] }).join()).toContain('at least one target market');
    expect(validateCandidate({ ...minimal, name: '   ' }).join()).toContain('name must be');
  });
  it('generateChecklist refuses an invalid candidate', () => {
    expect(() => generateChecklist({ ...minimal, slug: 'x' })).toThrow('Invalid trade candidate');
  });
});

describe('parseCandidate / parseDraft (untrusted JSON boundary)', () => {
  it('parses valid input and reports structural problems without throwing', () => {
    expect(parseCandidate(fixture.candidate).errors).toEqual([]);
    expect(parseCandidate(null).errors[0]).toContain('JSON object');
    expect(parseCandidate({ slug: 5 }).errors.length).toBeGreaterThan(3);
    expect(parseDraft(fixture.draft).errors).toEqual([]);
    expect(parseDraft('x').errors[0]).toContain('JSON object');
    const broken = clone(fixture.draft) as unknown as { jobTypes: Array<{ price: unknown }> };
    broken.jobTypes[0].price = { serviceName: 1 };
    expect(parseDraft(broken).errors.join()).toContain('price is malformed');
  });
});

describe('generateChecklist', () => {
  const full = generateChecklist(fixture.candidate);
  const small = generateChecklist(minimal);
  const ids = (l: typeof full) => l.items.map((i) => i.id);

  it('has unique ids, valid areas and a title for every area', () => {
    expect(new Set(TOUCHPOINTS.map((t) => t.id)).size).toBe(TOUCHPOINTS.length);
    for (const t of TOUCHPOINTS) expect(CHECKLIST_AREAS).toContain(t.area);
    for (const a of CHECKLIST_AREAS) expect(AREA_TITLES[a]).toBeTruthy();
    expect(full.items.length + full.skipped.length).toBe(TOUCHPOINTS.length);
  });
  it('covers every required theme: price book, intents, safety, compliance, localization', () => {
    for (const area of ['price_book', 'intents', 'safety', 'compliance', 'localization'] as const) {
      expect(TOUCHPOINTS.some((t) => t.area === area)).toBe(true);
    }
  });
  it('adds conditional work when the candidate needs it', () => {
    for (const id of ['F2', 'F4', 'F5', 'C1', 'C3', 'C4', 'C6', 'D2', 'L1', 'L3']) expect(ids(full)).toContain(id);
    for (const id of ['C2', 'C7', 'D3', 'P5', 'L5']) expect(ids(full)).not.toContain(id);
  });
  it('drops conditional work when it does not apply', () => {
    for (const id of ['F2', 'F4', 'F5', 'C1', 'C3', 'C6', 'D2', 'L1', 'L3', 'L4']) expect(ids(small)).not.toContain(id);
    for (const id of ['S1', 'P1', 'P2', 'I1', 'F1', 'F3', 'F6', 'D1', 'E1', 'Q2', 'R2']) expect(ids(small)).toContain(id);
  });
  it('triggers regulated-product, new-table, non-US and language-specific work', () => {
    const l = generateChecklist({ ...minimal, usesRegulatedProducts: true, needsNewTables: true, markets: ['DE'], languages: ['ar'] });
    for (const id of ['C2', 'C7', 'D3', 'P5', 'L5', 'C4', 'L2']) expect(ids(l)).toContain(id);
  });
  it('F5 applies only to hazard classes without a fixed safety line', () => {
    expect(ids(generateChecklist({ ...minimal, hazards: ['gas', 'water'] }))).not.toContain('F5');
    expect(ids(generateChecklist({ ...minimal, hazards: ['gas', 'chemical'] }))).toContain('F5');
  });
  it('orders items by area and counts blocking / counsel / verify correctly', () => {
    const order = full.items.map((i) => CHECKLIST_AREAS.indexOf(i.area));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(full.counts.total).toBe(full.items.length);
    expect(full.counts.blocking).toBe(full.items.filter((i) => i.blocking).length);
    expect(full.counts.counsel).toBeGreaterThan(0);
    expect(full.counts.verify).toBeGreaterThan(0);
  });
  it('marks every legal-sounding item [COUNSEL]', () => {
    for (const id of ['C1', 'C4', 'C5', 'C6', 'F4', 'F5']) expect(TOUCHPOINTS.find((t) => t.id === id)?.tags).toContain('COUNSEL');
  });
  it('renders deterministic Markdown with one checkbox per item', () => {
    const md = renderChecklistMarkdown(full);
    expect(renderChecklistMarkdown(generateChecklist(fixture.candidate))).toBe(md);
    expect((md.match(/^- \[ \] \*\*/gm) ?? []).length).toBe(full.items.length);
    expect(md).toContain('## 4. Safety content');
    expect(md).toContain('## Not applicable for this candidate');
  });
});

describe('checkEvidence', () => {
  it('detects missing files, stale substrings and substrings that should be absent', () => {
    const tp = [{ id: 'X1', area: 'scope', title: 't', action: 'a', kind: 'human', blocking: false, tags: [], files: ['a.ts'], evidence: [
      { file: 'a.ts', contains: 'needle' }, { file: 'a.ts', absent: 'poison' }, { file: 'gone.ts' },
    ] }] as const;
    const reader = (p: string) => (p === 'a.ts' ? 'hay poison hay' : null);
    const out = checkEvidence(reader, tp as never).join('\n');
    expect(out).toContain('no longer contains "needle"');
    expect(out).toContain('now contains "poison"');
    expect(out).toContain('file not found: gone.ts');
    expect(checkEvidence((p) => (p === 'a.ts' ? 'needle' : null), [{ ...tp[0], evidence: [{ file: 'a.ts', contains: 'needle' }] }] as never)).toEqual([]);
  });
  it('flags duplicate touchpoint ids', () => {
    const t = { id: 'D', area: 'scope', title: '', action: '', kind: 'human', blocking: false, tags: [], files: [], evidence: [] };
    expect(checkEvidence(() => '', [t, t] as never).join()).toContain('duplicate touchpoint id');
  });
  it('every touchpoint claim still holds in this repository', () => {
    expect(checkEvidence(readRepo)).toEqual([]);
  });
});

describe('drift guards (checklist constants vs source of truth)', () => {
  it('COVERED_HAZARDS equals the fixed SAFETY_LINES in emergencyCore.ts', () => {
    const src = readFileSync(join(root, 'supabase/functions/_shared/emergency/emergencyCore.ts'), 'utf8');
    const block = src.slice(src.indexOf('const SAFETY_LINES'), src.indexOf('const SAFETY_ORDER'));
    const keys = [...block.matchAll(/^\s{2}([a-z_]+):\s*"/gm)].map((m) => m[1]);
    expect([...keys].sort()).toEqual([...COVERED_HAZARDS].sort());
  });
  it('SUPPORTED_LOCALES equals the locale folders under src/locales (minus en and non-language folders)', () => {
    const dirs = readdirSync(join(root, 'src/locales')).filter((d) => /^[a-z]{2}$/.test(d) && statSync(join(root, 'src/locales', d)).isDirectory());
    expect(dirs.filter((d) => d !== 'en').sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
  it('extractWorkflowSlugs agrees with WORKFLOW_PLAYBOOKS', async () => {
    const { WORKFLOW_PLAYBOOKS } = await import('@/lib/workflowPlaybooks');
    expect(workflowSlugs).toEqual(WORKFLOW_PLAYBOOKS.map((p) => p.slug));
  });
  it('every shipped playbook already uses a slug the checklist would accept', () => {
    for (const p of TRADE_PLAYBOOKS) expect(p.slug).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });
});

describe('lintPlaybookDraft', () => {
  it('the dry-run draft is clean', () => {
    const f = lint(fixture.draft);
    expect(summarizeFindings(f)).toEqual({ errors: 0, warnings: 0 });
  });
  it('warns, but does not fail, when workflow slugs are not verified', () => {
    const f = lintPlaybookDraft(fixture.draft);
    expect(codes(f)).toEqual(['workflows-unverified']);
  });

  const mutate = (fn: (d: DraftPlaybook) => void): DraftPlaybook => { const d = clone(fixture.draft); fn(d); return d; };
  const cases: Array<[string, (d: DraftPlaybook) => void, string]> = [
    ['hyphenated slug', (d) => { d.slug = 'garage-door'; }, 'slug-format'],
    ['slug already in catalog', (d) => { d.slug = 'hvac'; }, 'slug-taken'],
    ['fewer than three job types', (d) => { d.jobTypes = d.jobTypes.slice(0, 2); }, 'job-types-min'],
    ['upper-case match fragment', (d) => { d.jobTypes[1].match = ['Opener']; }, 'match-case'],
    ['identical fragment to another trade', (d) => { d.jobTypes[1].match = ['leak']; }, 'match-collision'],
    ['fragment that contains an older trade fragment', (d) => { d.jobTypes[1].match = ['opener tune-up']; }, 'match-shadowed'],
    ['service name captured by another trade', (d) => { d.jobTypes[0].price.serviceName = 'Garage door spring replacement'; }, 'price-name-shadowed'],
    ['service name that matches nothing', (d) => { d.jobTypes[0].price.serviceName = 'Gizmo'; }, 'price-name-unmatched'],
    ['service name routed to a sibling job type', (d) => { d.jobTypes[0].price.serviceName = 'Garage door opener spring'; }, 'price-name-misrouted'],
    ['no match fragments at all', (d) => { d.jobTypes[1].match = []; }, 'match-empty'],
    ['duplicate job type key', (d) => { d.jobTypes[1].key = d.jobTypes[0].key; }, 'jobtype-key-dup'],
    ['key collides after hyphen conversion', (d) => { d.jobTypes[0].key = 'a-b'; d.jobTypes[1].key = 'a--b'; }, 'jobtype-key-collision'],
    ['underscore in a job type key', (d) => { d.jobTypes[0].key = 'a_b'; }, 'jobtype-key-format'],
    ['duplicate checklist id', (d) => { d.jobTypes[0].checklist[1].id = d.jobTypes[0].checklist[0].id; }, 'checklist-id-dup'],
    ['diagnosable job type without a critical item', (d) => { d.jobTypes[0].checklist.forEach((c) => { delete c.critical; }); }, 'checklist-no-critical'],
    ['empty safety sentence', (d) => { d.jobTypes[0].troubleshooting!.safety = ' '; }, 'safety-empty'],
    ['no common cause', (d) => { d.jobTypes[0].troubleshooting!.causes.forEach((c) => { c.likelihood = 'rare'; }); }, 'causes-no-common'],
    ['too few causes', (d) => { d.jobTypes[0].troubleshooting!.causes = d.jobTypes[0].troubleshooting!.causes.slice(0, 2); }, 'causes-min'],
    ['duplicate cause key', (d) => { d.jobTypes[0].troubleshooting!.causes[1].key = d.jobTypes[0].troubleshooting!.causes[0].key; }, 'cause-key-dup'],
    ['cause without a fix', (d) => { d.jobTypes[0].troubleshooting!.causes[0].fix = ''; }, 'cause-incomplete'],
    ['cost at or above price', (d) => { d.jobTypes[0].price.estimatedCostCents = d.jobTypes[0].price.priceCents; }, 'price-cost'],
    ['fractional cents', (d) => { d.jobTypes[0].price.priceCents = 29900.5; }, 'price-integer'],
    ['range price without a maximum', (d) => { d.jobTypes[2].price.priceMaxCents = undefined; }, 'price-range'],
    ['duplicate service name', (d) => { d.jobTypes[1].price.serviceName = d.jobTypes[0].price.serviceName; }, 'price-name-dup'],
    ['service name already used by another trade', (d) => { d.jobTypes[0].price.serviceName = 'Drain Clearing'; }, 'price-name-taken'],
    ['no keywords', (d) => { d.jobTypes[0].price.keywords = []; }, 'price-keywords-empty'],
    ['benchmark percentage over 100', (d) => { d.jobTypes[0].benchmark.firstTimeFixPct = 120; }, 'bench-pct'],
    ['inverted ticket range', (d) => { d.jobTypes[0].benchmark.ticketMinCents = 99999; }, 'bench-ticket-order'],
    ['no dispatch rules', (d) => { d.dispatchNotes = []; }, 'dispatch-min'],
    ['unknown workflow slug', (d) => { d.workflowSlugs = ['made-up-workflow']; }, 'workflow-unknown'],
    ['non-positive catalog version', (d) => { d.catalogVersion = 0; }, 'catalog-version'],
  ];
  for (const [name, fn, code] of cases) {
    it(`flags: ${name} -> ${code}`, () => {
      expect(codes(lint(mutate(fn)))).toContain(code);
    });
  }

  it('flags errors and warnings with the right severity', () => {
    const f = lint(mutate((d) => { d.jobTypes[0].price.priceCents = 29950; d.jobTypes[0].price.description = 'Lifetime guarantee on every spring'; }));
    expect(f.find((x) => x.code === 'price-whole-dollar')?.severity).toBe('warning');
    expect(f.find((x) => x.code === 'promise-language')?.severity).toBe('warning');
    expect(lint(mutate((d) => { d.slug = 'hvac'; })).find((x) => x.code === 'slug-taken')?.severity).toBe('error');
  });
  it('warns when margin at the lowest price is far below the benchmark target', () => {
    const f = lint(mutate((d) => { d.jobTypes[0].price.estimatedCostCents = 25000; }));
    expect(codes(f)).toContain('price-margin');
  });
});

describe('resolveJobType (mirrors firstTimeFixAutopilot.findJobType)', () => {
  it('routes the dry-run service names to the new trade when it is appended last', () => {
    const all = [...TRADE_PLAYBOOKS, fixture.draft] as DraftPlaybook[];
    for (const jt of fixture.draft.jobTypes) {
      const r = resolveJobType(all, jt.price.serviceName);
      expect(r?.playbook.slug).toBe('garage_door');
      expect(r?.jobType.key).toBe(jt.key);
    }
  });
});

/**
 * Regression gate for the SHIPPED catalog. Each playbook is linted against the playbooks that precede it,
 * which is the order findJobType uses. The errors below are PRE-EXISTING defects found while building this
 * tool (docs/product/new-vertical-playbook.md, "Findings in the shipped catalog"). They are pinned, not
 * endorsed: any NEW error fails this test, and fixing one makes the test fail until the entry is removed.
 */
describe('shipped catalog baseline', () => {
  const KNOWN: string[] = [
    'plumbing|match-shadowed|jobTypes[1](water-heater)',
    'plumbing|price-name-shadowed|jobTypes[1](water-heater).price',
    'plumbing|match-collision|jobTypes[3](fixture-install)',
    'plumbing|price-name-shadowed|jobTypes[3](fixture-install).price',
    'electrical|match-shadowed|jobTypes[1](panel-breaker)',
    'electrical|price-name-shadowed|jobTypes[2](lighting-fan).price',
    'electrical|price-name-shadowed|jobTypes[3](ev-charger).price',
  ];
  const actual = (): string[] => TRADE_PLAYBOOKS.flatMap((pb, i) =>
    lintPlaybookDraft(pb as DraftPlaybook, { existing: TRADE_PLAYBOOKS.slice(0, i) as DraftPlaybook[], knownWorkflowSlugs: workflowSlugs })
      .filter((f) => f.severity === 'error')
      .map((f) => `${pb.slug}|${f.code}|${f.path}`));

  it('has no errors other than the documented ones', () => {
    expect(actual().sort()).toEqual([...KNOWN].sort());
  });
  it('has no lint warnings of the kinds that indicate content gaps', () => {
    const bad = TRADE_PLAYBOOKS.flatMap((pb, i) =>
      lintPlaybookDraft(pb as DraftPlaybook, { existing: TRADE_PLAYBOOKS.slice(0, i) as DraftPlaybook[], knownWorkflowSlugs: workflowSlugs })
        .filter((f) => f.severity === 'warning' && ['promise-language', 'price-margin', 'price-vs-ticket', 'dispatch-no-urgency'].includes(f.code))
        .map((f) => `${pb.slug}|${f.code}|${f.path}`));
    expect(bad).toEqual([]);
  });
  it('documents the cross-trade resolver behaviour that causes the defects', () => {
    // Today "Water Heater Repair" resolves to HVAC through firstTimeFixAutopilot.findJobType. When the resolver is fixed, update this and the doc.
    expect(resolveJobType(TRADE_PLAYBOOKS as DraftPlaybook[], 'Water Heater Repair')?.playbook.slug).toBe('hvac');
  });
});
