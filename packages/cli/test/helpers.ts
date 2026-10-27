import type { Io } from '../src/cli.js';

export const KEY = `vrk_live_${'a1b2c3d4'.repeat(6)}`;
export const BASE = 'https://proj.supabase.co/functions/v1/api-v1';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** n rows, newest first, one minute apart, starting at `start`. */
export function makeRows(n: number, start = '2026-10-20T12:00:00.000Z', offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${offset + i}`,
    created_at: new Date(Date.parse(start) - (offset + i) * 60_000).toISOString(),
    name: `Row ${offset + i}`,
  }));
}

export interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

export function makeIo(overrides: Partial<Io> = {}, input = ''): Captured {
  let out = '';
  let err = '';
  async function* stdin() {
    if (input) yield Buffer.from(input);
  }
  const io: Io = {
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: (chunk: string) => ((err += chunk), true) },
    stdin: stdin(),
    env: {},
    fetchImpl: (async () => {
      throw new Error('unexpected network call');
    }) as typeof fetch,
    configFile: '/nonexistent/vireek/config.json',
    sleep: async () => undefined,
    ...overrides,
  };
  return { io, stdout: () => out, stderr: () => err };
}
