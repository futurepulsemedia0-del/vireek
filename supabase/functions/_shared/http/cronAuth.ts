// supabase/functions/_shared/http/cronAuth.ts
// Fail-CLOSED authentication for cron / internal service entry points.
// Replaces the fail-open pattern:  if (cronSecret && header !== cronSecret) { 401 }
// (which lets EVERY request through when CRON_SECRET is unset).
import { checkSharedSecret } from "./core.ts";

export interface CronAuthOptions {
  /** Env var holding the secret. Default: CRON_SECRET */
  envName?: string;
  /** Headers checked in order. Default: x-cron-secret */
  headers?: readonly string[];
  /** Also accept `Authorization: Bearer <secret>`. Default: false */
  allowBearer?: boolean;
  /** Optional extra secret env names (e.g. rotation: CRON_SECRET_NEXT). */
  extraEnvNames?: readonly string[];
}

export type CronAuthResult = { ok: true } | { ok: false; response: Response };

function deny(status: number, error: string): CronAuthResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

/**
 * Returns ok:true ONLY when a secret is configured AND the request presents it.
 * Unset/empty secret => 503 (misconfigured, never "allow").
 */
export function requireCronAuth(req: Request, opts: CronAuthOptions = {}): CronAuthResult {
  const names = [opts.envName ?? "CRON_SECRET", ...(opts.extraEnvNames ?? [])];
  const secrets = names.map((n) => Deno.env.get(n)).filter((s): s is string => !!s && s.length > 0);
  if (secrets.length === 0) {
    console.error(JSON.stringify({ event: "cron_auth_misconfigured", env: names }));
    return deny(503, "Service not configured.");
  }
  const headers = opts.headers ?? ["x-cron-secret"];
  const presented: string[] = headers.map((h) => req.headers.get(h) ?? "").filter(Boolean);
  if (opts.allowBearer) {
    const a = req.headers.get("authorization") ?? "";
    if (a.toLowerCase().startsWith("bearer ")) presented.push(a.slice(7).trim());
  }
  for (const p of presented) {
    for (const s of secrets) if (checkSharedSecret(s, p)) return { ok: true };
  }
  return deny(401, "Unauthorized");
}
