import { describe, it, expect } from 'vitest';
import {
  GuardError, SAMPLE_PACK_V1, SAMPLE_PACK_V1_1, applyOps, artifactMap, assertRegistryValid, compareSemver, customizedIds,
  flattenPack, getPackVersion, isCustomized, jsonEqual, latestVersion, listPackIds, packEntitlementKey, planInstall, planReset,
  planRollback, planUpgrade, previewDiff, validateArtifactContent, validatePack,
  type AccountState, type InstallEvent, type Op, type PackManifest, type Plan,
} from './index';
import { TRADE_PLAYBOOKS } from '@/lib/tradePlaybookCatalog';

const manifestOf = (m: PackManifest | undefined) => (id: string) => (m ? artifactMap(m).get(id)?.content : undefined);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Applies a plan the way the server would and returns the new state + the event for rollback. */
function run(state: AccountState, plan: Plan, target: PackManifest | undefined) {
  const next = applyOps(state, plan.ops, manifestOf(target));
  const event: InstallEvent = { id: `e${Math.random()}`, kind: plan.kind, fromVersion: plan.fromVersion, toVersion: plan.toVersion, ops: plan.ops };
  return { state: next, event };
}
const issues = (p: unknown) => validatePack(p).issues.map((i) => `${i.path}: ${i.message}`);
const customize = (s: AccountState, id: string, patch: Record<string, unknown>): AccountState => {
  const n = clone(s);
  n[id].live = { ...(n[id].live as object), ...patch };
  return n;
};
function invariant(state: AccountState, installed: PackManifest | undefined) {
  for (const [id, t] of Object.entries(state)) {
    if (t.base === null) continue;
    expect(installed, `${id} tracked but nothing installed`).toBeDefined();
    expect(jsonEqual(t.base, manifestOf(installed)(id)), `${id}: base must equal installed version content`).toBe(true);
  }
}

