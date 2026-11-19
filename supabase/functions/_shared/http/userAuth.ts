// supabase/functions/_shared/http/userAuth.ts
// In-function authentication for browser-called edge functions deployed with verify_jwt = true.
// The gateway accepts the public anon key, so verify_jwt alone proves nothing about WHO is calling.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

export interface UserAuthOptions {
  responseHeaders?: Readonly<Record<string, string>>;
  /** Reject Supabase anonymous-sign-in users. Default true. */
  rejectAnonymous?: boolean;
  fn?: string;
}

export type UserAuthResult =
  | { ok: true; userId: string; authHeader: string }
  | { ok: false; response: Response };

function deny(status: number, error: string, extra?: Readonly<Record<string, string>>): UserAuthResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { ...(extra ?? {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  };
}

export async function requireSignedInUser(req: Request, opts: UserAuthOptions = {}): Promise<UserAuthResult> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    console.error(JSON.stringify({ event: "user_auth_misconfigured", fn: opts.fn ?? null }));
    return deny(500, "Service not configured.", opts.responseHeaders);
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!m) return deny(401, "not_authenticated", opts.responseHeaders);
  const client = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${m[1]}` } }, auth: { persistSession: false } });
  let user: { id?: string; is_anonymous?: boolean } | null = null;
  try {
    const { data, error } = await client.auth.getUser(m[1]);
    user = error ? null : (data?.user ?? null);
  } catch {
    user = null;
  }
  if (!user?.id) return deny(401, "not_authenticated", opts.responseHeaders);
  if ((opts.rejectAnonymous ?? true) && user.is_anonymous === true) return deny(401, "not_authenticated", opts.responseHeaders);
  return { ok: true, userId: user.id, authHeader: `Bearer ${m[1]}` };
}
