// Loads a Deno edge function's real `index.ts` under vitest without changing it:
//   - `Deno.serve` is captured so the handler can be called with a plain Request
//   - `Deno.env.get` reads from a mutable object (tests flip secrets per case)
//   - the `npm:@supabase/supabase-js` import is mocked by each test file (see usage in *.test.ts)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';

export type Handler = (req: Request) => Promise<Response> | Response;

export async function loadHandler(importIndex: () => Promise<unknown>, env: Record<string, string | undefined>): Promise<Handler> {
  let captured: Handler | undefined;
  (globalThis as any).Deno = {
    env: { get: (k: string) => env[k] },
    serve: (h: Handler) => { captured = h; return { finished: Promise.resolve() }; },
  };
  vi.resetModules();
  await importIndex();
  if (!captured) throw new Error('index.ts did not call Deno.serve');
  return captured;
}

export const post = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://edge.test/fn', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

export const get = (headers: Record<string, string> = {}) => new Request('http://edge.test/fn', { method: 'GET', headers });
export const options = () => new Request('http://edge.test/fn', { method: 'OPTIONS' });

export async function jsonOf(res: Response): Promise<any> { return JSON.parse(await res.text()); }

/** Silences the structured console.error the functions emit on failure paths, and lets tests assert on it. */
export function captureErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { spy, lines: () => spy.mock.calls.map((c) => String(c[0])) };
}