describe('schema validation', () => {
  it('ships only valid packs (registry gate)', () => expect(() => assertRegistryValid()).not.toThrow());

  it('accepts the sample pack and flattens every artifact kind', () => {
    expect(validatePack(SAMPLE_PACK_V1).ok).toBe(true);
    const kinds = new Set(flattenPack(SAMPLE_PACK_V1).map((a) => a.kind));
    expect(kinds.size).toBe(11);
  });

  it('rejects unknown properties with a "did you mean" hint and a precise path', () => {
    const bad = clone(SAMPLE_PACK_V1) as unknown as Record<string, unknown>;
    (bad.jobTypes as Array<Record<string, unknown>>)[0].defaultDurationMinute = 60;
    const e = issues(bad).join('\n');
    expect(e).toContain('$.jobTypes[0].defaultDurationMinute');
    expect(e).toContain('Did you mean "defaultDurationMinutes"?');
  });

  it('rejects typo in a top-level section', () => {
    expect(issues({ ...clone(SAMPLE_PACK_V1), jobtypes: [] }).join('\n')).toContain('Did you mean "jobTypes"?');
  });

  it('requires integer cents and bounds', () => {
    const bad = clone(SAMPLE_PACK_V1);
    bad.pricingTemplates![0].lines[0].priceCents = 89.5;
    expect(issues(bad).join('\n')).toContain('integer cents');
    bad.pricingTemplates![0].lines[0].priceCents = -1;
    expect(issues(bad).join('\n')).toContain('between 0 and');
  });

  it('checks cross references with suggestions', () => {
    const bad = clone(SAMPLE_PACK_V1);
    bad.jobTypes![0].checklistFormKey = 'appliance_intak';
    bad.workflowRules![0].to = 'repaird';
    const e = issues(bad).join('\n');
    expect(e).toContain('references unknown form "appliance_intak"');
    expect(e).toContain('Did you mean "appliance_intake"?');
    expect(e).toContain('references unknown status "repaird"');
  });

  it('rejects duplicate keys, bad ids/versions, select without options, HTML and broken placeholders', () => {
    const dup = clone(SAMPLE_PACK_V1);
    dup.statuses!.push({ ...dup.statuses![0] });
    expect(issues(dup).join('\n')).toContain('duplicate key "new_call"');
    expect(issues({ ...clone(SAMPLE_PACK_V1), version: '1.0' }).join('\n')).toContain('$.version');
    expect(issues({ ...clone(SAMPLE_PACK_V1), id: 'Bad-Id' }).join('\n')).toContain('$.id');
    const sel = clone(SAMPLE_PACK_V1);
    sel.customFields![0].options = undefined;
    delete (sel.customFields![0] as { options?: string[] }).options;
    expect(issues(sel).join('\n')).toContain('needs at least one option');
    const html = clone(SAMPLE_PACK_V1);
    html.documentTemplates![0].body = 'Hi <script>alert(1)</script>';
    expect(issues(html).join('\n')).toContain('HTML is not allowed');
    html.documentTemplates![0].body = 'Hi {{customer.name';
    expect(issues(html).join('\n')).toContain('unbalanced');
  });

  it('rejects prototype-pollution keys, non-objects and oversize input', () => {
    const polluted = JSON.parse('{"schemaVersion":1,"id":"x_pack","version":"1.0.0","name":"x","jobTypes":[{"__proto__":{"a":1},"key":"ab","label":"L","defaultDurationMinutes":30}]}');
    expect(validatePack(polluted).ok).toBe(false);
    expect(validatePack('nope').ok).toBe(false);
    expect(validatePack(null).ok).toBe(false);
    expect(validatePack({ ...clone(SAMPLE_PACK_V1), description: 'x'.repeat(300_000) }).ok).toBe(false);
  });

  it('validates account customizations with the same rules', () => {
    expect(validateArtifactContent('term', { key: 'job', singular: 'Visit', plural: 'Visits' })).toEqual([]);
    expect(validateArtifactContent('term', { key: 'job', singular: '', plural: 'Visits' }).length).toBeGreaterThan(0);
    expect(validateArtifactContent('term', { key: 'job', singular: 'V', plural: 'V', extra: 1 }).length).toBeGreaterThan(0);
  });
});

describe('baseline HVAC / plumbing / electrical packs', () => {
  it('mirrors the playbook catalog exactly (jobs, critical checklist items, prices)', () => {
    expect(listPackIds()).toEqual(expect.arrayContaining(['hvac', 'plumbing', 'electrical', 'appliance_repair']));
    for (const pb of TRADE_PLAYBOOKS) {
      const pack = latestVersion(pb.slug)!;
      expect(pack.jobTypes!.length).toBe(pb.jobTypes.length);
      expect(pack.version).toBe(`${pb.catalogVersion}.0.0`);
      const crit = (f: { items: Array<{ critical?: boolean }> }) => f.items.filter((i) => i.critical).length;
      pb.jobTypes.forEach((j, i) => {
        expect(pack.forms![i].items.length).toBe(j.checklist.length);
        expect(crit(pack.forms![i])).toBe(j.checklist.filter((c) => c.critical).length);
        expect(pack.pricingTemplates![0].lines[i].priceCents).toBe(j.price.priceCents);
        expect(pack.jobTypes![i].ticketMaxCents).toBe(j.benchmark.ticketMaxCents);
      });
    }
  });
});

describe('install', () => {
  it('creates every artifact and is idempotent', () => {
    const p = planInstall(SAMPLE_PACK_V1);
    expect(p.summary.created).toBe(flattenPack(SAMPLE_PACK_V1).length);
    const { state } = run({}, p, SAMPLE_PACK_V1);
    invariant(state, SAMPLE_PACK_V1);
    const again = planInstall(SAMPLE_PACK_V1, state);
    expect(again.ops).toEqual([]);
    expect(again.summary.unchanged).toBe(p.summary.created);
  });
});

