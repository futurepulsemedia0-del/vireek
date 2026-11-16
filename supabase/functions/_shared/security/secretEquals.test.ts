import { describe, expect, it } from 'vitest';
import { secretEquals } from './secretEquals';

describe('secretEquals', () => {
  it('matches equal secrets', async () => {
    expect(await secretEquals('s3cret-value', 's3cret-value')).toBe(true);
  });
  it('rejects different, prefix and longer secrets', async () => {
    expect(await secretEquals('s3cret-valuf', 's3cret-value')).toBe(false);
    expect(await secretEquals('s3cret', 's3cret-value')).toBe(false);
    expect(await secretEquals('s3cret-value-x', 's3cret-value')).toBe(false);
  });
  it('fails closed on missing or empty values', async () => {
    expect(await secretEquals(null, 'x')).toBe(false);
    expect(await secretEquals('x', undefined)).toBe(false);
    expect(await secretEquals('', '')).toBe(false);
  });
});
