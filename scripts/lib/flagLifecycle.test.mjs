import { describe, it, expect } from 'vitest';
import { checkRegistry, usedKeys, crossCheck } from './flagLifecycle.mjs';

const base = { key: 'new_thing', kind: 'release', owner: 'team-a', created: '2026-11-01', expires: '2027-01-15', cleanup: 'delete NewThing component' };
const run = (f, today = '2026-11-03') => checkRegistry({ flags: [f] }, today);

describe('checkRegistry', () => {
  it('accepts a healthy flag', () => expect(run(base).errors).toEqual([]));
  it('fails an expired flag as stale', () => expect(run(base, '2027-01-16').errors.join()).toContain('STALE'));
  it('warns shortly before expiry', () => expect(run(base, '2027-01-10').warnings).toHaveLength(1));
  it('requires owner, cleanup and expiry for release flags', () => {
    expect(run({ ...base, owner: '' }).errors.join()).toContain('owner');
    expect(run({ ...base, cleanup: '' }).errors.join()).toContain('cleanup');
    expect(run({ ...base, expires: undefined }).errors.join()).toContain('expiry');
  });
  it('allows ops flags without expiry but caps temporary lifetime', () => {
    expect(run({ ...base, kind: 'ops', expires: undefined }).errors).toEqual([]);
    expect(run({ ...base, expires: '2027-12-01' }).errors.join()).toContain('180');
  });
  it('rejects duplicate and invalid keys', () => {
    expect(checkRegistry({ flags: [base, base] }, '2026-11-03').errors.join()).toContain('duplicate');
    expect(run({ ...base, key: 'Bad-Key' }).errors.join()).toContain('invalid key');
  });
});

describe('usage scan', () => {
  it('finds literal keys and flags unregistered ones', () => {
    const used = usedKeys([{ path: 'a.tsx', text: "const on = isEnabled('new_thing'); useFeatureFlag(\"rogue_flag\")" }]);
    expect([...used.keys()]).toEqual(['new_thing', 'rogue_flag']);
    expect(crossCheck({ flags: [base] }, used).errors.join()).toContain('rogue_flag');
  });
});

describe('usage scan precision', () => {
  it('ignores unrelated p_key RPC arguments and reads flag_evaluate calls', () => {
    const text = "admin.rpc('bi_has_permission', { p_user: u, p_key: 'can_export_pii' }); admin.rpc('flag_evaluate', { p_key: 'real_flag', p_tenant: t })";
    expect([...usedKeys([{ path: 'b.ts', text }]).keys()]).toEqual(['real_flag']);
  });
});