describe('upgrade: customizations are never overwritten', () => {
  const base = run({}, planInstall(SAMPLE_PACK_V1), SAMPLE_PACK_V1).state;

  it('updates what the account did not touch, adds new, removes dropped', () => {
    const plan = planUpgrade(SAMPLE_PACK_V1_1, base, '1.0.0');
    const { state } = run(base, plan, SAMPLE_PACK_V1_1);
    expect(state['term:job'].live).toMatchObject({ singular: 'Repair visit' });
    expect(state['status:quote_sent']).toBeDefined();
    expect(state['job_type:dryer_not_heating']).toBeDefined();
    expect(state['recurring_rule:annual_checkup']).toBeUndefined();
    expect(plan.conflicts).toEqual([]);
    invariant(state, SAMPLE_PACK_V1_1);
  });

  it('keeps a customization when the pack also changed it, and reports it', () => {
    const mine = customize(base, 'term:job', { singular: 'Ticket', plural: 'Tickets' });
    const plan = planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0');
    expect(plan.conflicts.map((c) => c.id)).toEqual(['term:job']);
    const { state } = run(mine, plan, SAMPLE_PACK_V1_1);
    expect(state['term:job'].live).toMatchObject({ singular: 'Ticket' });
    expect(isCustomized(state['term:job'])).toBe(true);
    expect(plan.summary.preservedCustomized).toBeGreaterThanOrEqual(1);
    invariant(state, SAMPLE_PACK_V1_1);
  });

  it('keeps a customized artifact the pack no longer ships (detached, now account-owned)', () => {
    const mine = customize(base, 'recurring_rule:annual_checkup', { intervalCount: 2 });
    const plan = planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0');
    const { state } = run(mine, plan, SAMPLE_PACK_V1_1);
    expect(state['recurring_rule:annual_checkup'].live).toMatchObject({ intervalCount: 2 });
    expect(state['recurring_rule:annual_checkup'].base).toBeNull();
  });

  it('a customization that already equals the new pack content just re-bases', () => {
    const next = flattenPack(SAMPLE_PACK_V1_1).find((a) => a.key === 'job' && a.kind === 'term')!.content;
    const mine = clone(base); mine['term:job'].live = clone(next);
    const plan = planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0');
    expect(plan.conflicts).toEqual([]);
    expect(plan.ops.find((o) => o.id === 'term:job')!.op).toBe('rebase');
  });

  it('take_pack resolution and planReset deliberately overwrite one artifact only', () => {
    const mine = customize(customize(base, 'term:job', { singular: 'Ticket' }), 'term:technician', { singular: 'Tech' });
    const up = planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0', { 'term:job': 'take_pack' });
    const after = run(mine, up, SAMPLE_PACK_V1_1).state;
    expect(after['term:job'].live).toMatchObject({ singular: 'Repair visit' });
    expect(after['term:technician'].live).toMatchObject({ singular: 'Tech' });
    const reset = planReset(SAMPLE_PACK_V1_1, after, ['term:technician']);
    const done = run(after, reset, SAMPLE_PACK_V1_1).state;
    expect(done['term:technician'].live).toMatchObject({ singular: 'Appliance tech' });
    expect(customizedIds(done)).toEqual([]);
  });

  it('upgrading to the installed version is a no-op', () => {
    expect(planUpgrade(SAMPLE_PACK_V1, base, '1.0.0').ops).toEqual([]);
  });
});

