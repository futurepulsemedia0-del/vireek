// _shared/http/cronGuard.ts — throwing wrapper over requireCronAuth for legacy `Deno.serve` cron/service entry points.
// Kept apart from publicGuard.ts on purpose: public endpoints must not appear to "have cron auth" to the security matrix.
import { HttpError } from "./core.ts";
import { requireCronAuth, type CronAuthOptions } from "./cronAuth.ts";

/** Fail-closed cron/service auth as a throwing assertion (401 wrong/missing secret, 500 when no secret is configured). */
export function assertCronAuth(req: Request, opts: CronAuthOptions = {}): void {
  const r = requireCronAuth(req, opts);
  if (r.ok) return;
  throw new HttpError(r.response.status === 401 ? "unauthorized" : "internal", r.response.status === 401 ? "Unauthorized." : "Internal error.");
}
