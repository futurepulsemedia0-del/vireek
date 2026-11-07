// supabase/functions/_shared/sarah-learn/edge.ts
//
// Shared edge-function plumbing for the sarah-learn-* functions (Deno runtime).
// Verifies the caller's JWT + permission + tenant, and hands back a
// service-role client for the narrow writes the browser must never do itself.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export interface Caller {
  userId: string;
  ownerId: string;
  /** Runs as the user, under RLS. */
  userDb: SupabaseClient;
  /** Service role. Every query MUST filter by ownerId. */
  admin: SupabaseClient;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function authenticate(req: Request): Promise<Caller> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new HttpError(401, 'Missing Authorization header.');
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const userDb = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
  } = await userDb.auth.getUser();
  if (!user) throw new HttpError(401, 'Not authenticated.');

  const { data: allowed, error: permErr } = await userDb.rpc('can_run_sarah_learn');
  if (permErr) throw permErr;
  if (allowed !== true) throw new HttpError(403, "You don't have permission to set up the business profile.");

  const { data: ownerId, error: ownerErr } = await userDb.rpc('get_account_owner_id');
  if (ownerErr || typeof ownerId !== 'string') throw new HttpError(403, 'Could not resolve your account.');

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  return { userId: user.id, ownerId, userDb, admin };
}

export function handle(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      // Never log request bodies (may contain business content); message only.
      console.error('[sarah-learn] unexpected error:', err instanceof Error ? err.message : 'unknown');
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Loads a run the caller owns, or throws 404. */
export async function loadRun(c: Caller, runId: unknown): Promise<Record<string, unknown>> {
  if (typeof runId !== 'string' || !UUID_RE.test(runId)) throw new HttpError(400, 'Invalid run.');
  const { data, error } = await c.admin.from('sarah_learn_runs').select('*').eq('id', runId).eq('user_id', c.ownerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Run not found.');
  return data as Record<string, unknown>;
}