describe('guards (client mirror of the SQL optimistic checks)', () => {
  const base = run({}, planInstall(SAMPLE_PACK_V1), SAMPLE_PACK_V1).state;

  it('refuses a stale plan and applies nothing', () => {
    const plan = planUpgrade(SAMPLE_PACK_V1_1, base, '1.0.0');
    const changed = customize(base, 'term:job', { singular: 'Changed meanwhile' });
    expect(() => applyOps(changed, plan.ops, manifestOf(SAMPLE_PACK_V1_1))).toThrow(GuardError);
    expect(changed['term:job'].live).toMatchObject({ singular: 'Changed meanwhile' });
  });

  it('refuses ops whose new base is not the target version content', () => {
    const plan = planUpgrade(SAMPLE_PACK_V1_1, base, '1.0.0');
    const forged: Op[] = plan.ops.map((o) => (o.id === 'term:job' ? { ...o, baseAfter: { key: 'job', singular: 'EVIL', plural: 'EVIL' }, liveAfter: { key: 'job', singular: 'EVIL', plural: 'EVIL' } } : o));
    expect(() => applyOps(base, forged, manifestOf(SAMPLE_PACK_V1_1))).toThrow(/target version/);
  });

  it('refuses live content that is neither unchanged nor the pack content', () => {
    const plan = planUpgrade(SAMPLE_PACK_V1_1, base, '1.0.0');
    const forged = plan.ops.map((o) => (o.id === 'term:job' ? { ...o, liveAfter: { key: 'job', singular: 'Sneaky', plural: 'Sneaky' } } : o));
    expect(() => applyOps(base, forged, manifestOf(SAMPLE_PACK_V1_1))).toThrow(/may only stay/);
  });

  it('refuses duplicate ops, double create and missing rows', () => {
    const plan = planInstall(SAMPLE_PACK_V1);
    expect(() => applyOps({}, [plan.ops[0], plan.ops[0]], manifestOf(SAMPLE_PACK_V1))).toThrow(/twice/);
    expect(() => applyOps(base, [plan.ops[0]], manifestOf(SAMPLE_PACK_V1))).toThrow(/already exists/);
    const upd = planUpgrade(SAMPLE_PACK_V1_1, base, '1.0.0').ops.find((o) => o.op === 'update')!;
    expect(() => applyOps({}, [upd], manifestOf(SAMPLE_PACK_V1_1))).toThrow(/does not exist/);
  });
});

