import { describe, it, expect } from 'vitest';
import { buildAnthropicSystem, minCacheableTokens } from './promptCache.ts';

const long = 'A'.repeat(5000); // ~1250 tokens
const dyn = ' dynamic question context';

describe('buildAnthropicSystem', () => {
  it('returns the exact legacy string when the flag is off', () => {
    expect(buildAnthropicSystem({ system: long + dyn, stablePrefixChars: 5000, enabled: false, model: 'claude-sonnet-5' })).toBe(long + dyn);
  });
  it('legacy string keeps the JSON rule appended exactly as before', () => {
    expect(buildAnthropicSystem({ system: 'S', suffix: 'JSON!', enabled: false, model: 'claude-sonnet-5' })).toBe('S\n\nJSON!');
  });
  it('splits into a cached prefix block and an uncached tail when long enough', () => {
    const out = buildAnthropicSystem({ system: long + dyn, stablePrefixChars: 5000, suffix: 'JSON!', enabled: true, model: 'claude-sonnet-5' });
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as { text: string; cache_control?: unknown }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(long);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toBe(dyn + '\n\nJSON!');
    expect(blocks.map((b) => b.text).join('')).toBe(long + dyn + '\n\nJSON!');
  });
  it('does not mark a prefix below the model minimum', () => {
    expect(typeof buildAnthropicSystem({ system: 'short' + dyn, stablePrefixChars: 5, enabled: true, model: 'claude-sonnet-5' })).toBe('string');
  });
  it('uses a higher minimum for Haiku', () => {
    expect(minCacheableTokens('claude-haiku-4-5-20251001')).toBeGreaterThan(minCacheableTokens('claude-sonnet-5'));
    expect(typeof buildAnthropicSystem({ system: long + dyn, stablePrefixChars: 5000, enabled: true, model: 'claude-haiku-4-5-20251001' })).toBe('string');
  });
  it('ignores an invalid prefix hint', () => {
    for (const n of [undefined, 0, -3, 1.5, 10_000_000]) {
      expect(typeof buildAnthropicSystem({ system: long, stablePrefixChars: n as number, enabled: true, model: 'claude-sonnet-5' })).toBe('string');
    }
  });
  it('omits the tail block when the prefix is the whole prompt and there is no suffix', () => {
    const out = buildAnthropicSystem({ system: long, stablePrefixChars: 5000, enabled: true, model: 'claude-sonnet-5' }) as unknown[];
    expect(out).toHaveLength(1);
  });
});
