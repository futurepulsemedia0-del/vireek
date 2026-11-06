import { describe, expect, it } from 'vitest';
import { bucketFromId, canApplyOta, compareVersions, isInRollout } from './releaseStaging';

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('staged rollout bucketing', () => {
  it('is stable and within 0-99', () => {
    const b = bucketFromId('install-123');
    expect(b).toBe(bucketFromId('install-123'));
    expect(b >= 0 && b <= 99).toBe(true);
  });
  it('distributes roughly evenly', () => {
    let inside = 0;
    for (let i = 0; i < 4000; i += 1) if (isInRollout(bucketFromId(`id-${i}`), 25)) inside += 1;
    expect(inside > 800 && inside < 1200).toBe(true);
  });
  it('only ever adds installs as the percentage grows', () => {
    for (let i = 0; i < 500; i += 1) {
      const b = bucketFromId(`id-${i}`);
      if (isInRollout(b, 10)) expect(isInRollout(b, 50)).toBe(true);
    }
  });
  it('treats missing or full percentages as everyone, 0 as nobody', () => {
    expect(isInRollout(99, undefined)).toBe(true);
    expect(isInRollout(99, 100)).toBe(true);
    expect(isInRollout(0, 0)).toBe(false);
    expect(isInRollout(null, 50)).toBe(false);
  });
});

describe('canApplyOta', () => {
  const bundle = { minNativeVersion: '1.4.0' };
  it('allows a compatible bundle', () => expect(canApplyOta('1.4.2', bundle).ok).toBe(true));
  it('blocks a bundle that needs a newer native binary', () => {
    const r = canApplyOta('1.3.9', bundle);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/native >= 1.4.0/);
  });
  it('respects a max native version and the policy floor', () => {
    expect(canApplyOta('2.0.0', { minNativeVersion: '1.0.0', maxNativeVersion: '1.9.9' }).ok).toBe(false);
    expect(canApplyOta('1.4.0', bundle, '1.5.0').ok).toBe(false);
    expect(canApplyOta('1.5.0', bundle, '1.5.0').ok).toBe(true);
  });
});