describe('rollback', () => {
  const installed = run({}, planInstall(SAMPLE_PACK_V1), SAMPLE_PACK_V1);

  it('restores the earlier version for untouched artifacts', () => {
    const up = run(installed.state, planUpgrade(SAMPLE_PACK_V1_1, installed.state, '1.0.0'), SAMPLE_PACK_V1_1);
    const rb = planRollback('appliance_repair', up.event, up.state);
    const { state } = run(up.state, rb, SAMPLE_PACK_V1);
    expect(state).toEqual(installed.state);
    expect(rb.toVersion).toBe('1.0.0');
  });

  it('keeps customizations made after the upgrade, and re-bases them to the earlier version', () => {
    const up = run(installed.state, planUpgrade(SAMPLE_PACK_V1_1, installed.state, '1.0.0'), SAMPLE_PACK_V1_1);
    const mine = customize(up.state, 'term:job', { singular: 'My word' });
    const { state } = run(mine, planRollback('appliance_repair', up.event, mine), SAMPLE_PACK_V1);
    expect(state['term:job'].live).toMatchObject({ singular: 'My word' });
    expect(state['status:quote_sent']).toBeUndefined();
    invariant(state, SAMPLE_PACK_V1);
  });

  it('brings back what the upgrade removed and re-attaches what it detached', () => {
    const mine = customize(installed.state, 'recurring_rule:annual_checkup', { intervalCount: 3 });
    const up = run(mine, planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0'), SAMPLE_PACK_V1_1);
    expect(up.state['recurring_rule:annual_checkup'].base).toBeNull();
    const { state } = run(up.state, planRollback('appliance_repair', up.event, up.state), SAMPLE_PACK_V1);
    expect(state['recurring_rule:annual_checkup'].live).toMatchObject({ intervalCount: 3 });
    expect(isCustomized(state['recurring_rule:annual_checkup'])).toBe(true);
    invariant(state, SAMPLE_PACK_V1);

    const dropped = run(installed.state, planUpgrade(SAMPLE_PACK_V1_1, installed.state, '1.0.0'), SAMPLE_PACK_V1_1);
    expect(dropped.state['recurring_rule:annual_checkup']).toBeUndefined();
    const back = run(dropped.state, planRollback('appliance_repair', dropped.event, dropped.state), SAMPLE_PACK_V1).state;
    expect(back['recurring_rule:annual_checkup']).toBeDefined();
  });

  it('rolling back an install uninstalls: removes untouched, keeps customized as account-owned, reinstall re-adopts', () => {
    const mine = customize(installed.state, 'status:repaired', { label: 'Fixed!' });
    const rb = planRollback('appliance_repair', installed.event, mine);
    const { state } = run(mine, rb, undefined);
    expect(Object.keys(state)).toEqual(['status:repaired']);
    expect(state['status:repaired'].base).toBeNull();
    expect(state['status:repaired'].live).toMatchObject({ label: 'Fixed!' });
    const re = run(state, planInstall(SAMPLE_PACK_V1, state), SAMPLE_PACK_V1).state;
    expect(re['status:repaired'].live).toMatchObject({ label: 'Fixed!' });
    expect(isCustomized(re['status:repaired'])).toBe(true);
    invariant(re, SAMPLE_PACK_V1);
  });

  it('rollback itself is guarded against concurrent edits', () => {
    const up = run(installed.state, planUpgrade(SAMPLE_PACK_V1_1, installed.state, '1.0.0'), SAMPLE_PACK_V1_1);
    const rb = planRollback('appliance_repair', up.event, up.state);
    const changed = customize(up.state, 'term:job', { singular: 'late edit' });
    expect(() => applyOps(changed, rb.ops, manifestOf(SAMPLE_PACK_V1))).toThrow(GuardError);
  });
});

describe('invariant under random customize / upgrade / rollback sequences', () => {
  it('base always equals the installed version content (or null)', () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let round = 0; round < 40; round++) {
      let state: AccountState = {};
      let version: PackManifest | undefined;
      const stack: Array<{ event: InstallEvent; from: PackManifest | undefined }> = [];
      for (let step = 0; step < 25; step++) {
        const ids = Object.keys(state);
        const r = rnd(4);
        if (r === 0 && ids.length) {
          state = customize(state, ids[rnd(ids.length)], { label: `c${step}` });
        } else if (!version) {
          const out = run(state, planInstall(SAMPLE_PACK_V1, state), SAMPLE_PACK_V1);
          stack.push({ event: out.event, from: undefined }); state = out.state; version = SAMPLE_PACK_V1;
        } else if (version.version === '1.0.0' && r === 1) {
          const out = run(state, planUpgrade(SAMPLE_PACK_V1_1, state, '1.0.0'), SAMPLE_PACK_V1_1);
          stack.push({ event: out.event, from: version }); state = out.state; version = SAMPLE_PACK_V1_1;
        } else if (stack.length && r >= 2) {
          const top = stack.pop()!;
          state = run(state, planRollback('appliance_repair', top.event, state), top.from).state; version = top.from;
        }
        invariant(state, version);
      }
    }
  });
});

describe('helpers', () => {
  it('jsonEqual ignores key order but not values', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
  it('compares semver numerically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
  it('builds entitlement keys and finds versions', () => {
    expect(packEntitlementKey('hvac')).toBe('packs:hvac');
    expect(getPackVersion('appliance_repair', '1.1.0')).toBeDefined();
    expect(getPackVersion('nope', '1.0.0')).toBeUndefined();
  });
  it('previews every op with a plain-language note', () => {
    const base = run({}, planInstall(SAMPLE_PACK_V1), SAMPLE_PACK_V1).state;
    const mine = customize(base, 'term:job', { singular: 'T' });
    const lines = previewDiff(planUpgrade(SAMPLE_PACK_V1_1, mine, '1.0.0'));
    expect(lines.find((l) => l.id === 'term:job')!.action).toBe('keep_yours');
    expect(lines.find((l) => l.id === 'status:quote_sent')!.action).toBe('add');
    expect(lines.every((l) => l.note.length > 0)).toBe(true);
  });
});
