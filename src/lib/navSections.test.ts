import { describe, expect, it } from 'vitest';
import { readNavSections, sectionOpen, writeNavSections } from '@/lib/navSections';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('navSections', () => {
  it('is scoped per user', () => {
    const kv = mem();
    writeNavSections('u1', { account: true }, kv);
    expect(readNavSections('u1', kv)).toEqual({ account: true });
    expect(readNavSections('u2', kv)).toEqual({});
  });
  it('ignores junk and non-boolean values', () => {
    const kv = { getItem: () => '{"account":"yes","appearance":false}', setItem: () => undefined };
    expect(readNavSections('u', kv)).toEqual({ appearance: false });
    expect(readNavSections('u', { getItem: () => 'nope', setItem: () => undefined })).toEqual({});
    expect(readNavSections(null, kv)).toEqual({});
  });
  it('stored choice beats the route default', () => {
    expect(sectionOpen({ account: false }, 'account', true)).toBe(false);
    expect(sectionOpen({}, 'account', true)).toBe(true);
  });
});
