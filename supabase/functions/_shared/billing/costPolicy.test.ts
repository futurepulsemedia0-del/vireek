import { describe, it, expect } from 'vitest';
import { isOptionalAiTask, OPTIONAL_AI_TASKS } from './costPolicy';
import { openAiUsage, anthropicUsage, geminiUsage } from '../ai-core/providers/usage';
import { estimateTokensFromChars, extractGeminiUsage } from './usageEvents';

describe('isOptionalAiTask (fail-safe: only listed tasks may be paused)', () => {
  it('pauses analytics tasks', () => {
    expect(isOptionalAiTask('business_insights')).toBe(true);
    expect(isOptionalAiTask('cash_flow_narrative')).toBe(true);
  });
  it('never pauses live-call, emergency, dispatch or customer-facing tasks', () => {
    for (const t of ['remote_resolution', 'intent_classify', 'dispatch_copilot', 'inbound_auto_reply', 'call_intelligence', 'ask_vireek', 'review_reply', 'promise_extraction']) {
      expect(isOptionalAiTask(t)).toBe(false);
    }
  });
  it('unknown / missing tasks are protected', () => {
    expect(isOptionalAiTask('brand_new_task')).toBe(false);
    expect(isOptionalAiTask(undefined)).toBe(false);
    expect(isOptionalAiTask(null)).toBe(false);
  });
  it('the optional list never contains an emergency-ish task', () => {
    for (const t of OPTIONAL_AI_TASKS) expect(/emergenc|remote_resolution|dispatch|intent|inbound|call_intelligence/.test(t)).toBe(false);
  });
});

describe('provider usage extractors', () => {
  it('openai-compatible', () => {
    expect(openAiUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(openAiUsage({})).toBeUndefined();
    expect(openAiUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBeUndefined();
    expect(openAiUsage({ usage: { prompt_tokens: -1, completion_tokens: 5 } })).toBeUndefined();
  });
  it('anthropic', () => {
    expect(anthropicUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(anthropicUsage(null)).toBeUndefined();
  });
  it('gemini counts thinking tokens as output', () => {
    expect(geminiUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 } })).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(geminiUsage({ usageMetadata: {} })).toBeUndefined();
    expect(extractGeminiUsage('x')).toBeNull();
    expect(extractGeminiUsage({ promptTokenCount: 4, candidatesTokenCount: 1 })).toEqual({ inputTokens: 4, outputTokens: 1 });
  });
  it('char-based token estimate', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(401)).toBe(101);
  });
});
