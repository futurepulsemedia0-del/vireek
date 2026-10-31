// Pure request handler for the warranty-claim detector. No Deno / npm imports so vitest can run it.
// NOTHING is ever sent to a manufacturer from here: it only asks the database to create
// `needs_review` claims and to expire stale ones.

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface DetectDeps {
  secret: string; // expected shared secret (from env). Empty => always 401 (fail closed).
  admin: RpcClient;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-warranty-secret, apikey, x-client-info',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export async function handleDetect(req: Request, deps: DetectDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const provided = req.headers.get('x-warranty-secret') ?? '';
  if (!deps.secret || !safeEqual(provided, deps.secret)) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  let owner: string | null = null;
  if (body.owner_id !== undefined && body.owner_id !== null) {
    if (typeof body.owner_id !== 'string' || !UUID_RE.test(body.owner_id)) return json({ error: 'Invalid owner_id' }, 400);
    owner = body.owner_id;
  }

  const { data, error } = await deps.admin.rpc('warranty_recovery_detect', {
    p_owner: owner,
    p_lookback_days: clampInt(body.lookback_days, 1, 730, 180),
    p_limit: clampInt(body.limit, 1, 2000, 500),
  });
  if (error) {
    deps.log?.('warranty detection failed', { message: error.message });
    return json({ error: 'Detection failed' }, 500); // never echo DB error text to the caller
  }
  return json({ ok: true, result: data });
}
