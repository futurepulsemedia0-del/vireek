import { describe, it, expect } from 'vitest';
import { createAnthropicBatchClient } from './batchClient.ts';
import { customIdForJob } from './batch.ts';

const id = '123e4567-e89b-12d3-a456-426614174000';
const row = { id, request: { system: 'S', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100 } };
const res = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('createAnthropicBatchClient', () => {
  it('submits one POST with the key header and returns the batch id', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const c = createAnthropicBatchClient('k', async (url, init) => { calls.push({ url, init }); return res({ id: 'msgbatch_1' }); });
    expect(await c.submit([row], 'claude-sonnet-5')).toEqual({ batchId: 'msgbatch_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v1/messages/batches');
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(String(calls[0].init?.body)).requests[0].custom_id).toBe(customIdForJob(id));
  });
  it('throws on a non-2xx submit and on a missing id', async () => {
    await expect(createAnthropicBatchClient('k', async () => res({}, 500)).submit([row], 'm')).rejects.toThrow('submit 500');
    await expect(createAnthropicBatchClient('k', async () => res({})).submit([row], 'm')).rejects.toThrow('no batch id');
  });
  it('returns null while in progress and parsed outcomes once ended', async () => {
    const line = JSON.stringify({ custom_id: customIdForJob(id), result: { type: 'succeeded', message: { model: 'm', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } } });
    const pending = createAnthropicBatchClient('k', async () => res({ processing_status: 'in_progress' }));
    expect(await pending.collect('b')).toBeNull();
    const ended = createAnthropicBatchClient('k', async (url) => (url.includes('results') ? res(line) : res({ processing_status: 'ended', results_url: 'https://x/results' })));
    const out = await ended.collect('b');
    expect(out?.[0]).toEqual({ jobId: id, ok: true, text: 'done', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });
});
