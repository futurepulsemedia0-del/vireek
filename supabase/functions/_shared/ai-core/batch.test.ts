import { describe, it, expect } from 'vitest';
import {
  BATCH_ELIGIBLE_TASKS, buildAnthropicBatchBody, customIdForJob, jobIdFromCustomId,
  parseAnthropicBatchResults, shouldRetry, validateBatchRequest, MAX_BATCH_REQUESTS,
} from './batch.ts';

const id = '123e4567-e89b-12d3-a456-426614174000';
const req = { system: 'S', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 300, jsonMode: true };

describe('custom ids', () => {
  it('round-trips and satisfies the provider charset', () => {
    const c = customIdForJob(id);
    expect(c).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(jobIdFromCustomId(c)).toBe(id);
  });
  it('rejects foreign ids', () => {
    expect(jobIdFromCustomId('abc')).toBeNull();
    expect(jobIdFromCustomId('jZZZ')).toBeNull();
  });
});

describe('validateBatchRequest', () => {
  it('accepts only batch-eligible tasks (never live / emergency / dispatch)', () => {
    expect(validateBatchRequest('job_autopsy', req)).toEqual({ ok: true });
    for (const t of ['remote_resolution', 'dispatch_copilot', 'demo_chat', 'inbound_auto_reply', 'ask_vireek'] as const) {
      expect(BATCH_ELIGIBLE_TASKS.has(t)).toBe(false);
      expect(validateBatchRequest(t, req)).toEqual({ ok: false, reason: 'task_not_batch_eligible' });
    }
  });
  it('rejects empty, oversize and bad max_tokens', () => {
    expect(validateBatchRequest('job_autopsy', { ...req, messages: [] })).toEqual({ ok: false, reason: 'no_messages' });
    expect(validateBatchRequest('job_autopsy', { ...req, maxTokens: 0 })).toEqual({ ok: false, reason: 'bad_max_tokens' });
    expect(validateBatchRequest('job_autopsy', { ...req, system: 'x'.repeat(300_000) })).toEqual({ ok: false, reason: 'request_too_large' });
  });
});

describe('buildAnthropicBatchBody', () => {
  it('builds one request per job with the JSON rule appended and temperature defaulting to 0', () => {
    const body = buildAnthropicBatchBody([{ id, request: req }], 'claude-sonnet-5');
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].custom_id).toBe(customIdForJob(id));
    expect(body.requests[0].params.temperature).toBe(0);
    expect(body.requests[0].params.system.startsWith('S\n\nRespond with ONLY a single valid JSON object')).toBe(true);
  });
  it('refuses empty and oversize batches', () => {
    expect(() => buildAnthropicBatchBody([], 'm')).toThrow();
    expect(() => buildAnthropicBatchBody(Array.from({ length: MAX_BATCH_REQUESTS + 1 }, () => ({ id, request: req })), 'm')).toThrow();
  });
});

describe('parseAnthropicBatchResults', () => {
  const cid = customIdForJob(id);
  const ok = { custom_id: cid, result: { type: 'succeeded', message: { model: 'm', content: [{ type: 'text', text: ' ok ' }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 } } } };
  it('parses success with usage and cache counts', () => {
    const [r] = parseAnthropicBatchResults(JSON.stringify(ok));
    expect(r).toEqual({ jobId: id, ok: true, text: 'ok', model: 'm', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 0 } });
  });
  it('maps errored / expired / canceled and skips malformed lines', () => {
    const jsonl = [
      JSON.stringify({ custom_id: cid, result: { type: 'expired' } }),
      '{broken',
      JSON.stringify({ custom_id: 'nope', result: { type: 'succeeded' } }),
      JSON.stringify({ custom_id: cid, result: { type: 'errored' } }),
      JSON.stringify({ custom_id: cid, result: { type: 'canceled' } }),
      JSON.stringify({ custom_id: cid, result: { type: 'succeeded', message: { content: [] } } }),
      JSON.stringify({ custom_id: cid, result: { type: 'weird' } }),
    ].join('\n');
    expect(parseAnthropicBatchResults(jsonl).map((r) => (r.ok ? 'ok' : r.errorCode))).toEqual(['expired', 'errored', 'canceled', 'empty', 'unknown']);
  });
});

describe('shouldRetry', () => {
  it('retries transient failures up to the attempt cap only', () => {
    expect(shouldRetry('errored', 1)).toBe(true);
    expect(shouldRetry('expired', 2)).toBe(true);
    expect(shouldRetry('errored', 3)).toBe(false);
    expect(shouldRetry('canceled', 1)).toBe(false);
    expect(shouldRetry('empty', 1)).toBe(false);
  });
});
