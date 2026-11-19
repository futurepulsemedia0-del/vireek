import { describe, it, expect } from 'vitest';
import { anthropicUsage, geminiUsage, openAiUsage } from './usage.ts';

describe('anthropicUsage', () => {
  it('keeps fresh input separate from cache read / write', () => {
    expect(anthropicUsage({ usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }))
      .toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });
  it('is unchanged shape when no cache fields are present', () => {
    expect(anthropicUsage({ usage: { input_tokens: 20, output_tokens: 5 } })).toEqual({ inputTokens: 20, outputTokens: 5 });
  });
  it('handles a fully cached prompt (input_tokens 0)', () => {
    expect(anthropicUsage({ usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 900 } })).toEqual({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });
  it('returns undefined for missing or zero usage', () => {
    expect(anthropicUsage({})).toBeUndefined();
    expect(anthropicUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeUndefined();
  });
});

describe('geminiUsage', () => {
  it('subtracts implicitly cached tokens from the fresh input and bills thoughts as output', () => {
    expect(geminiUsage({ usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 10 } }))
      .toEqual({ inputTokens: 200, outputTokens: 60, cacheReadTokens: 800 });
  });
  it('never reports more cached than prompt tokens', () => {
    expect(geminiUsage({ usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 500, candidatesTokenCount: 5 } }))
      .toEqual({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 100 });
  });
  it('plain usage without caching is unchanged', () => {
    expect(geminiUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })).toEqual({ inputTokens: 100, outputTokens: 5 });
  });
});

describe('openAiUsage', () => {
  it('reads prompt / completion tokens', () => {
    expect(openAiUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } })).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
