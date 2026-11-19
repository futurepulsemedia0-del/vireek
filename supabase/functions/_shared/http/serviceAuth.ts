// supabase/functions/_shared/http/serviceAuth.ts
// In-function auth for SCHEDULED / service-to-service edge functions that are deployed with verify_jwt = true.
// Accepted credentials (either one):
//   • `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
//   • `X-Cron-Secret: <CRON_SECRET>` — when CRON_SECRET is configured
// Fail closed: no service key configured => 500 + log; anything else (anon key, user JWT, nothing) => 401.
import { requireCronAuth, type CronAuthResult } from "./cronAuth.ts";

export interface ServiceCallerOptions {
  fn?: string;
  responseHeaders?: Readonly<Record<string, string>>;
}

export function requireServiceCaller(req: Request, opts: ServiceCallerOptions = {}): CronAuthResult {
  const common = { fn: opts.fn, responseHeaders: opts.responseHeaders } as const;
  const byServiceKey = requireCronAuth(req, { ...common, envName: "SUPABASE_SERVICE_ROLE_KEY", headers: [], allowBearer: true });
  if (byServiceKey.ok) return byServiceKey;
  if (byServiceKey.response.status !== 401) return byServiceKey; // misconfigured: never fall through to "allow"
  if (Deno.env.get("CRON_SECRET")) {
    const byCronSecret = requireCronAuth(req, { ...common, envName: "CRON_SECRET" });
    if (byCronSecret.ok) return byCronSecret;
  }
  return byServiceKey;
}
